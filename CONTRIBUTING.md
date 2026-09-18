# Contributing

Thanks for taking a look. This is a small, deliberately dependency-free tool, so
the bar for changes is mostly about keeping it that way.

## Getting started

```bash
npm install
npm run verify        # lint + typecheck + test + build
npm run dev           # build and run on http://127.0.0.1:7781
npm run dev:web       # Vite dev server against a running API
node dist/cli/main.js --doctor   # see what auto discovery found
```

`npm run verify` must pass before you open a pull request. CI runs it on
Windows, Linux and macOS across Node 20/22/24, plus the test suite under five
timezones.

## Architecture in one paragraph

`core/` owns the normalized session model and all analysis (activity segments,
idle, concurrency, aggregation) and knows nothing about any provider.
`adapters/` is the only provider-aware code. `discovery/` finds log directories.
`indexer/` scans and caches. `server/` exposes a loopback HTTP API. `web/` reads
the normalized model only. See [AGENTS.md](AGENTS.md) for the rules that keep
those boundaries real.

## Adding support for another agent CLI

Implement `ProviderAdapter` in `src/core/types.ts`, put it in
`src/adapters/<name>/`, and register it in `src/discovery/roots.ts`. If you need
to change anything in `core/` or `web/` to make it work, the normalization is
probably in the wrong place — open an issue first and let's talk about it.

## Things that will get a PR sent back

- Adding a runtime dependency. `dependencies` stays empty; CI enforces it.
- Any outbound network request, including update checks.
- Writing to a provider's directory.
- Presenting an estimate as a measurement, or rendering a metric a provider does
  not record as `0` instead of "not recorded".
- Fixtures containing anything real: a real prompt, path, username, repository,
  email or credential. Everything committed under `test/fixtures/` is synthetic
  and must stay that way.

## Reporting bugs

Please include your OS, whether the logs are on Windows / WSL / macOS / Linux,
the CLI versions involved, and the output of `--doctor`. If a log failed to
parse, a **synthetic** reproduction of the record shape is far more useful than
the real thing — and much safer to share.

Security issues: see [SECURITY.md](SECURITY.md), not the public tracker.
