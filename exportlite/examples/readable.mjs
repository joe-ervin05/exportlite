import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { exportTable } from "../dist/index.mjs";

const db = new Database(":memory:");
const directory = new URL("./output/", import.meta.url);
await mkdir(directory, { recursive: true });
const output = fileURLToPath(new URL(`api-users-${Date.now()}.zip`, directory));
let stream;
let download;
try {
  db.exec(
    "CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(1,'Jóe 雪'),(2,'Amelia')",
  );
  stream = await exportTable(db, "users", { format: "json", zip: true });
  const response = new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="users.zip"',
    },
  });

  // An API handler can return response here. This local example downloads
  // its body to a file without collecting the archive in memory.
  if (!response.body) throw new Error("Expected response body");
  download = Readable.fromWeb(response.body);
  await pipeline(download, createWriteStream(output, { flags: "wx" }));
  console.log({ output, ...(await stream.result) });
} finally {
  download?.destroy();
  if (stream && !stream.locked) await stream.cancel().catch(() => {});
  await stream?.result.catch(() => {});
  db.close();
}
