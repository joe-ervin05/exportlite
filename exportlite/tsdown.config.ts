import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/drizzle.ts", "src/turso.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
  // Bundle the ZIP writer privately so the checksum substitution cannot affect
  // other packages using zip-stream in the same process.
  alias: {
    "crc-32": fileURLToPath(new URL("./src/output/crc32.ts", import.meta.url)),
  },
  deps: {
    alwaysBundle: ["zip-stream"],
    onlyBundle: [
      "zip-stream",
      "compress-commons",
      "crc32-stream",
      "normalize-path",
      "is-stream",
      "readable-stream",
      "event-target-shim",
      "abort-controller",
      "process",
      "safe-buffer",
      "string_decoder",
    ],
  },
});
