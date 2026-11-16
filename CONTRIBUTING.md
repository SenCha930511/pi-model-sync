# Contributing

Thanks for your interest in pi-model-sync. The project is intentionally small:
nine files, zero dependencies, no build step (the hosts run the TypeScript sources
directly on Bun).

## Before you start

- Read `AGENTS.md`. It documents the architecture, invariants, and conventions
  that reviewers will hold you to (never-throwing interception paths, whole-file
  project-over-global replacement, zero dependencies, English comments, docs,
  and notify/UI strings).
- Open an issue (or start a discussion in your PR) for any design change. Adding
  a dependency is a design change, not a routine edit.

## Development

There is no package manager install, lint, or test command. That is deliberate.

- Manual load during development:
  - omp: `omp --extension /path/to/pi-model-sync`
  - upstream pi: `pi --extension /path/to/pi-model-sync`
- For isolated config experiments, point `PI_MODEL_SYNC_CONFIG` at a throwaway
  file and never at a real user config.

## Verification expectations

Behavioral verification is required for every functional change:

1. `bun -e 'const m = await import("./index.ts"); if (typeof m.default !== "function") process.exit(1)'`
   must print nothing and exit 0.
2. Exercise the changed path under a real host (omp and/or upstream pi), with a
   stub extension or throwaway harness when deterministic proof is needed. For
   command changes, cover first-run onboarding, `--project`, completion, and the
   fail-closed states.
3. Update `README.md`, `llms.txt`, and `AGENTS.md` in the same change when
   behavior moves.

For routing or config changes, a temporary fake-host harness is useful for an
old-vs-new comparison and for hot-path measurements. Keep it outside the repo.
The project does not ship a test runner.

## Pull requests

- One logical change per PR; describe the user-visible behavior, how it was
  verified, and any env/host assumptions.
- Keep the code style: 2-space indent, double quotes, `node:` builtins,
  extensionless internal imports, `unknown` + guards (never `any`), explicit
  return types.

## License

By contributing, you agree that your contributions are licensed under the MIT
License (see `LICENSE`).
