import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { tursoServer } from "../tests/helpers/turso-server.ts";

// npm supplies its own portable CLI path, avoiding shell/.cmd execution on Windows.
const npm = process.env.npm_execpath;
assert(
  npm?.endsWith("npm-cli.js"),
  "Run this check with npm run test:package.",
);
const pkg = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "exportlite-package-"));
const exec = promisify(execFile);
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}`,
  NODE_PATH: "",
};
async function run(args, cwd = pkg) {
  try {
    return await exec(process.execPath, args, {
      cwd,
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    console.error(error.stdout, error.stderr);
    throw error;
  }
}
const database = new Database(":memory:");
database.exec(
  "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'Jóe 雪'),(2,NULL)",
);
let server;
try {
  const { stdout } = await run([
    npm,
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    directory,
  ]);
  const [packed] = JSON.parse(stdout);
  const files = new Set(packed.files.map((file) => file.path));
  for (const file of files) {
    assert(
      /^(?:package\.json|README\.md|LICENSE|docs\/[\w-]+\.md|dist\/[\w.-]+\.(?:mjs|cjs|mts|cts|map))$/.test(
        file,
      ),
      `Unexpected packed file: ${file}`,
    );
  }
  assert.equal(
    manifest.private,
    true,
    "Keep publication a deliberate release step.",
  );
  for (const field of ["repository", "homepage", "bugs", "license", "engines"])
    assert(manifest[field], `Missing ${field}`);
  for (const peer of Object.keys(manifest.peerDependencies))
    assert.equal(manifest.peerDependenciesMeta[peer]?.optional, true);
  for (const entry of Object.values(manifest.exports)) {
    for (const format of ["import", "require"]) {
      for (const path of Object.values(entry[format]))
        assert(files.has(path.replace(/^\.\//, "")), `Missing export: ${path}`);
    }
  }
  for (const file of [...files].filter((file) => file.endsWith(".md"))) {
    const text = await readFile(join(pkg, file), "utf8");
    for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const path = join(dirname(file), target.split("#")[0]).replaceAll(
        "\\",
        "/",
      );
      assert(files.has(path), `${file} links to an unshipped file: ${target}`);
    }
  }
  const archive = join(directory, packed.filename);
  const modes = {
    bare: [],
    native: ["better-sqlite3"],
    turso: ["@libsql/client"],
    "drizzle-native": ["better-sqlite3", "drizzle-orm"],
    "drizzle-turso": ["@libsql/client", "drizzle-orm"],
  };
  server = await tursoServer(database);
  for (const [mode, peers] of Object.entries(modes)) {
    const consumer = join(directory, mode);
    await mkdir(consumer);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ name: `check-${mode}`, private: true, type: "module" }),
    );
    const tools = [
      "typescript",
      "@types/node",
      "yauzl",
      "csv-parse",
      ...(peers.includes("better-sqlite3") ? ["@types/better-sqlite3"] : []),
    ];
    const versions = [...peers, ...tools].map(
      (name) => `${name}@${manifest.devDependencies[name]}`,
    );
    await run(
      [
        npm,
        "install",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        archive,
        ...versions,
      ],
      consumer,
    );
    await copyFile(
      new URL("./package-consumer.mjs", import.meta.url),
      join(consumer, "consumer.mjs"),
    );
    const checked = await run(
      [join(consumer, "consumer.mjs"), mode, server.url],
      consumer,
    );
    assert.equal(checked.stdout.trim(), `Verified ${mode}: ESM and CommonJS`);
    const base = await readFile(
      new URL("./package-types.txt", import.meta.url),
      "utf8",
    );
    const adapter = peers.includes("drizzle-orm")
      ? `import { drizzle } from "drizzle-orm/${mode === "drizzle-native" ? "better-sqlite3" : "libsql/http"}";
import { sqliteTable, integer as int, text as str } from "drizzle-orm/sqlite-core";
import { exportTable as adapterTable, exportQuery as adapterQuery } from "exportlite/drizzle";
const schema = sqliteTable("users", { id: int().primaryKey(), name: str() });
const orm = drizzle(client);
const selected = adapterQuery(orm, orm.select({ userId: schema.id, label: schema.name }).from(schema));
type AdapterRow = Expect<Equal<ExportRow<typeof selected>, { userId: number; label: string | null }>>;
const adapterCsv = adapterQuery(orm, orm.select({ userId: schema.id, label: schema.name }).from(schema), {format:"csv"});
type AdapterCsv = Expect<Equal<ExportRow<typeof adapterCsv>, {userId:string;label:string}>>;
type TableRow = Expect<Equal<ExportRow<ReturnType<typeof table>>, typeof schema.$inferSelect>>;
function table() { return adapterTable(orm, schema); }
`
      : "";
    const driver = peers.includes("better-sqlite3")
      ? 'import Database from "better-sqlite3"; const client = new Database(":memory:");'
      : peers.includes("@libsql/client")
        ? 'import { createClient, exportQuery as remoteQuery } from "exportlite/turso"; const client = createClient({url:"https://example.invalid"}); const remote = remoteQuery(client, {sql:"SELECT 1 AS id", columns: {id:integer().notNull()}}); type RemoteRow = Expect<Equal<ExportRow<typeof remote>, {id:number}>>; const remoteCsv = remoteQuery(client, {sql:"SELECT 1 AS id",columns:{id:integer()},format:"csv"}); type RemoteCsv = Expect<Equal<ExportRow<typeof remoteCsv>,{id:string}>>; const closing: Promise<void> = client.close();'
        : "";
    for (const extension of ["mts", "cts"])
      await writeFile(
        join(consumer, `consumer.${extension}`),
        `${base}\n${driver}\n${adapter}`,
      );
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          noEmit: true,
          types: ["node"],
        },
        files: ["consumer.mts", "consumer.cts"],
      }),
    );
    await run(
      [join(consumer, "node_modules/typescript/bin/tsc"), "--noEmit"],
      consumer,
    );
    console.log(
      `Passed packed consumer: ${mode} (runtime and inferred types, ESM/CJS)`,
    );
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        package: `${manifest.name}@${manifest.version}`,
        files: files.size,
        packedBytes: packed.size,
        sha256: createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
        modes: Object.keys(modes),
        checks:
          "Real npm tarball installs; optional peer absence; ESM/CJS runtime and inferred types; Web/file/Node/ZIP output; local HTTP protocol; metadata and shipped Markdown links.",
      },
      null,
      2,
    ),
  );
} finally {
  await server?.close();
  database.close();
  await rm(directory, { recursive: true, force: true });
}
