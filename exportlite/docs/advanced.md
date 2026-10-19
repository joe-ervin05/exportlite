# Advanced options

Most exports can use the defaults. These options remain available on the existing APIs and do not change batching or compression settings.

## SQLite database encoding

`encoding` describes a **declared local table's SQLite database**, not the encoding of a file or HTTP response. Supported values are `"utf8"` (default), `"utf16le"` and `"utf16be"`. All exported bytes are UTF-8.

```ts
await exportTable(db, "users", {
  columns: { id: integer().primaryKey(), name: text() },
  encoding: "utf16le", // Match this existing database's encoding.
  format: "json",
  output: "users.json",
});
```

UTF-8 keeps native batches as bytes. For UTF-16 databases the driver returns text, and the writer encodes it as UTF-8. If declared UTF-8 batching receives UTF-16 bytes, it rejects them before copying that batch payload. There is no encoding probe or retry; earlier output may already exist, with the usual failure cleanup.

Automatic local discovery obtains the database encoding itself. Queries and Turso exports receive text and always produce UTF-8; the remote path needs no encoding hint. The option applies to native Drizzle table exports as well.

Node's default string-to-byte encoding is UTF-8; JavaScript strings themselves use UTF-16. See [Node's encoding reference](https://nodejs.org/api/buffer.html#buffers-and-character-encodings).

## Output flush target

`bufferSize` is a target for flushing uncompressed UTF-8 bytes. It defaults to **65,536 bytes (64 KiB)** and accepts integers from 1 to 16,777,216 (16 MiB), inclusive. It applies to file, Node writable and Web-stream exports, including the JSON/JSONL/CSV input to ZIP.

```ts
await exportTable(db, "users", {
  format: "json",
  output: "users.json",
  bufferSize: 131_072,
});
```

This target is not a hard chunk-size or memory limit. A record or SQLite batch can exceed it. It does not alter the fixed 256-row batches, SQLite's working memory, downstream stream queues, or the ZIP compressor's buffer. Smaller targets can increase writes; larger targets can delay first output and retain more data. Use the default unless an application measurement justifies changing it.

ZIP retains compression level 1, `memLevel: 9` and a 256 KiB zlib output buffer. Ordinary HTTP compression stays in the application. Neither `encoding` nor `bufferSize` adds metadata queries or bypasses backpressure and cancellation.
