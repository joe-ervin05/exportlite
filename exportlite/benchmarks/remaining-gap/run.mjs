import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";

const node = process.env.BENCH_NODE ?? "<node-26.12.0>";
const directory = "benchmarks/results/remaining-gap";
mkdirSync(`${directory}/raw`, { recursive: true });
const jobs = [];
const add = (datasets, modes, methods, repeats) => {
  for (let repeat = 0; repeat < repeats; repeat++)
    for (const dataset of datasets)
      for (const mode of modes)
        for (let offset = 0; offset < methods.length; offset++)
          jobs.push({
            dataset,
            mode,
            method: methods[(repeat + offset) % methods.length],
            repeat,
          });
};
add(
  ["matched", "narrow", "wide"],
  ["output"],
  ["before", "after", "full", "full-blob"],
  5,
);
add(["matched", "narrow", "wide"], ["sql", "web"], ["before", "after"], 3);
add(["narrow", "wide"], ["zip"], ["before", "after"], 3);
add(["matched", "wide"], ["rows"], ["before", "after"], 3);
writeFileSync(
  `${directory}/configuration.json`,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      node,
      cpu: cpus()[0].model,
      platform: platform(),
      release: release(),
      ramBytes: totalmem(),
      repeats:
        "five fresh workers for output, three for other modes; one verified + one warm + three timed exports per worker",
      files: Object.fromEntries(
        [
          "dist/index.mjs",
          "src/planner/batches.ts",
          "src/api/export.ts",
          "src/database/better-sqlite3.ts",
          "src/output/writer.ts",
          "src/output/zip.ts",
          "src/output/readable.ts",
          "benchmarks/baselines/pre-stream-tuning/index.mjs",
          "benchmarks/remaining-gap/worker.mjs",
        ].map((path) => [
          path,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
      ),
      jobs,
    },
    null,
    2,
  ),
);
const all = [];
for (const job of jobs) {
  const output = `${directory}/raw/${job.dataset}-${job.method}-${job.mode}-${job.repeat}.json`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      node,
      [
        "benchmarks/remaining-gap/worker.mjs",
        ...Object.entries(job)
          .filter(([key]) => key !== "repeat")
          .map(([key, value]) => `--${key}=${value}`),
        `--out=${output}`,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${output}: exit ${code}`)),
    );
  });
  all.push(JSON.parse(readFileSync(output, "utf8")));
}
writeFileSync(`${directory}/all.json`, JSON.stringify(all, null, 2));
console.log(`Completed ${all.length} fresh workers`);
