# Repository Guidelines

## Project Overview

pi-model-sync is a **dual-host coding-agent extension (omp / upstream pi)** that routes the model used by newly spawned subagents (task / eval `agent()` / workpool workers) and by `@mjakl/pi-subagent` `subagent` tool calls, based on the *spawning session's current model*, via a two-layer JSON profile table. It also exposes a `/model-sync` slash command to manage profiles. Not a CLI, not a library — loaded and executed by the host. MIT license, v0.1.0, `private: true` (never published).

Key behaviors: running subagents never switch models mid-flight; nested spawns are intercepted using the spawning session's own model; selectors that fail to resolve fall through to default routing with a one-time TUI warning; an explicit per-call `model` in a pi-subagent call is never overwritten (frontmatter-level defaults are overridden by injection on purpose).

## Architecture & Data Flow

Flat two-module design; only inter-file dependency is `index.ts → ./config`.

- **Entry**: `index.ts` default-exports `modelSync(pi: ExtensionAPI)` — loaded by the host via `package.json` → `omp.extensions` / `pi.extensions: ["./index.ts"]`. It registers three things: a `before_subagent_spawn` hook (omp-only; registration wrapped in try/catch since upstream pi lacks the event), a `tool_call` hook (pi-subagent interception), and the `model-sync` command. All command handlers are closures inside `modelSync`.
- **Config layer**: `config.ts` owns all config I/O using only Node builtins (`node:fs`, `node:os`, `node:path`); no host imports, no packages.

**Spawn flow (hot path)** — `before_subagent_spawn` hook:

1. `readConfig(ctx.cwd)` — never throws; returns empty config on any failure.
2. `toModelRef(ctx.models.current())` → `{ provider, id }`.
3. `findProfile(config, ref)` — case-insensitive; `main` without `*` must equal `provider/id` or bare `id`; `*` is an explicit glob (crosses `/`, all other regex metachars escaped); **first match in file order wins**; no substring matching.
4. `pickSubagentSelector(profile, agentName)` — string form returns itself; object form tries exact agent key, then `"*"` default.
5. `ctx.models.resolve(selector)` — selectors pass through verbatim (`provider/id`, bare `id`, `@alias`, `:level` suffixes).
6. On success returns model as `[selector, ...originalPatterns]` — **originals stay as retry fallbacks** — plus routing note `pi-model-sync: <agent> → <model> (main: <main>)`.
7. **Invariant: this path must never throw.** Any failure returns `undefined` (no interception, default routing). Unresolvable selectors warn once per selector via module-level `warnedSelectors` set.

**pi-subagent flow (`tool_call` hook)** — intercepts `@mjakl/pi-subagent`'s `subagent` tool:

1. Shape guard: `toolName === "subagent"` and `input.calls` is a non-empty array; other same-named tools are untouched.
2. For each call without an explicit `model`**: never overwrite** an explicit per-call model (decision 11); agent key matching is case-sensitive (exact key → `"*"` fallback).
3. `selectorResolvable(ctx, selector)`: omp uses `ctx.models.resolve()`; upstream pi uses `piSelectorResolvable` against `ctx.modelRegistry` (`@alias` → false, `:level` suffix stripped, glob `*` → pass through, `provider/id`/`bare id` via `find`/`getAvailable`); no registry → undefined (pass through). Failed → skip with one-time TUI warning.
4. Injects `call.model = selector` via **dual write**: in-place mutation (upstream pi mechanism) AND returning `{ input }` (omp mechanism; re-validated against the tool schema — `model` is a legal optional field). Same never-throw invariant.

**Command flow** — `/model-sync list|show|add|set|remove`, all accept `--project`. Writes default to the **global** file; `--project` targets `getProjectConfigPath(cwd)` (`.omp`, falling back to `.pi` by existence as above). `loadForWrite` refuses to write when the target file exists but its JSON is corrupt.

**Config resolution precedence** (`config.ts`):

- Global path: env `PI_MODEL_SYNC_CONFIG` (highest; relative paths resolve against cwd, and it also covers named omp profiles) → `PI_CODING_AGENT_DIR/pi-model-sync.json` → `~/.omp/agent/pi-model-sync.json`; **dual-host fallback**: when the `~/.omp` file does not exist and `~/.pi/agent/pi-model-sync.json` does, the `~/.pi` path wins (write target stays `~/.omp` when neither exists).
- Project path: `<cwd>/.omp/pi-model-sync.json` — **cwd only, no upward search**; same isomorphic fallback from `~/.omp` to `<cwd>/.pi/pi-model-sync.json` by file existence.
- An existing project file **wholly replaces** the global file (even broken JSON counts as "exists, no profiles"). No per-key merge — preserve this when editing.

**Caching & writes**: reads cached by mtime in module-level `layerCache`; writes are atomic (`mkdir -p` → `<path>.tmp` → `renameSync`) and must invalidate the cache entry (`layerCache.delete`). All JSON, read or written, passes through `normalizeConfig` (drops blank/non-string entries, trims, preserves order).

## Key Directories

None — the repo is flat (6 tracked files). See **Important Files**.

## Development Commands

`package.json` has **no `scripts`, no dependencies, no devDependencies** — no install, build, lint, or test commands exist. Do not run `npm install`/`bun install`; there is intentionally no lockfile or `node_modules`.

Load and exercise changes manually:

```bash
omp --extension /path/to/pi-model-sync          # one-off load
# or copy the directory to ~/.omp/agent/extensions/pi-model-sync/
# or add its path under `extensions:` in ~/.omp/agent/config.yml
```

Then in an omp session: run `/model-sync list|show|add ...` and spawn a subagent to verify routing. For isolated manual testing, point the config at a throwaway file: `PI_MODEL_SYNC_CONFIG=/tmp/test.json omp --extension ...`.

## Code Conventions & Common Patterns

- **Language of prose**: comments, JSDoc, README.md, and all user-facing strings (`notify`, command help/output, and config errors) are **English** — match when editing. Comments reference numbered design decisions (e.g. "decision 3", "decision 8"); keep that style, and use the existing box-drawing section dividers.
- **Modules**: ESM; internal imports extensionless (`from "./config"`); Node builtins with `node:` prefix; the only external import is `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` (type-only, erased at runtime so either host loads it; declared as a `peerDependencies` wildcard per the Pi packaging convention — never bundle it).
- **Naming**: camelCase functions/vars; PascalCase types; `cmdList`/`cmdShow`/... prefix for command sub-handlers; SCREAMING_CASE only for constants like `USAGE`; verb-first helper names (`extractAgentName`, `resolveActiveLayer`).
- **Host-facing types**: do NOT import host runtime types beyond `ExtensionAPI`. Extend the locally declared duck-typed interfaces (`ModelsFacade`, `ModelRegistryFacade`, `UiFacade`, `ExtensionContextLike`, `SubagentSpawnEvent`, `ToolCallEventLike`) and narrow `unknown` payloads with `typeof`/`in`/`Array.isArray` guards — never `any`.
- **Error handling — two tiers**: spawn hook path uses try/catch and returns `undefined` (`readLayer` returns `{ config, error }` instead of throwing); command path surfaces `err.message` via the single `notify(ctx, msg)` helper. No `throw`, no `console.*`, no `process.exit` anywhere — all feedback goes through `ctx.ui.notify`.
- **Types**: explicit return types everywhere; `unknown` + guards; no enums, generics, or decorators; standard TS only (no tsconfig-dependent features — there is no tsconfig).
- **Async**: minimal — only the command handler is async; all config I/O is synchronous `node:fs`; no top-level await.
- **Mutation safety**: commands deep-copy before mutating (`loadForWrite` rebuilds profiles; `cmdSet`/`cmdRemove` spread the subagents map). Cache reads return shared nested maps — clone before editing.
- **Command semantics to preserve**: profile lookup by `main` is case-insensitive; `set <main> * <model>` collapses the map to a plain string; removing the last agent key deletes the whole profile; `pickSubagentSelector` semantics (exact key → `*` fallback) must stay consistent with command-side edits.

## Important Files

| Path | Role |
|---|---|
| `index.ts` | Extension entry: `modelSync(pi)`, spawn-routing hook, `/model-sync` command (`cmdList`/`cmdShow`/`cmdAdd`/`cmdSet`/`cmdRemove`) |
| `config.ts` | Config layer: path resolution, layer precedence, mtime cache, atomic `writeConfig`, `findProfile` matching, `pickSubagentSelector`, `normalizeConfig` |
|`package.json`|Minimal manifest; `omp.extensions` / `pi.extensions: ["./index.ts"]` are the host load declarations|
|`README.md`|Sole documentation (English): install, config schema, matching rules, command table — **update it with any behavior change**|
|`llms.txt`|Agent-facing doc index (llmstxt.org convention): what the project is, install commands per host, minimal config — keep in sync with README when install/config changes|
| `~/.omp/agent/pi-model-sync.json` | Global config (runtime artifact, not in repo) |
| `<cwd>/.omp/pi-model-sync.json` | Project config (runtime artifact, replaces global wholesale) |

## Runtime/Tooling Preferences

- **Runtime: Bun** — the omp host runs on Bun and executes the TypeScript sources directly; no build step, by design.
- **Zero dependencies** — config.ts uses Node builtins only; there is no lockfile and no `node_modules`. Adding a dependency is a design change, not a routine edit.
- Code uses **Node-compatible APIs only** (no `Bun.file`, Bun shell, or `import.meta`); keep new code on `node:` builtins so it stays host-portable.
- `@earendil-works/pi-coding-agent` is an ambient host-supplied module on both hosts (omp forks the same `ExtensionAPI` surface); a standalone `tsc --noEmit` cannot resolve it — that is expected, not an error to fix by adding deps.

## Testing & QA

**No QA infrastructure exists**: no test files, no test framework or runner, no coverage tooling, no lint/format configs, no CI, no tsconfig, no git hooks beyond stock samples. Do not fabricate `test`/`lint` commands.

Verification is manual and behavioral:

1. Load the extension with `omp --extension <repo path>`.
2. Exercise `/model-sync add|set|list|show|remove` (with and without `--project`).
3. Switch the session model, spawn a subagent, and confirm the routing note `pi-model-sync: <agent> → <model> (main: <main>)` appears and the spawned model follows the profile.
4. Spot-check invariants from this guide: never-throwing spawn path, whole-file project-over-global replacement, atomic writes + cache invalidation, fallback chain preserved.

When changing behavior, update `README.md` (English) in the same change.
