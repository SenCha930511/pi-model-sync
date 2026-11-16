# Repository Guidelines

## Project Overview

pi-model-sync is a **dual-host coding-agent extension (omp / upstream pi)** that routes the model used by newly spawned subagents (task / eval `agent()` / workpool workers) and by `@mjakl/pi-subagent` `subagent` tool calls, based on the *spawning session's current model*, via a two-layer JSON config holding named presets (one active preset per layer). It also exposes a `/model-sync` slash command to manage profiles and presets. Not a CLI, not a library. Loaded and executed by the host. MIT license, v0.5.0, published to npm as `@sencha930511/pi-model-sync`.

Key behaviors: running subagents never switch models mid-flight; nested spawns are intercepted using the spawning session's own model; selectors that fail to resolve fall through to default routing with a one-time TUI warning; an explicit per-call `model` in a pi-subagent call is never overwritten (frontmatter-level defaults are overridden by injection on purpose). Config documents are either legacy `{ profiles }` or named `{ activePreset?, presets }`; only the active preset's ordered profile list routes; a missing, empty, or dangling active preset fails closed, with the reason surfaced by `/model-sync list|show`. `add`/`set`/`remove`/`move` edit only the active preset; the first successful `preset create`/`preset copy` converts a legacy document to `presets.default`, and `preset rename default <name>` converts it to `<name>`; every write path deep-clones the whole document.

## Architecture & Data Flow

Flat two-module design; the only inter-file dependency is `index.ts → ./config`.

- **Entry**: `index.ts` default-exports `modelSync(pi: ExtensionAPI)`. The host loads it via `package.json` → `omp.extensions` / `pi.extensions: ["./index.ts"]`. `modelSync` is a registration entry only (about 25 lines). It sets the label when supported, registers the omp-only `before_subagent_spawn` hook (wrapped in try/catch because upstream pi lacks the event), registers the `tool_call` hook, and registers the `model-sync` command. Hook handlers, command dispatch, completion, and every `cmd*` handler live at module scope.
- **Config layer**: `config.ts` owns all config I/O using only Node builtins (`node:fs`, `node:os`, `node:path`); no host imports, no packages. It exports the union document type `ModelSyncConfig`, the layer read shape `LayerRead` (`config`, `error`, `exists`, `warnings`), the single active-projection policy `projectActiveProfiles`, preset helpers (`presetNames`, `getPresetProfiles`, `toPresetConfig`, `isValidPresetName`), and deep clones (`cloneProfiles`, `cloneConfig`).

**Spawn flow (hot path).** The `before_subagent_spawn` hook:

1. `readConfig(ctx.cwd)` never throws. It resolves the active layer, reads it, and returns the **active-preset projection** (`EffectiveConfig`: `{ activePreset?, profiles, warning? }`). A missing file is not an error and yields the projection of the legacy empty document. Any file/parse error or dangling selection yields zero profiles plus a warning (the spawn hook ignores the warning, so fail-closed routing is silent on this path).
2. `toModelRef(ctx.models.current())` → `{ provider, id }`.
3. `findProfile(config, ref)`: case-insensitive; `main` without `*` must equal `provider/id` or bare `id`; `*` is an explicit glob (crosses `/`, all other regex metachars escaped); **first match in the active preset's profile order wins**; no substring matching.
4. `pickSubagentSelector(profile, agentName)`: string form returns itself; object form tries the exact agent key, then the `"*"` default.
5. `ctx.models.resolve(selector)`: selectors pass through verbatim (`provider/id`, bare `id`, `@alias`, `:level` suffixes).
6. On success returns model as `[selector, ...originalPatterns]` (**originals stay as retry fallbacks**) plus routing note `pi-model-sync: <agent> → <model> (main: <main>)`.
7. **Invariant: this path must never throw.** Any failure returns `undefined` (no interception, default routing). Unresolvable selectors warn once per selector via the module-level `warnedSelectors` set.

**pi-subagent flow (`tool_call` hook).** Intercepts `@mjakl/pi-subagent`'s `subagent` tool:

1. Shape guard: `toolName === "subagent"` and `input.calls` is a non-empty array; other same-named tools are untouched.
2. For each call without an explicit `model`: **never overwrite** an explicit per-call model (decision 11); agent key matching is case-sensitive (exact key → `"*"` fallback).
3. `selectorResolvable(ctx, selector, snapshot)` (memoized per `tool_call` event): omp uses `ctx.models.resolve()`; upstream pi uses `piSelectorResolvable` against `ctx.modelRegistry` with a per-event `RegistrySnapshot`. The snapshot reads `getAvailable()`/`getAll()` once, caches results by the level-stripped base selector, and compares raw ids before reading providers. `@alias` → false, `:level` suffix stripped, glob `*` → pass through, `provider/id`/`bare id` via `find`/list; comparisons are case-sensitive on purpose because the child resolves ids exactly. No registry → undefined (pass through). Failed → skip with one-time TUI warning.
4. Injects `call.model = selector` via **dual write**: in-place mutation (upstream pi mechanism) AND returning `{ input }` (omp mechanism; re-validated against the tool schema, where `model` is a legal optional field). Same never-throw invariant.

**Command flow.** The command layer handles `/model-sync list|show|add|set|remove|move`, `/model-sync preset list|create|copy|rename|use|remove`, and `help`. All commands accept `--project`. Writes default to the **global** file; `--project` targets `getProjectConfigPath(cwd)` (`.omp`, falling back to `.pi` by existence as above); `preset list` always reports the active layer, so `--project` only affects writes. A missing target file is not an error; `loadForWrite` starts from the legacy empty document. It refuses a corrupt or structurally invalid existing file, surfaces parse warnings, and returns `cloneConfig(...)` (full-document deep clone). `loadActiveForWrite` additionally refuses `add`/`set`/`remove`/`move` when no preset is active or the active name dangles, printing the projection warning, available preset names, and `No changes were written (target: …)`. `saveConfig` writes and appends a shadow hint when a global write happens while a project file is active. Preset commands operate on the raw document (they do not require an active preset). `cmdPresetRename` rebuilds the preset map to preserve order and updates `activePreset` when the old name was active. `cmdMove` reorders the active preset and refuses edge moves.

**Command completion.** `pi.registerCommand("model-sync", …)` supplies `getArgumentCompletions`. It suggests the top-level subcommands, `preset` actions, profile `main` values and agent keys for `add`/`set`/`remove`/`move`, and existing preset names for `preset use`/`remove`/`copy`/`rename`. It reads the global target by default and the project target when `--project` is present. A typed `--project` flag is preserved in the completed value and is not suggested twice. It must never throw and returns `null` on unknown or malformed input. Completion uses `process.cwd()` because the host's completion signature does not include `ctx`.

**Config resolution precedence** (`config.ts`):

- Global path: env `PI_MODEL_SYNC_CONFIG` (highest; relative paths resolve against the session cwd via `getGlobalConfigPath(cwd)`; a leading `~/` expands to the home directory) → `PI_CODING_AGENT_DIR/pi-model-sync.json` (also expands `~/`) → `~/.omp/agent/pi-model-sync.json`; **dual-host fallback**: when the `~/.omp` file does not exist and `~/.pi/agent/pi-model-sync.json` does, the `.pi` path wins (write target stays `~/.omp` when neither exists).
- Project path: `<cwd>/.omp/pi-model-sync.json` (cwd only, no upward search); same isomorphic fallback to `<cwd>/.pi/pi-model-sync.json` by file existence.
- An existing project file **wholly replaces** the global file (even broken JSON counts as "exists"). No per-key merge. Each layer is a complete document with its own `presets` and `activePreset`, so preset selection is per layer and the global preset does not affect routing while a project file exists.

**Preset document model** (`config.ts`):

- Parse boundary `parseConfig` returns `{ config, error, warnings }` and never throws. A structurally invalid document (a non-object JSON root, mixing `profiles` with `presets`/`activePreset`, `activePreset` without `presets`, a non-array `profiles` value, non-object `presets`, a preset value that is not an array, a blank/whitespace/duplicate preset name, a non-string/non-null `activePreset` value, or a non-empty root object with neither `profiles` nor `presets`) returns the shared fail-closed `INVALID_CONFIG` (`{ presets: {} }`, null prototype) with a message. `readLayer` prefixes `Invalid config file (<path>): …`; a JSON syntax error yields `Could not parse config file (<path>): …`.
- An empty string or null `activePreset` is treated as unselected, not a structural error, so `preset use` can repair it.
- `normalizeProfiles` skips invalid entries and returns warnings (`Skipped profile …`). `list`, `show`, and `preset list` display them; `loadForWrite` warns before a rewrite drops them.
- `projectActiveProfiles` is the **only** active-selection policy: legacy → virtual `default` with its profiles; named without `activePreset` → `{ profiles: [], warning: "No active preset is selected; no profiles are active." }`; named with a dangling name → `{ profiles: [], warning: 'Active preset "<name>" does not exist; no profiles are active.' }`. Never falls back to another preset or to legacy.
- Preset names are single tokens (no whitespace), matched exactly and case-sensitively. A legacy document exposes the virtual `default`; `toPresetConfig` moves its profiles into `presets.default` with `activePreset: "default"`.

**Caching & writes**: reads cached by **mtime + ctime + size + inode** in module-level `layerCache`; the cache stores the raw parsed document plus warnings, not a projection, and consumers clone before editing. `EMPTY_CONFIG` is the legacy `{ profiles: [] }` shared by missing files; `INVALID_CONFIG` is the shared fail-closed named document for parse/structural errors. `statFile` uses `statSync(path, { throwIfNoEntry: false })` so a missing file does not throw ENOENT. At 64 entries, a new path evicts the oldest entry instead of clearing the whole cache. Glob patterns compile once in module-level `globCache`. Writes are atomic (`mkdir -p` → unique `<path>.<pid>.<timestamp>.tmp` → `renameSync`, tmp unlinked on failure), pass through `parseConfig`, refuse a structurally invalid document, preserve profile order, and invalidate the cache entry.

## Key Directories

- `.github/`: GitHub Actions workflows (`ci.yml`, `pr-title.yml`, `release-verify.yml`, `release-dry-run.yml`, `release.yml`), composite actions (`setup-toolchain`, `setup-npm`), isolated CI tool lockfile (`.github/omp-tools/`), Dependabot config, and PR template. The `pr-title` workflow uses `pull_request_target`; public repositories must allow that event in an Actions policy before 2026-12-02. The release workflow uses npm Trusted Publishing; enable `Allow npm publish` on the trusted publisher.
- `scripts/`: zero-dependency Node/Bun verification and release helpers (`typecheck.mjs`, `host-stub.d.ts`, `tsconfig.typecheck.json`, `test-load-graph.ts`, `test-packed.mjs`, `check-release-versions.mjs`, `bump-release.mjs`, `verify-release-tarball.mjs`, and `test-*.mjs` unit tests).
- `test/`: automated Bun behavioral tests (`portable.test.ts`, `posix.test.ts`).

`.github/CODEOWNERS` names the maintainer. Code-owner review stays off while the repository has one maintainer. The `Protect release tags` ruleset restricts `v*` tag creation to the maintainer bypass actor. For npm, require 2FA, disallow traditional publish tokens, and revoke unused automation tokens.

## Development Commands

`package.json` keeps **zero `dependencies` and zero root `devDependencies`**; there is intentionally no root `package-lock.json` or root `node_modules`. Install the isolated CI tools once with `npm ci --prefix .github/omp-tools`, then run `npm run check` (or `npm run check:portable` on Windows). The package ships `index.ts`, `config.ts`, and `llms.txt` via the `files` whitelist; npm adds `package.json`, `README.md`, and `LICENSE`.

Key scripts:

- `npm run check` / `npm run check:portable` / `npm run check:posix`
- `npm run typecheck`, `npm run check:versions`, `npm run test:release-scripts`, `npm run test:graph`, `npm run test:unit`, `npm run test:posix`, `npm run test:packed`
- `npm run release:bump <X.Y.Z>`

Load and exercise changes manually:

```bash
omp --extension /path/to/pi-model-sync          # one-off load
# or copy the directory to ~/.omp/agent/extensions/pi-model-sync/
# or add its path under `extensions:` in ~/.omp/agent/config.yml
```

Then in an omp session: run `/model-sync list|show|add ...` (and the `move` and `preset` subcommands) and spawn a subagent to verify routing. For isolated manual testing, point the config at a throwaway file: `PI_MODEL_SYNC_CONFIG=/tmp/test.json omp --extension ...`.

## Code Conventions & Common Patterns

- **Language of prose**: comments, JSDoc, README.md, and all user-facing strings (`notify`, command help/output, and config errors) are **English**. Comments reference numbered design decisions; the decision legend lives at the top of `index.ts`. Use the existing box-drawing section dividers.
- **Modules**: ESM; internal imports extensionless (`from "./config"`); Node builtins with `node:` prefix; the only external import is `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` (type-only, erased at runtime so either host loads it; declared as a `peerDependencies` wildcard per the Pi packaging convention, never bundled).
- **Naming**: camelCase functions/vars; PascalCase types; `cmd*` prefix for command sub-handlers; SCREAMING_CASE only for constants like `USAGE`; verb-first helper names (`extractAgentName`, `resolveActiveLayer`).
- **Host-facing types**: do NOT import host runtime types beyond `ExtensionAPI`. Extend the locally declared duck-typed interfaces (`ModelsFacade`, `ModelRegistryFacade`, `UiFacade`, `ExtensionContextLike`, `SubagentSpawnEvent`, `ToolCallEventLike`, `RegistrySnapshot`, `LayerView`) and narrow `unknown` payloads with `typeof`/`in`/`Array.isArray` guards. Never use `any`.
- **Error handling**: the spawn and `tool_call` paths catch and return `undefined`. The command handler catches errors and reports `err.message` through `notify`. `writeConfig` may throw on I/O failure or a structurally invalid document; the command handler surfaces it. No `console.*` or `process.exit`. `notify(ctx, message, level)` uses `info`, `warning`, or `error`.
- **Types**: explicit return types everywhere; `unknown` + guards; no enums, generics, or decorators; standard TS only. `scripts/typecheck.mjs` checks `config.ts` and `index.ts` via `scripts/tsconfig.typecheck.json` and `scripts/host-stub.d.ts` under `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- **Async**: only the command handler is async; all config I/O is synchronous `node:fs`; no top-level await.
- **Mutation safety**: `loadForWrite` deep-clones the entire document (`cloneConfig` → `cloneProfiles` + null-prototype `cloneSubagentMap`), so editing one preset can never mutate cached sibling presets; `cmdSet`/`cmdRemove` clone the subagents map before editing; `cmdPresetCopy` clones the source list (`cloneProfiles`); `toPresetConfig` clones legacy profiles; `cmdPresetRename` moves lists within the cloned document. Cache reads return shared nested maps, so clone before editing.
- **Command semantics to preserve**: profile lookup by `main` is case-insensitive; `set <main> * <model>` updates the profile default while preserving per-agent entries (collapsing to a plain string only when no per-agent entry exists); removing entries until only `*` remains collapses back to the plain string; removing the last agent key deletes the whole profile; subcommands reject extra arguments with a usage hint; `pickSubagentSelector` semantics (exact key → `*` fallback) must stay consistent with command-side edits; `add`/`set`/`remove`/`move` mutate only the active preset and `loadActiveForWrite` refuses when none is active; preset names must be single tokens; `preset create` creates an empty inactive preset and never switches; `preset copy` deep-copies without switching and refuses an existing target name; `preset rename` preserves order and updates the active name; `preset use` is a no-op when the name is already active; `preset remove` refuses the active preset; the first successful create/copy/rename on a legacy document converts it; `move` refuses edge moves.
- **Reader-load rules**: `modelSync` is registration only; handlers, completion, and the layer view are module scope. Prefer `loadActiveLayerView`/`appendLayerSummary` over re-reading and re-projecting a layer in each command. Avoid one-caller wrapper helpers; inline tiny formatting.

## Important Files

| Path | Role |
|---|---|
| `index.ts` | Extension entry: `modelSync(pi)` registration, `handleBeforeSubagentSpawn`, `handleToolCall`, command dispatch, completion, `cmdList`/`cmdShow`/`cmdAdd`/`cmdSet`/`cmdRemove`/`cmdMove`, `cmdPreset*`, `loadForWrite`/`loadActiveForWrite`, `saveConfig` |
| `config.ts` | Config layer: path resolution, layer precedence, `LayerRead`, mtime+ctime+size+inode cache, atomic `writeConfig`, union `ModelSyncConfig` parsing (`parseConfig`), warnings, active projection (`projectActiveProfiles`), preset helpers (`presetNames`, `getPresetProfiles`, `toPresetConfig`, `isValidPresetName`), deep clones (`cloneProfiles`, `cloneConfig`), `findProfile` matching, `pickSubagentSelector` |
| `package.json` | Package manifest; `files` whitelist; `omp.extensions` / `pi.extensions: ["./index.ts"]`; zero runtime/root dev dependencies; CI/release `scripts` |
| `README.md` | Sole user documentation (English): install, preset/legacy config schema, active-preset selection and fail-closed behavior, matching rules, command table. **Update it with any behavior change** |
| `llms.txt` | Agent-facing doc index (llmstxt.org convention): what the project is, install commands per host, minimal preset config, command summary. Keep in sync with README when install/config/command changes |
| `CHANGELOG.md` | Release history in `## X.Y.Z — YYYY-MM-DD` format; validated on release and used to generate GitHub release notes |
| `CONTRIBUTING.md` | Contributor guide: local CI setup, PR rules, branch protection, release runbook, and style conventions |
| `.github/workflows/` | PR/push CI (`ci.yml`, `pr-title.yml`) and tag-driven release pipeline (`release.yml`, `release-verify.yml`, `release-dry-run.yml`) |
| `.github/omp-tools/` | Isolated CI tool dependencies (`@oh-my-pi/pi-coding-agent`, `typescript`, `@types/node`) with lockfile, excluded from package root |
| `scripts/` | Verification (`typecheck.mjs`, `test-load-graph.ts`, `test-packed.mjs`) and release tooling (`check-release-versions.mjs`, `bump-release.mjs`, `verify-release-tarball.mjs`, plus `node:test` suites) |
| `test/` | Behavioral test suites (`portable.test.ts` and `posix.test.ts`) run via `bun test` |
| `~/.omp/agent/pi-model-sync.json` | Global config (runtime artifact, not in repo) |
| `<cwd>/.omp/pi-model-sync.json` | Project config (runtime artifact, replaces global wholesale) |

## Runtime/Tooling Preferences

- **Runtime: Bun**: the omp host runs on Bun and executes the TypeScript sources directly; no build step, by design.
- **Zero runtime/root dependencies**: `config.ts` and `index.ts` use Node builtins only; there is no root `package-lock.json` and no root `node_modules`. Isolated CI tools (`typescript`, `@types/node`, `@oh-my-pi/pi-coding-agent`) live only in `.github/omp-tools/`. Adding a runtime dependency is a design change, not a routine edit.
- Code uses **Node-compatible APIs only** (no `Bun.file`, Bun shell, or `import.meta`); keep new code on `node:` builtins so it stays host-portable.
- `@earendil-works/pi-coding-agent` is an ambient host-supplied module on both hosts (omp forks the same `ExtensionAPI` surface); `scripts/host-stub.d.ts` provides its type-only contract for `npm run typecheck`.

## Testing & QA

Automated verification runs via `npm run check` (`npm run check:portable` + `npm run check:posix` on Ubuntu/macOS; `npm run check:portable` on Windows), covering strict typechecking, version consistency, release helper `node:test` suites, runtime load-graph/import checks, Bun behavioral suites (`test/portable.test.ts`, `test/posix.test.ts`), and packed-tarball installation + isolated-home `omp` loading (`scripts/test-packed.mjs`).

Manual TUI verification under a real host (`omp` and/or upstream `pi`, pointing `PI_MODEL_SYNC_CONFIG` at a throwaway file) should still cover interactive UX when changing user-facing behavior:

1. Load the extension with `omp --extension <repo path>` (and/or upstream pi), pointing `PI_MODEL_SYNC_CONFIG` at a throwaway file, never a real user config.
2. Exercise `/model-sync add|set|list|show|remove|move` on a legacy file (with and without `--project`), then `preset list|create|copy|rename|use|remove`; confirm the first create/copy converts the file to `presets.default` with `activePreset: "default"`, that create/copy/rename leave the active profiles unchanged, that removing the active preset is refused, and that copying onto an existing name is refused.
3. First-run check: point at a missing file and run `/model-sync list` and `/model-sync preset list`; confirm onboarding instead of an error, then write and confirm the file is created.
4. Completion check: `--project` preservation, no duplicate flag, `preset copy` trailing space, and add/set/remove/move suggestions.
5. Fail-closed checks: remove `activePreset` or point it at a missing name; confirm no interception, warnings in `list`/`show`, and add/set/remove/move refusal. Set `activePreset` to `""` or `null` and confirm `preset use` repairs it. Hand-edit a mixed document, a typo-only root, and a non-array `profiles`; confirm the config error and write refusal.
6. Perf checks: a missing-config read loop and a multi-selector upstream `tool_call` batch; confirm no ENOENT throw path and one registry listing per event.
7. Spot-check invariants from this guide: never-throwing spawn path, whole-file project-over-global replacement with independent per-layer active presets, atomic writes + cache invalidation, deep-clone isolation between presets, and, when an older build is available, that it reads a preset file as empty and rewrites it as legacy.

When changing behavior, update `README.md`, `llms.txt`, and `AGENTS.md` (English) in the same change.
