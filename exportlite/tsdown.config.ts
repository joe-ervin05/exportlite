import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/drizzle.ts", "src/turso.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node22",
  dts: true,
  sourcemap: true,
  clean: true,
});
