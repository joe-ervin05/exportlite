import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";

const node26 = process.env.BENCH_NODE ?? "<node-26.12.0>";
const directory = "benchmarks/results/batch-profile";
mkdirSync(`${directory}/raw`, { recursive: true });
const variants = [
  ["before", "output"],
  ["after", "output"],
  ["full", "output"],
  ["before", "sql"],
  ["after", "sql"],
  ["before", "web"],
  ["after", "web"],
];
const jobs = [];
for (let repeat = 0; repeat < 5; repeat++) {
  for (const dataset of ["matched", "narrow", "wide"]) {
    const rotated = [
      ...variants.slice(repeat % variants.length),
      ...variants.slice(0, repeat % variants.length),
    ];
    for (const [method, mode] of rotated)
      jobs.push({ dataset, method, mode, repeat });
  }
}
for (let repeat = 0; repeat < 3; repeat++) {
  for (const dataset of ["narrow", "wide"]) {
    for (const method of repeat % 2 ? ["after", "before"] : ["before", "after"])
      jobs.push({ dataset, method, mode: "zip", repeat });
  }
}
const configuration = {
  created: new Date().toISOString(),
  node26,
  processSamples: 3,
  workers: jobs.length,
  warmups: "one verified response plus one untimed response per worker",
  memory:
    "whole-process max RSS; streaming workers never build full JSON for verification",
  cpu: cpus()[0].model,
  platform: platform(),
  release: release(),
  ramBytes: totalmem(),
  files: Object.fromEntries(
    [
      "src/planner/batches.ts",
      "src/api/export.ts",
      "src/output/writer.ts",
      "dist/index.mjs",
      "benchmarks/baselines/pre-batch-tuning/index.mjs",
      "benchmarks/batch-profile/worker.mjs",
    ].map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  ),
  jobs,
};
writeFileSync(
  `${directory}/configuration.json`,
  `${JSON.stringify(configuration, null, 2)}\n`,
);
const results = [];
for (const job of jobs) {
  const path = `${directory}/raw/${job.dataset}-${job.method}-${job.mode}-${job.repeat}.json`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      node26,
      [
        "benchmarks/batch-profile/worker.mjs",
        ...Object.entries(job)
          .filter(([key]) => key !== "repeat")
          .map(([key, value]) => `--${key}=${value}`),
        `--out=${path}`,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Worker exited ${code}: ${path}`)),
    );
  });
  results.push(JSON.parse(readFileSync(path, "utf8")));
}
writeFileSync(`${directory}/all.json`, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Completed ${results.length} fresh workers`);
