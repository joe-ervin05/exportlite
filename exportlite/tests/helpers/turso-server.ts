import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate as tick } from "node:timers/promises";
import type Database from "better-sqlite3";

interface Value {
  type: string;
  value?: string | number;
  base64?: string;
}
interface Statement {
  sql: string;
  args: Value[];
  named_args: { name: string; value: Value }[];
}
export interface ServerMode {
  status?: number;
  hold?: "headers" | "body";
  truncate?: boolean;
  closeError?: boolean;
  fragment?: number;
  rowError?: number;
  legacyExpiry?: boolean;
  closeWait?: Promise<void>;
  terminator?: boolean;
}

/** Real HTTP, actual SQLite execution, and explicit v3 cursor/session framing. */
export async function tursoServer(db: Database.Database) {
  const requests: {
    path: string;
    body: Record<string, unknown>;
    authorization: string | undefined;
    encryption: string | string[] | undefined;
  }[] = [];
  const statements: string[] = [];
  const batches: number[] = [];
  const sessions = new Map<string, () => void>();
  const busy = new Set<string>();
  const mode: ServerMode = {};
  let produced = 0;
  let cursors = 0;
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) text += chunk.toString();
      const body = JSON.parse(text) as Record<string, unknown>;
      requests.push({
        path: req.url ?? "",
        body,
        authorization: req.headers.authorization,
        encryption: req.headers["x-turso-encryption-key"],
      });
      if (req.url === "/v3/pipeline") {
        await mode.closeWait;
        if (mode.closeError) {
          res.writeHead(500).end("close failed");
          return;
        }
        const close = sessions.get(String(body.baton));
        if (!close) {
          res
            .writeHead(mode.legacyExpiry ? 400 : 404)
            .end(JSON.stringify({ code: "STREAM_EXPIRED" }));
          return;
        }
        close?.();
        sessions.delete(String(body.baton));
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            baton: null,
            base_url: null,
            results: [{ type: "ok", response: { type: "close" } }],
          }),
        );
        return;
      }
      if (req.url !== "/v3/cursor") {
        res.writeHead(404).end();
        return;
      }
      cursors++;
      if (mode.status) {
        res.writeHead(mode.status).end("sensitive-token-in-error-body");
        return;
      }
      if (typeof body.baton === "string") {
        if (!sessions.has(body.baton)) {
          res
            .writeHead(mode.legacyExpiry ? 400 : 404)
            .end(JSON.stringify({ code: "STREAM_EXPIRED" }));
          return;
        }
        if (busy.has(body.baton)) {
          res.writeHead(409).end("Session is busy");
          return;
        }
        sessions.delete(body.baton);
      }
      if (mode.hold === "headers") {
        await once(res, "close");
        return;
      }
      const steps = (body.batch as { steps: { stmt: Statement }[] }).steps;
      if (steps.length !== 1)
        throw new Error("Exactly one export statement expected");
      const stmt = steps[0]?.stmt;
      if (!stmt) throw new Error("Missing statement");
      statements.push(stmt.sql);
      res.setHeader("Content-Type", "application/json");
      const baton = randomUUID();
      let stopped = false;
      let iterator: IterableIterator<unknown> | undefined;
      const close = () => {
        stopped = true;
        iterator?.return?.();
      };
      sessions.set(baton, close);
      busy.add(baton);
      res.on("close", close);
      const write = async (value: unknown) => {
        if (stopped) return;
        const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
        const size = mode.fragment ?? bytes.length;
        for (let start = 0; start < bytes.length && !stopped; start += size) {
          if (!res.write(bytes.subarray(start, start + size))) {
            await new Promise<void>((resolve) => {
              const done = () => {
                res.off("drain", done);
                res.off("close", done);
                resolve();
              };
              res.once("drain", done);
              res.once("close", done);
            });
          }
          await tick();
        }
      };
      try {
        await write({ baton, base_url: null });
        const native = db.prepare(stmt.sql);
        if (!native.reader || !native.readonly)
          throw new Error("Expected a single read-only statement");
        const cols = native
          .columns()
          .map((column) => ({ name: column.name, decltype: column.type }));
        await write({ type: "step_begin", step: 0, cols });
        if (mode.hold === "body") {
          await once(res, "close");
          return;
        }
        const args = stmt.named_args.length
          ? [
              Object.fromEntries(
                stmt.named_args.map(({ name, value }) => [name, decode(value)]),
              ),
            ]
          : stmt.args.map(decode);
        iterator = native.raw().iterate(...args);
        let emitted = 0;
        for (const raw of iterator) {
          if (stopped) break;
          const row = raw as unknown[];
          produced++;
          emitted++;
          if (
            row.length === 2 &&
            typeof row[0] === "string" &&
            typeof row[1] === "number"
          )
            batches.push(row[1]);
          await write({ type: "row", row: row.map(encode) });
          if (mode.rowError && emitted >= mode.rowError)
            throw new Error("Injected SQL error");
        }
        if (!mode.truncate && !stopped)
          await write({
            type: "step_end",
            affected_row_count: 0,
            last_insert_rowid: null,
          });
        if (!mode.truncate && !stopped && mode.terminator)
          await write({ type: "replication_index", replication_index: null });
      } catch {
        if (!stopped)
          await write({
            type: "step_error",
            step: 0,
            error: { message: "Fixture SQL failed", code: "SQLITE_ERROR" },
          });
      } finally {
        iterator?.return?.();
        busy.delete(baton);
        res.end();
      }
    } catch {
      res.writeHead(500).end("Fixture request failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    mode,
    requests,
    statements,
    batches,
    get produced() {
      return produced;
    },
    get cursors() {
      return cursors;
    },
    get sessions() {
      return sessions.size;
    },
    expireSessions() {
      for (const close of sessions.values()) close();
      sessions.clear();
    },
    async close() {
      for (const close of sessions.values()) close();
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function decode(value: Value): null | string | number | bigint | Buffer {
  switch (value.type) {
    case "null":
      return null;
    case "integer":
      return BigInt(value.value ?? "0");
    case "float":
      return Number(value.value);
    case "text":
      return String(value.value);
    case "blob":
      return Buffer.from(value.base64 ?? "", "base64");
    default:
      throw new Error("Unknown parameter");
  }
}

function encode(value: unknown): Value {
  if (value === null) return { type: "null" };
  if (typeof value === "number")
    return Number.isInteger(value)
      ? { type: "integer", value: String(value) }
      : { type: "float", value };
  if (typeof value === "bigint")
    return { type: "integer", value: String(value) };
  if (typeof value === "string") return { type: "text", value };
  if (Buffer.isBuffer(value))
    return { type: "blob", base64: value.toString("base64") };
  throw new Error("Unknown result value");
}
