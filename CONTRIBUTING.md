# Contributing

Thanks for your interest in pi-model-sync. The package keeps zero runtime dependencies, zero root `devDependencies`, and no build step (both hosts load the TypeScript sources directly).

## Local development

Install these prerequisites.

- Node.js 22.19.0 or newer. CI uses Node.js 22.19.0 and npm 11.21.2.
- Bun 1.4.4.
- OMP 18.20.3, upstream pi 1.5.2, and TypeScript 7.0.2 (plus `@types/node` and `@types/bun`), pinned in `.github/omp-tools/`.

The pinned Node and Bun versions live in `.node-version` and `.bun-version`; every workflow reads them from there. `@types/bun` must match `.bun-version` (CI fails otherwise, and Dependabot leaves it alone), so bump both together. The npm pin lives in `.github/actions/setup-npm/action.yml`. The OMP, upstream pi, and TypeScript CI pins live in `.github/omp-tools/`.

Install the isolated CI tools once (the package root stays dependency-free without a root lockfile or root `node_modules`) and run the default verification suite:

```sh
npm ci --prefix .github/omp-tools
npm run check
```

`npm run check` runs with an isolated HOME and no credentials. `omp models` may perform public model-catalog discovery.

- `npm run typecheck`: strict TypeScript check (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`) of the shipped modules (`adapters.ts`, `config.ts`, `resolver.ts`, `session.ts`, `hooks.ts`, `completions.ts`, `commands.ts`, `index.ts`) via `scripts/tsconfig.typecheck.json` and `scripts/host-stub.d.ts`, then of the tests and `scripts/test-load-graph.ts` with Bun types via `scripts/tsconfig.tests.json`, then of `scripts/host-contract.ts` against the installed omp and upstream pi type packages via `scripts/tsconfig.hosts.json`.
- `npm run check:versions`: verifies all six synchronized version declarations across `package.json`, `README.md`, `llms.txt`, and `AGENTS.md`.
- `npm run test:release-scripts`: `node:test` suites for `check-release-versions.mjs`, `bump-release.mjs`, and `verify-release-tarball.mjs`.
- `npm run test:graph`: verifies the load-time import graph has zero runtime package imports and passes the Bun default-export smoke check.
- `npm run test:unit`: cross-platform behavioral suites (`test/portable.test.ts`, `test/adapters.test.ts`, `test/commands.test.ts`, `test/features.test.ts`, `test/resolver.test.ts`) with the shared host harness in `test/harness.ts`, under coverage. `bunfig.toml` sets a per-file line/function threshold just below current coverage; raise it when coverage improves and never lower it to make a change pass.
- `npm run test:packed`: packs the tarball, checks the exact `files` whitelist, installs cleanly into a temporary consumer directory with `--omit=dev`, checks zero runtime dependencies, runs the Bun import check, loads the installed extension in `omp models --no-extensions -e ... --json`, and checks that upstream `pi --mode rpc` registers `/model-sync` and executes `/model-sync list` from the installed tarball (`get_commands` plus a prompt).
- `npm run check:posix`: POSIX-only invariants (`test/posix.test.ts`, skipped by `check:portable` on Windows).

For interactive testing under a real host:

- omp: `omp --extension /path/to/pi-model-sync`
- upstream pi: `pi --extension /path/to/pi-model-sync`
- For isolated config experiments, point `PI_MODEL_SYNC_CONFIG` at a throwaway file and never at a real user config.

## Pull requests

Open a real pull request against `main`.

- Use a conventional PR title with a lowercase prefix, a colon, and an imperative summary without a trailing period (for example, `fix: preserve explicit call model`). The trusted `PR title` (`pull_request_target`) workflow enforces this. `CI` runs the code checks.
- Keep the code style: 2-space indent, double quotes, `node:` builtins, extensionless internal imports, `unknown` + guards (never `any`), explicit return types.
- Update `README.md`, `llms.txt`, and `AGENTS.md` when behavior moves. Update `CONTRIBUTING.md` when the development process moves.
- Pull request CI runs `npm run check` on `ubuntu-24.04` and `macos-15`, and `npm run check:portable` on `windows-2025` under an isolated `HOME`. The `workflow-lint` job runs pinned `actionlint` (configured by `.github/actionlint.yaml`) and `zizmor` (configured by `.github/zizmor.yml`) over `.github/`. Locally: `actionlint && uvx zizmor@1.32.0 .github`.
- The `Host canary` workflow runs weekly (and on demand) against the newest omp and upstream pi releases. It does not gate PRs; a failure means a host release needs attention before Dependabot bumps the pins.
- Never commit personal configs, session logs, `node_modules`, or temporary test files.

## Branch protection

The `main` ruleset is designed around five required checks: `workflow-lint`, `verify`, `portability (macos-15)`, `portability (windows-2025)`, and `pr-title`, with strict up-to-date branch checks enabled. For a solo maintainer, do not enable `prevent-self-review` on the protected `npm-publish` environment.

The `main` ruleset allows **rebase merges only** and requires linear history. A rebase merge preserves every PR commit.

The `pr-title` workflow uses `pull_request_target`. Public repositories must allow that event in a repository Actions policy before 2026-12-02, or the required `pr-title` check will be blocked.

`.github/CODEOWNERS` names the maintainer. `require_code_owner_review` stays off while the repository has one maintainer, because GitHub does not count a self-approval. Enable it when a second maintainer or team is added.

The `Protect release tags` ruleset includes a `creation` rule. Only the maintainer bypass actor can create `v*` tags; other writers cannot.

## License

By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
