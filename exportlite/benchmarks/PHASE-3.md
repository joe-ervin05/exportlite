# Phase 3 compatibility and packaging validation

This phase adds qualification checks and packaging documentation without changing `src/`, SQL generation, streaming, batching, buffering or compression. ESM runtime bundle hashes match the memory-optimized candidate recorded in the wide-query investigation. Runtime peers and dependency pins remain unchanged. The Node engine range now identifies only the intended supported majors: 22.18.0+, 24.11.0+ and 26.x.

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

Cross-platform results are pending the first pushed workflow run. This configuration alone is not evidence that all jobs passed. Completion results will be recorded here after qualification.

## Scope

The package remains private and unpublished. Drizzle stays within `>=0.45.4 <0.46.0`, tested at 0.45.4. Turso retains its experimental label: these are local protocol tests, not live Turso qualification. The compatibility matrix covers the selected hosted runner architectures; it does not qualify every CPU, libc or custom SQLite build. Candidate performance consolidation and real application pilots remain later phases.

Run `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm check`, `pnpm test` and `npm run test:package` from `exportlite/`. Run `node benchmarks/validate-zip64.mjs` separately for release qualification. The packed-consumer check requires registry access and a localhost listener and cleans its temporary installations afterward.
