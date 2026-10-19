import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Pin the experiment: future runtime changes must not silently change its baseline.
export const sourceCommit = "6cedfe09ff9853116906a62426cfccc237bac0a8";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output =
  process.env.CSV_JS_BUILD_ROOT ?? join(root, "outputs/csv-js/projects");
const buildNode = process.env.BUILD_NODE ?? process.execPath;
const patch = fileURLToPath(new URL("candidate.patch", import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    result.stderr?.toString() || result.error?.message,
  );
  return result.stdout;
}

// Require a fresh destination instead of deleting an existing project directory.
await mkdir(output, { recursive: true });
const sqlite = join(output, "sqlite");
const javascript = join(output, "javascript");
await mkdir(sqlite);
await mkdir(javascript);
const archive = run("git", ["archive", sourceCommit, "exportlite"], {
  cwd: root,
});
run("tar", ["-x", "-C", sqlite], { input: archive });
await cp(sqlite, javascript, { recursive: true });
run("git", ["apply", "--unsafe-paths", `--directory=${javascript}`, patch], {
  cwd: root,
});
assert((await readFile(patch, "utf8")).includes("csvJsRows"));
for (const directory of [sqlite, javascript]) {
  const pkg = join(directory, "exportlite");
  await symlink(
    join(root, "exportlite/node_modules"),
    join(pkg, "node_modules"),
    "dir",
  );
  process.stdout.write(
    run(buildNode, [join(pkg, "node_modules/tsdown/dist/run.mjs")], {
      cwd: pkg,
    }),
  );
}
console.log(JSON.stringify({ sourceCommit, sqlite, javascript, buildNode }));
