# Contributing

Thanks for your interest in pi-model-sync. The package keeps zero runtime dependencies, zero root `devDependencies`, and no build step (both hosts load the TypeScript sources directly).

## Local development

Install these prerequisites.

- Node.js 22.19.0 or newer. CI uses Node.js 22.19.0 and npm 11.21.2.
- Bun 1.4.4.
- OMP 18.20.3 and TypeScript 7.0.2 (plus `@types/node`), pinned in `.github/omp-tools/`.

The pinned Node and Bun versions live in `.github/actions/setup-toolchain/action.yml`. The npm pin lives in `.github/actions/setup-npm/action.yml`. The OMP and TypeScript CI pins live in `.github/omp-tools/`.

Install the isolated CI tools once (the package root stays dependency-free without a root lockfile or root `node_modules`) and run the default verification suite:

```sh
npm ci --prefix .github/omp-tools
npm run check
```

`npm run check` runs with an isolated HOME and no credentials. `omp models` may perform public model-catalog discovery.

- `npm run typecheck`: strict TypeScript check (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) across `config.ts` and `index.ts` using `scripts/host-stub.d.ts`.
- `npm run check:versions`: verifies all six synchronized version declarations across `package.json`, `README.md`, `llms.txt`, and `AGENTS.md`.
- `npm run test:release-scripts`: `node:test` suites for `check-release-versions.mjs`, `bump-release.mjs`, and `verify-release-tarball.mjs`.
- `npm run test:graph`: verifies the load-time import graph has zero runtime package imports and passes the Bun default-export smoke check.
- `npm run test:unit`: cross-platform behavioral suite (`test/portable.test.ts`).
- `npm run test:packed`: packs the tarball, checks the exact `files` whitelist, installs cleanly into a temporary consumer directory with `--omit=dev`, checks zero runtime dependencies, runs the Bun import check, and loads the installed extension in `omp models --no-extensions -e ... --json`.
- `npm run check:posix`: POSIX-only invariants (`test/posix.test.ts`, skipped by `check:portable` on Windows).

For interactive testing under a real host:

- omp: `omp --extension /path/to/pi-model-sync`
- upstream pi: `pi --extension /path/to/pi-model-sync`
- For isolated config experiments, point `PI_MODEL_SYNC_CONFIG` at a throwaway file and never at a real user config.

## Pull requests

Open a real pull request against `main`.

- Use a conventional PR title with a lowercase prefix, a colon, and an imperative summary without a trailing period (for example, `fix: preserve explicit call model`). The trusted `PR title` (`pull_request_target`) workflow enforces this. `CI` runs the code checks.
- Keep the code style: 2-space indent, double quotes, `node:` builtins, extensionless internal imports, `unknown` + guards (never `any`), explicit return types.
- Update `README.md`, `llms.txt`, and `AGENTS.md` in the same change when behavior moves.
- Pull request CI runs `npm run check` on `ubuntu-24.04` and `macos-15`, and `npm run check:portable` on `windows-2025` under an isolated `HOME`.
- Never commit personal configs, session logs, `node_modules`, or temporary test files.

## Branch protection

The `main` ruleset is designed around four required checks: `verify`, `portability (macos-15)`, `portability (windows-2025)`, and `pr-title`, with strict up-to-date branch checks enabled. For a solo maintainer, do not enable `prevent-self-review` on the protected `npm-publish` environment.

The `pr-title` workflow uses `pull_request_target`. Public repositories must allow that event in a repository Actions policy before 2026-12-02, or the required `pr-title` check will be blocked.

`.github/CODEOWNERS` names the maintainer. `require_code_owner_review` stays off while the repository has one maintainer, because GitHub does not count a self-approval. Enable it when a second maintainer or team is added.

The `Protect release tags` ruleset includes a `creation` rule. Only the maintainer bypass actor can create `v*` tags; other writers cannot.

## Release runbook

PR validation and releases are separate. Never create a tag or publish a package to test CI.

### Prepare a version

1. Choose a new version `X.Y.Z` and a new `vX.Y.Z` tag. Never reuse, move, or retarget a published tag.
2. Run `npm run release:bump X.Y.Z` to update all six synchronized version declarations across four files:
   - `package.json` (`version`)
   - `README.md` (both `git:...@vX.Y.Z` install examples)
   - `llms.txt` (both `git:...@vX.Y.Z` install examples)
   - `AGENTS.md` (`MIT license, vX.Y.Z, published to npm as`)
3. Add release notes to `CHANGELOG.md`. The first visible `##` heading after `# Changelog` must be `## X.Y.Z — YYYY-MM-DD` with a valid calendar date and a non-empty section body.
4. Run `npm run check` and `node scripts/check-release-versions.mjs --release --tag vX.Y.Z`.
5. Merge the release preparation PR through `main`, then push the `vX.Y.Z` tag to `SenCha930511/pi-model-sync`.

### Protected tag workflow

Pushing a `v*` tag triggers `.github/workflows/release.yml`:

1. `release-verify` (`.github/workflows/release-verify.yml`) checks that `HEAD` matches the exact tag commit and is an ancestor of `origin/main`, validates `CHANGELOG.md` and release versions, runs `npm run check`, sets `gitHead`, packs the exact tarball, verifies it with `scripts/verify-release-tarball.mjs --test-packed`, and uploads it as an artifact.
2. `publish` runs under the `npm-publish` environment (`id-token: write`), verifies the downloaded tarball and `origin/main` ancestry, checks registry integrity for idempotent re-runs, selects `latest` or `backfill`, and runs `npm publish --access public --provenance` using npm Trusted Publishing (GitHub OIDC; no long-lived `NPM_TOKEN`).
3. `github-release` verifies published npm integrity and creates or updates the GitHub release with the exact `.tgz` asset and extracted `CHANGELOG.md` notes.
4. For a non-publishing rehearsal of a `v*` tag created after this pipeline landed, trigger the manual `Release dry run` workflow (`.github/workflows/release-dry-run.yml`).
5. After a release ships, update `SenCha930511/omp-marketplace` if the marketplace entry should move to the new tag.

Before the first release, enable `Allow npm publish` on the npm Trusted Publisher. The workflow uses direct `npm publish`, not staged publishing. A new trusted publisher must complete its first successful publish within two days or it expires.

For stronger npm hardening, require 2FA for publishing, disallow traditional publish tokens, and revoke unused automation tokens. The trusted publisher is then the only automated publish path.

## License

By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
