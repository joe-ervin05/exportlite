# Phase 3 compatibility and packaging validation

This phase adds qualification checks and packaging documentation without changing `src/`, SQL generation, streaming, batching, buffering or compression. Locally rebuilt ESM runtime bundle hashes match the memory-optimized candidate recorded in the wide-query investigation. Runtime peers and dependency pins remain unchanged. The Node engine range now identifies only the intended supported majors: 22.18.0+, 24.11.0+ and 26.x.

## Local validation

On macOS arm64, Node **26.12.0**:

- Build, public ESM/CommonJS types and lint pass; all **378 reliability tests** pass.
- A real npm tarball installs into five clean projects: bare core, native only, Turso only, Drizzle/native and Drizzle/Turso. Both ESM and CommonJS runtime exports and inferred row types pass in every project. Unused driver peers are asserted absent.
- Packed consumers verify tables, ordered queries, Unicode/NULLs, Web responses, owned files, asynchronous writable backpressure, independent ZIP decoding/CRC, cancellation and awaitable remote close. The Turso fixture runs outside the isolated consumer with the existing HTTP/SQLite protocol helper.
- The audited payload contains **42 files**: builds and declarations, maps, three documentation files, README, license and package metadata. Fixtures, tests, scripts, benchmark histories and generated downloads are excluded. Relative Markdown links resolve to shipped files; historical report links point to GitHub.
- The actual ZIP64 check exported and independently decoded **4,296,065,036 uncompressed bytes**, verifying CRC, declared sizes and ZIP64 extraction version 45. Encoded archive size: **18,778,156 bytes**. See [recorded validation](results/zip64-validation.json).
- npm releases were checked on October 18, 2026. Existing pins remain current; Node typings deliberately stay on 22.x. Current Node patches are 22.23.3, 24.22.0 and 26.12.0. CI actions are pinned to verified release commits.

## CI qualification

The [compatibility workflow](https://github.com/joe-ervin05/exportlite/actions/workflows/ci.yml) is configured for Ubuntu at exact Node 22.18.0 and current 22/24/26 patches, plus macOS and Windows at current Node 24. Every job runs a frozen install, build, type checks, lint, the full suite and the packed consumers. Directory-link test fixtures use Windows-compatible junctions. ZIP64 additionally runs on manual workflow dispatch and does not publish anything.

The [initial hosted run](https://github.com/joe-ervin05/exportlite/actions/runs/39189813018) passed Ubuntu at Node 22.18.0, current 22 and 26, and macOS at Node 24, including packed consumers. Windows formatting exposed CRLF checkout conversion; Ubuntu/Node 24 exposed two tests that sampled ZIP backpressure after a fixed short delay while compressor queues were still filling. LF checkout attributes and sustained-stall observation replace those platform/timing assumptions. Existing upper bounds and cancellation/cleanup assertions remain. The runtime implementation is unchanged.

The [corrected matrix passed all six jobs](https://github.com/joe-ervin05/exportlite/actions/runs/39190023200) at commit `4023ba719b2d07200e1a33d7bde9558d9d8c2efd`:

| Platform | Architecture | Actual Node | Reliability suite | Packed consumers |
| --- | --- | --- | --- | --- |
| Ubuntu | x64 | 22.18.0 | 378 pass | All 5 pass |
| Ubuntu | x64 | 22.23.3 | 378 pass | All 5 pass |
| Ubuntu | x64 | 24.22.0 | 378 pass | All 5 pass |
| Ubuntu | x64 | 26.12.0 | 378 pass | All 5 pass |
| macOS | arm64 | 24.22.0 | 378 pass | All 5 pass |
| Windows | x64 | 24.22.0 | 378 pass | All 5 pass |

All jobs also passed frozen installation, build, public type consumers and lint. Across the matrix, 30 clean tarball projects passed both ESM/CommonJS runtime and type checks. Each audited artifact has 42 files; per-job archive hashes and actual Node/platform details are in the [CI record](../../outputs/phase3/ci.json). The [local validation record](../../outputs/phase3/local.json) describes the initial local working candidate; its archive hash is separate from these later CI artifacts. The manual-only hosted ZIP64 job was skipped on this push; the actual >4-GiB check passed locally as recorded above.

## Scope

The package remains private and unpublished. Drizzle stays within `>=0.45.4 <0.46.0`, tested at 0.45.4. Turso retains its experimental label: these are local protocol tests, not live Turso qualification. The compatibility matrix covers the selected hosted runner architectures; it does not qualify every CPU, libc or custom SQLite build. Candidate performance consolidation and real application pilots remain later phases.

Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm check`, `pnpm test` and `npm run test:package` from `exportlite/`. Run `node benchmarks/validate-zip64.mjs` separately for release qualification. The packed-consumer check requires registry access and a localhost listener and cleans its temporary installations afterward.
