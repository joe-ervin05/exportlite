# Compatibility and package checks

The package targets Node 22.18.0+, 24.11.0+ and 26.x. Odd Node majors and other runtimes are outside the supported matrix. Node 22 and 24 are LTS; 26 is Current as of October 18, 2026 ([Node release schedule](https://nodejs.org/en/about/previous-releases)). Use a current patch within the selected major.

The [compatibility workflow](https://github.com/joe-ervin05/exportlite/actions/workflows/ci.yml) runs on pushes and pull requests:

| Platform | Node | Checks |
| --- | --- | --- |
| Ubuntu | Exact minimum 22.18.0, latest 22.x, 24.x, 26.x | Frozen install, build, types, lint, full reliability suite and clean packed consumers |
| macOS | Latest 24.x | Same checks |
| Windows | Latest 24.x | Same checks |

The workflow selects the runner's native architecture. This is not qualification for every architecture, Linux libc, Node patch or native SQLite build. Qualification evidence and exact tested runtime versions are recorded in the repository's [phase 3 validation report](https://github.com/joe-ervin05/exportlite/blob/main/exportlite/benchmarks/PHASE-3.md). A configured job alone is not a passing compatibility claim.

## Packed consumers

After a frozen checkout install and build, run `npm run test:package`. npm supplies the portable CLI path used by this check; the repository dependencies can still be installed with pnpm.

The check creates a real npm tarball and installs it into five fresh temporary projects: no driver peers, native SQLite only, Turso only, Drizzle plus native, and Drizzle plus Turso. Runtime checks verify unused peers are absent and load the public package exports with both `import` and `require`. Native and remote consumers exercise table/query exports, Unicode and NULLs, Web responses, files, asynchronous Node writable backpressure, ZIP decoding/CRC, cancellation and client shutdown. Turso consumers use the existing local HTTP/SQLite protocol fixture running outside their isolated dependency tree; they do not install better-sqlite3 or contact a cloud service.

Each project also installs pinned TypeScript, Node typings and the independent ZIP reader as test tools. Native consumers add driver typings. Separate `.mts` and `.cts` files verify the package's exported declarations and exact inferred row types. Dependency declarations retain optional drivers. Drizzle compatibility stays at `>=0.45.4 <0.46.0`, with 0.45.4 tested; widening it requires adapter validation.

The tarball audit checks declared export targets, optional peers, metadata, an allowlist of shipped files and relative Markdown links. Benchmarks and examples remain in the source repository; README links to unshipped reports use repository URLs. The package stays private and unpublished through this phase.

## ZIP64 release check

`node benchmarks/validate-zip64.mjs` streams an actual entry larger than 4 GiB and independently decodes it with CRC and declared-size checks. It runs locally for release qualification and as an extra job on a manual compatibility workflow run. Ordinary pushes retain the smaller ZIP tests. A manual workflow does not publish anything.

Turso remains experimental pending the separate live-service qualification gate. Package installation and local protocol checks do not establish Turso Cloud behavior.
