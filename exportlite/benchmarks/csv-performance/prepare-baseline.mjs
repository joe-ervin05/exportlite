import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ref = process.argv[2] ?? "e601d1a61121c8a4eb27092f3869808b50aca412";
const output = resolve(
  process.argv[3] ?? join(root, "outputs/csv-performance/baseline"),
);
const buildNode = process.env.BUILD_NODE ?? process.execPath;
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
// Never replace another checkout or an earlier benchmark build.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const archive = run("git", ["archive", ref, "exportlite"], { cwd: root });
run("tar", ["-x", "-C", output], { input: archive });
const pkg = join(output, "exportlite");
await symlink(
  join(root, "exportlite/node_modules"),
  join(pkg, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);
process.stdout.write(
  run(buildNode, [join(pkg, "node_modules/tsdown/dist/run.mjs")], { cwd: pkg }),
);
const commit = run("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
  cwd: root,
})
  .toString()
  .trim();
await writeFile(
  join(output, "metadata.json"),
  `${JSON.stringify({ commit, buildNode, note: "Uses the installed pinned dependency tree." }, null, 2)}\n`,
);
console.log(`EXPORTLITE_BEFORE=${join(pkg, "dist")}`);
