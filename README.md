# ExportLite

A Node.js library for exporting SQLite tables and read-only queries as streaming JSON, JSONL, or a ZIP containing one exported file. SQLite constructs the JSON; the application does not need to collect and serialize every row as a JavaScript object.

The package lives in [exportlite/](exportlite/). It supports better-sqlite3 directly, an optional Drizzle adapter, and an experimental Turso/libSQL HTTP adapter. This is a private, unpublished prototype; live Turso Cloud compatibility has not yet been verified.

## Development

Use a Node version supported by the package and pnpm 12.14.0. The recorded performance comparisons use Node 26.12.0.

```sh
cd exportlite
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm check
```

See the [package guide](exportlite/README.md) for the current API, examples, ownership rules, and supported data types. The [production-readiness plan](exportlite/PRODUCTION-PLAN.md) defines the remaining release work.

## Benchmarks

The [benchmark guide](exportlite/benchmarks/REPORT.md) and the reports beside it describe the local, compression, Drizzle, and remote-protocol comparisons. Selected measurements and investigation sources are retained in [outputs/](outputs/README.md).

The main benchmark runner creates its own fixtures:

```sh
cd exportlite
pnpm bench --rows=100000 --width=32 --repeats=3 --warmups=1 --methods=exportlite,exportlite-query,object-stream,sqlite-aggregate --destinations=file --out=benchmarks/results/local.json
```

Historical investigation runners and results retain their original version and fixture assumptions. Their machine-specific paths have been normalized for publication; consult the evidence guide before adapting them to a new environment. Simulated latency results are not measurements of Turso Cloud capacity.

## License

[MIT](LICENSE).
