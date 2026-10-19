import { build } from "tsdown";

await build({
  config: false,
  entry: [new URL("./engine-entry.ts", import.meta.url).pathname],
  outDir: new URL("./build/", import.meta.url).pathname,
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: false,
  sourcemap: true,
  clean: true,
});
