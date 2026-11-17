# Routing hardening decision trail

Run date: 2026-11-17. Branch: `feat/routing-hardening`.

## Baseline

| Check | Before |
|---|---|
| `npm run typecheck` | pass |
| `npm run test:unit` | 41 tests pass |
| `index.ts` line coverage | 69.93% |
| Module count | 3 (`adapters.ts`, `config.ts`, `index.ts`) |

## Decisions and evidence

| Unit | Decision | Evidence |
|---|---|---|
| Module split | `index.ts` is registration only. Resolution, session state, hooks, completion, and commands live in `resolver.ts`, `session.ts`, `hooks.ts`, `completions.ts`, and `commands.ts`. | `npm run test:graph`; `scripts/test-packed.mjs`; `npm run typecheck` |
| Session state | Warning dedupe, override, pause, status, and route log are created once per `modelSync(pi)` call. No module-level warning sets. | `test/features.test.ts` "warnings are per session instead of process-global" |
| Selector model | `parseSelector` returns a discriminated value; `selectorRefs` offers provider/id first and the whole base as a bare id second. | `test/resolver.test.ts` "offers provider/id first and the whole base as a bare id second" |
| Upstream auth | `provider/id` resolution requires `hasConfiguredAuth()` when the registry exposes it. | `test/resolver.test.ts` "find plus configured auth decides provider/id selectors" |
| Bare ids with `/` | Classification uses omp `ctx.models.list()` or the upstream registry; exact-only plugins reject a slash-containing bare id. | `test/resolver.test.ts`; `test/features.test.ts` "rejects a slash-containing bare id for an exact-only plugin" |
| `show` | `show` strips `:level` for matching and reports the installed plugin dialects that accept each selector. | `test/commands.test.ts` "show strips :level, reports plugin dialect compatibility, and handles misses" |
| `tool_call` write | The handler mutates `event.input` in place and returns `undefined`. The double write and the upstream unknown `input` field are gone. | `test/features.test.ts` "tool_call mutates in place and records the routed decision"; `scripts/host-contract.ts` |
| omp per-call model | A spawn with `invocationKind`, no `modelRole`, and one pattern different from the current model is left alone. Older hosts stay routable. | `test/features.test.ts` "leaves an explicit per-call model alone but routes a normal spawn" |
| Command parsing | Quotes keep a value together; unknown `--` options are rejected; `--help` never becomes a name. | `test/commands.test.ts` "keeps quoted arguments together and rejects unbalanced quotes", "rejects unknown flags instead of writing them as names" |
| Config tolerance | Unknown root/profile keys are warnings and are dropped on the next write. `cmdSet` updates the profile main case. | `test/commands.test.ts` "updates the profile main case in set and warns before replacing agent entries"; `test/features.test.ts` doctor tests |
| Writes | Temp names use a UUID; writes follow a symlink to its real target; cache hits refresh LRU order. | `test/portable.test.ts` "writeConfig follows a symlink instead of replacing it", "writeConfig validates, invalidates cache, and clones keep sibling presets isolated" |
| Adapter fingerprints | Every adapter requires `model` in its schema fingerprint; `$ref`/`$defs` and nested property schemas are collected; edxeth children fall back to `*`. | `test/adapters.test.ts` "resolves local $ref and $defs properties", "edxeth falls back to * for a child without an agent" |
| Agent matching | `agentMatch: "case-insensitive"` adds a case-insensitive pass after the exact key and before `*`. | `test/features.test.ts` "matches agent keys case-insensitively when the profile opts in" |
| Session commands | `use-session`, `pause`, `resume`, `status`, `log`, `doctor`, and `init` are implemented; none of the session controls writes. | `test/features.test.ts` session, doctor, and init groups |
| Host contract | `scripts/host-contract.ts` compiles against the installed omp and upstream pi types. | `npm run typecheck` |
| Packed integration | The packed tarball loads in omp and executes `/model-sync list` in upstream pi RPC against an isolated config. | `npm run test:packed` |
| Coverage | 104 unit tests plus 3 POSIX tests; 95.58% lines, 99.21% functions; per-file ratchet set to 88% lines and 95% functions. | `npm run test:unit`, `npm run test:posix` |

## Open items

- Thinking-level inheritance from the spawning session is not implemented. The selector dialect still treats `:level` as static. A future change needs a host thinking-level source and a decision for suffix dialects.
- `invocationKind`-specific routing (`task` vs `eval`) is not implemented. The spawn hook reads `invocationKind` only to identify explicit per-call models.
- No `CHANGELOG.md` entry was added because `scripts/check-release-versions.mjs` requires the first `##` heading to match the package version; this branch does not bump the version.
- Interactive TUI behavior was exercised through the host harness and the packed RPC probe, not through a live terminal session. The manual checklist in `AGENTS.md` covers the remaining visual checks.
