# Contributing

Thanks for your interest in pi-model-sync. The project is intentionally small:
six files, zero dependencies, no build step (the hosts run the TypeScript sources
directly on Bun).

## Before you start

- Read `AGENTS.md` — it documents the architecture, invariants, and conventions
  that reviewers will hold you to (never-throwing interception paths, whole-file
  project-over-global replacement, zero dependencies, English comments, docs,
  and notify/UI strings).
- Open an issue (or start a discussion in your PR) for any design change. Adding
  a dependency is a design change, not a routine edit.

## Development

There is no package manager install, lint, or test command — deliberately.

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
   stub extension or throwaway harness when deterministic proof is needed.
3. Update `README.md` and `AGENTS.md` in the same change when behavior moves.

## Pull requests

- One logical change per PR; describe the user-visible behavior, how it was
  verified, and any env/host assumptions.
- Keep the code style: 2-space indent, double quotes, `node:` builtins,
  extensionless internal imports, `unknown` + guards (never `any`), explicit
  return types.

## License

By contributing, you agree that your contributions are licensed under the MIT
License (see `LICENSE`).
