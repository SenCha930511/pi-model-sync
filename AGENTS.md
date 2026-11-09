# Repository Guidelines

## Project Overview

pi-model-sync is a **dual-host coding-agent extension (omp / upstream pi)** that routes the model used by newly spawned subagents (task / eval `agent()` / workpool workers) and by `@mjakl/pi-subagent` `subagent` tool calls, based on the *spawning session's current model*, via a two-layer JSON config holding named presets (one active preset per layer). It also exposes a `/model-sync` slash command to manage profiles and presets. Not a CLI, not a library — loaded and executed by the host. MIT license, v0.3.1, published to npm as `@sencha930511/pi-model-sync`.

Key behaviors: running subagents never switch models mid-flight; nested spawns are intercepted using the spawning session's own model; selectors that fail to resolve fall through to default routing with a one-time TUI warning; an explicit per-call `model` in a pi-subagent call is never overwritten (frontmatter-level defaults are overridden by injection on purpose). Config documents are either legacy `{ profiles }` or named `{ activePreset?, presets }`; only the active preset's ordered profile list routes, and a missing or dangling active preset fails closed — no routing, never a fallback — with the reason surfaced by `/model-sync list|show`. `add`/`set`/`remove` edit only the active preset; the first successful `preset create`/`preset copy` converts a legacy document to `presets.default`; every write path deep-clones the whole document.

## Architecture & Data Flow

Flat two-module design; only inter-file dependency is `index.ts → ./config`.

- **Entry**: `index.ts` default-exports `modelSync(pi: ExtensionAPI)` — loaded by the host via `package.json` → `omp.extensions` / `pi.extensions: ["./index.ts"]`. It registers three things: a `before_subagent_spawn` hook (omp-only; registration wrapped in try/catch since upstream pi lacks the event), a `tool_call` hook (pi-subagent interception), and the `model-sync` command (`list`, `show`, `add`, `set`, `remove`, plus the `preset` group: `list`, `create`, `copy`, `use`, `remove`). All command handlers are closures inside `modelSync`.
- **Config layer**: `config.ts` owns all config I/O using only Node builtins (`node:fs`, `node:os`, `node:path`); no host imports, no packages. It exports the union document type `ModelSyncConfig` (`{ profiles }` | `{ activePreset?: string; presets }`), the single active-projection policy `projectActiveProfiles`, preset helpers (`presetNames`, `getPresetProfiles`, `toPresetConfig`), and deep clones (`cloneProfiles`, `cloneConfig`).

**Spawn flow (hot path)** — `before_subagent_spawn` hook:

1. `readConfig(ctx.cwd)` — never throws; resolves the active layer, reads it, and returns the **active-preset projection** (`EffectiveConfig`: `{ activePreset?, profiles, warning? }`). Any file/parse error or dangling selection yields zero profiles plus a warning (the spawn hook ignores the warning, so fail-closed routing is silent on this path).
2. `toModelRef(ctx.models.current())` → `{ provider, id }`.
3. `findProfile(config, ref)` — case-insensitive; `main` without `*` must equal `provider/id` or bare `id`; `*` is an explicit glob (crosses `/`, all other regex metachars escaped); **first match in the active preset's profile order wins**; no substring matching.
4. `pickSubagentSelector(profile, agentName)` — string form returns itself; object form tries exact agent key, then `"*"` default.
5. `ctx.models.resolve(selector)` — selectors pass through verbatim (`provider/id`, bare `id`, `@alias`, `:level` suffixes).
6. On success returns model as `[selector, ...originalPatterns]` — **originals stay as retry fallbacks** — plus routing note `pi-model-sync: <agent> → <model> (main: <main>)`.
7. **Invariant: this path must never throw.** Any failure returns `undefined` (no interception, default routing). Unresolvable selectors warn once per selector via module-level `warnedSelectors` set.

**pi-subagent flow (`tool_call` hook)** — intercepts `@mjakl/pi-subagent`'s `subagent` tool:

1. Shape guard: `toolName === "subagent"` and `input.calls` is a non-empty array; other same-named tools are untouched.
2. For each call without an explicit `model`**: never overwrite** an explicit per-call model (decision 11); agent key matching is case-sensitive (exact key → `"*"` fallback).
3. `selectorResolvable(ctx, selector)` (memoized per `tool_call` event): omp uses `ctx.models.resolve()`; upstream pi uses `piSelectorResolvable` against `ctx.modelRegistry` (`@alias` → false, `:level` suffix stripped, glob `*` → pass through, `provider/id`/`bare id` via `find`/`getAvailable`; comparisons case-sensitive on purpose — the child resolves ids exactly); no registry → undefined (pass through). Failed → skip with one-time TUI warning.
4. Injects `call.model = selector` via **dual write**: in-place mutation (upstream pi mechanism) AND returning `{ input }` (omp mechanism; re-validated against the tool schema — `model` is a legal optional field). Same never-throw invariant.

**Command flow** — `/model-sync list|show|add|set|remove` plus `/model-sync preset list|create|copy|use|remove`, all accept `--project`. Writes default to the **global** file; `--project` targets `getProjectConfigPath(cwd)` (`.omp`, falling back to `.pi` by existence as above); `preset list` always reports the active layer, so `--project` only affects writes. `loadForWrite` refuses to write when the target file exists but its JSON is corrupt or structurally invalid, and returns `cloneConfig(...)` (full-document deep clone). `loadActiveForWrite` additionally refuses `add`/`set`/`remove` when no preset is active or the active name dangles, printing the projection warning and `No changes were written (target: …)`. Preset commands operate on the raw document (they do not require an active preset); `cmdPresetCreate`/`cmdPresetCopy` convert a legacy document via `toPresetConfig` when needed.

**Config resolution precedence** (`config.ts`):

- Global path: env `PI_MODEL_SYNC_CONFIG` (highest; relative paths resolve against the session cwd via `getGlobalConfigPath(cwd)` — process cwd fallback — and it also covers named omp profiles) → `PI_CODING_AGENT_DIR/pi-model-sync.json` → `~/.omp/agent/pi-model-sync.json`; **dual-host fallback**: when the `~/.omp` file does not exist and `~/.pi/agent/pi-model-sync.json` does, the `~/.pi` path wins (write target stays `~/.omp` when neither exists).
- Project path: `<cwd>/.omp/pi-model-sync.json` — **cwd only, no upward search**; same isomorphic fallback from `~/.omp` to `<cwd>/.pi/pi-model-sync.json` by file existence.
- An existing project file **wholly replaces** the global file (even broken JSON counts as "exists, no profiles"). No per-key merge — preserve this when editing. Each layer is a complete document with its own `presets` and `activePreset`, so preset selection is per layer and the global preset does not affect routing while a project file exists.

**Preset document model** (`config.ts`):

- Parse boundary `parseConfig` returns `{ config, error }` and never throws. A structurally invalid document (a non-object JSON root, mixing `profiles` with `presets`/`activePreset`, `activePreset` without `presets`, non-object `presets`, a preset value that is not an array, or a blank/whitespace/duplicate preset name) returns the shared fail-closed `INVALID_CONFIG` (`{ presets: {} }`, null prototype) with a message; `readLayer` prefixes `Invalid config file (<path>): …`, while a JSON syntax error yields `Could not parse config file (<path>): …`. `normalizeConfig` is the same parser for writes, so a malformed document can never be persisted.
- `projectActiveProfiles` is the **only** active-selection policy: legacy → virtual `default` with its profiles; named without `activePreset` → `{ profiles: [], warning: "No active preset is selected; no profiles are active." }`; named with a dangling name → `{ profiles: [], warning: 'Active preset "<name>" does not exist; no profiles are active.' }`. Never falls back to another preset or to legacy.
- Preset names are single tokens (no whitespace), matched exactly and case-sensitively. A legacy document exposes the virtual `default`; `toPresetConfig` moves its profiles into `presets.default` with `activePreset: "default"`.

**Caching & writes**: reads cached by **mtime + size** in module-level `layerCache` (mtime alone can collide when a writer swaps content in the same millisecond); the cache stores the **raw parsed document**, not a projection, and consumers clone before editing. `EMPTY_CONFIG` is the legacy `{ profiles: [] }` shared by missing files (keeps fresh writes downgrade-compatible); `INVALID_CONFIG` is the shared fail-closed named document for parse/structural errors. Glob patterns compile once in module-level `globCache`; writes are atomic (`mkdir -p` → unique `<path>.<pid>.<timestamp>.tmp` → `renameSync`, tmp unlinked on failure), pass through `normalizeConfig` (drops blank/non-string entries, trims, preserves profile order), and must invalidate the cache entry (`layerCache.delete`).

## Key Directories

None — the repo is flat (9 tracked files). See **Important Files**.

## Development Commands

`package.json` has **no `scripts`, no dependencies, no devDependencies** — no install, build, lint, or test commands exist. Do not run `npm install`/`bun install`; there is intentionally no lockfile or `node_modules`.

Load and exercise changes manually:

```bash
omp --extension /path/to/pi-model-sync          # one-off load
# or copy the directory to ~/.omp/agent/extensions/pi-model-sync/
# or add its path under `extensions:` in ~/.omp/agent/config.yml
```

Then in an omp session: run `/model-sync list|show|add ...` (and the `preset list|create|copy|use|remove` subcommands) and spawn a subagent to verify routing. For isolated manual testing, point the config at a throwaway file: `PI_MODEL_SYNC_CONFIG=/tmp/test.json omp --extension ...`.

## Code Conventions & Common Patterns

- **Language of prose**: comments, JSDoc, README.md, and all user-facing strings (`notify`, command help/output, and config errors) are **English** — match when editing. Comments reference numbered design decisions (e.g. "decision 3", "decision 8"); keep that style, and use the existing box-drawing section dividers.
- **Modules**: ESM; internal imports extensionless (`from "./config"`); Node builtins with `node:` prefix; the only external import is `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` (type-only, erased at runtime so either host loads it; declared as a `peerDependencies` wildcard per the Pi packaging convention — never bundle it).
- **Naming**: camelCase functions/vars; PascalCase types; `cmdList`/`cmdShow`/... prefix for command sub-handlers; SCREAMING_CASE only for constants like `USAGE`; verb-first helper names (`extractAgentName`, `resolveActiveLayer`).
- **Host-facing types**: do NOT import host runtime types beyond `ExtensionAPI`. Extend the locally declared duck-typed interfaces (`ModelsFacade`, `ModelRegistryFacade`, `UiFacade`, `ExtensionContextLike`, `SubagentSpawnEvent`, `ToolCallEventLike`) and narrow `unknown` payloads with `typeof`/`in`/`Array.isArray` guards — never `any`.
- **Error handling — two tiers**: spawn hook path uses try/catch and returns `undefined` (`readLayer` returns `{ config, error }` instead of throwing); command path surfaces `err.message` via the single `notify(ctx, msg)` helper. No `throw`, no `console.*`, no `process.exit` anywhere — all feedback goes through `ctx.ui.notify`.
- **Types**: explicit return types everywhere; `unknown` + guards; no enums, generics, or decorators; standard TS only (no tsconfig-dependent features — there is no tsconfig).
- **Async**: minimal — only the command handler is async; all config I/O is synchronous `node:fs`; no top-level await.
- **Mutation safety**: `loadForWrite` deep-clones the entire document (`cloneConfig` → `cloneProfiles` + null-prototype `cloneSubagentMap`), so editing one preset can never mutate cached sibling presets; `cmdSet`/`cmdRemove` clone the subagents map before editing; `cmdPresetCopy` clones the source list (`cloneProfiles`); `toPresetConfig` clones legacy profiles. Cache reads return shared nested maps — clone before editing.
- **Command semantics to preserve**: profile lookup by `main` is case-insensitive; `set <main> * <model>` updates the profile default while preserving per-agent entries (collapsing to a plain string only when no per-agent entry exists); removing entries until only `*` remains collapses back to the plain string; removing the last agent key deletes the whole profile; subcommands reject extra arguments with a usage hint; `pickSubagentSelector` semantics (exact key → `*` fallback) must stay consistent with command-side edits; `add`/`set`/`remove` mutate only the active preset and `loadActiveForWrite` refuses when none is active; preset names must be single tokens; `preset create` creates an empty inactive preset and never switches (on legacy it refuses the virtual `default`, converts, and keeps `default` active); `preset copy` deep-copies without switching and refuses an existing target name; `preset use` is a no-op when the name is already active; `preset remove` refuses the active preset; the first successful create/copy on a legacy document converts it.

## Important Files

| Path | Role |
|---|---|
| `index.ts` | Extension entry: `modelSync(pi)`, spawn-routing hook, `/model-sync` command (`cmdList`/`cmdShow`/`cmdAdd`/`cmdSet`/`cmdRemove`, `cmdPresetList`/`cmdPresetCreate`/`cmdPresetCopy`/`cmdPresetUse`/`cmdPresetRemove`, `loadForWrite`/`loadActiveForWrite`) |
| `config.ts` | Config layer: path resolution, layer precedence, mtime+size cache, atomic `writeConfig`, union `ModelSyncConfig` parsing (`parseConfig`), active projection (`projectActiveProfiles`), preset helpers (`presetNames`, `getPresetProfiles`, `toPresetConfig`), deep clones (`cloneProfiles`, `cloneConfig`), `findProfile` matching, `pickSubagentSelector` |
|`package.json`|Minimal manifest; `omp.extensions` / `pi.extensions: ["./index.ts"]` are the host load declarations|
|`README.md`|Sole user documentation (English): install, preset/legacy config schema, active-preset selection and fail-closed behavior, matching rules, command table — **update it with any behavior change**|
|`llms.txt`|Agent-facing doc index (llmstxt.org convention): what the project is, install commands per host, minimal preset config, command summary — keep in sync with README when install/config/command changes|
|`CONTRIBUTING.md`|Contributor guide: verification expectations (bun import check), PR and style conventions|
| `~/.omp/agent/pi-model-sync.json` | Global config (runtime artifact, not in repo) |
| `<cwd>/.omp/pi-model-sync.json` | Project config (runtime artifact, replaces global wholesale) |

## Runtime/Tooling Preferences

- **Runtime: Bun** — the omp host runs on Bun and executes the TypeScript sources directly; no build step, by design.
- **Zero dependencies** — config.ts uses Node builtins only; there is no lockfile and no `node_modules`. Adding a dependency is a design change, not a routine edit.
- Code uses **Node-compatible APIs only** (no `Bun.file`, Bun shell, or `import.meta`); keep new code on `node:` builtins so it stays host-portable.
- `@earendil-works/pi-coding-agent` is an ambient host-supplied module on both hosts (omp forks the same `ExtensionAPI` surface); a standalone `tsc --noEmit` cannot resolve it — that is expected, not an error to fix by adding deps.

## Testing & QA

**No QA infrastructure exists**: no test files, no test framework or runner, no coverage tooling, no lint/format configs, no CI, no tsconfig, no git hooks beyond stock samples. Do not fabricate `test`/`lint` commands.

Verification is manual and behavioral. The only scripted check is the import smoke check documented in `CONTRIBUTING.md`; there is no test runner, so never present it as a test suite.

1. Load the extension with `omp --extension <repo path>` (and/or upstream pi), pointing `PI_MODEL_SYNC_CONFIG` at a throwaway file — never a real user config.
2. Exercise `/model-sync add|set|list|show|remove` on a legacy file (with and without `--project`), then `preset list|create|copy|use|remove`; confirm the first create/copy converts the file to `presets.default` with `activePreset: "default"`, that create/copy leave the active profiles unchanged, that removing the active preset is refused, and that copying onto an existing name is refused.
3. Switch the session model, spawn a subagent, and confirm the routing note `pi-model-sync: <agent> → <model> (main: <main>)` appears and the spawned model follows the active preset.
4. Fail-closed checks: remove `activePreset` or point it at a missing name; confirm no interception (default routing), that `/model-sync list` and `show` print the warning, and that `add`/`set`/`remove` refuse to write. Hand-edit a mixed `profiles` + `presets` document and confirm the config error and write refusal.
5. Spot-check invariants from this guide: never-throwing spawn path, whole-file project-over-global replacement with independent per-layer active presets, atomic writes + cache invalidation, deep-clone isolation between presets, and — when an older build is available — that it reads a preset file as empty and rewrites it as legacy.

When changing behavior, update `README.md` and `llms.txt` (English) in the same change.
