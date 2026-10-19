import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "../../exportlite/node_modules/tsdown/dist/index.mjs";
import config from "../../exportlite/tsdown.config.ts";

const output = fileURLToPath(new URL("./bundled-js", import.meta.url));
await mkdir(output); // Refuse to replace any previous control build.
process.chdir(fileURLToPath(new URL("../../exportlite", import.meta.url)));
await build({
	...config,
	config: false,
	outDir: output,
	alias: {},
	deps: {
		...config.deps,
		onlyBundle: [...config.deps.onlyBundle, "crc-32"],
	},
});
