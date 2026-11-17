# Changelog

## 0.6.1 — 2026-11-17

- Add per-session routing controls: `use-session`, `pause`, `resume`, `status`, `log`, `doctor`, and `init`.
- Add `agentMatch: "case-insensitive"`, dialect-aware `show`, and model-aware completion for `add`, `show`, and `set`.
- Split the extension into `resolver.ts`, `session.ts`, `hooks.ts`, `completions.ts`, and `commands.ts`; `index.ts` is registration only.
- Harden selector resolution for slash-containing bare ids, upstream configured-auth checks, omp bare-id uniqueness, and multi-pattern explicit models.
- Write `tool_call` input once in place, follow symlinks on config writes, warn on unknown keys, and keep warning dedupe per session.
- Add the installed-host contract probe, packed upstream pi RPC command execution, and a per-file coverage ratchet.
- Fix status-bar layer and revival, `add`/`show` completion, requested-provider plugin checks, doctor glob and layer diagnostics, corrupt `init` files, route-log gaps, and `getAll()`-only auth filtering.
## 0.6.0 — 2026-11-16

- Route subagent models for `pi-subagents` (nicobailon), `@tintinweb/pi-subagents`, `@gotgenes/pi-subagents`, `pi-interactive-subagents` (HazAT), and `edxeth/pi-subagents` alongside `@mjakl/pi-subagent`.
- Detect the plugin from its registered tool schema (`pi.getAllTools()`), with a stricter call-shape fallback for hosts without it; never overwrite an explicit model and never inject into resume or management calls.
- Split a `:level` selector into a `thinking` field for plugins that do not parse the suffix, and skip `@alias`, glob, or bare-id selectors that the target plugin cannot resolve.

## 0.5.0 — 2026-11-16

- Treat a missing config file as a first-run state where `list` and `preset list` show onboarding hints instead of errors.
- Report structural config errors for typo-only roots, non-array `profiles`, invalid preset values, and invalid `activePreset` types, while skipping invalid profile entries with warnings.
- Treat `activePreset: ""` or `null` as unselected so `/model-sync preset use` can repair the selection.
- Preserve `--project` in command argument completions without suggesting it twice, and complete profile `main` values and agent keys for `add`, `set`, `remove`, and `move`.
- Add `/model-sync move`, `/model-sync preset rename`, `/model-sync show [model] [agent]`, `/model-sync help`, `/model-sync preset help`, and shadow warnings on global writes when a project config is active.
- Cache layer reads by mtime, ctime, size, and inode with oldest-entry eviction at 64 entries, and snapshot upstream pi registries once per `tool_call` event.
- Restrict published package contents via the `package.json` `files` whitelist (`index.ts`, `config.ts`, `llms.txt`).

## 0.4.2 — 2026-11-10

- Start `pi-subagent` model injection at the first eligible call while preserving explicit models, routing semantics, input identity, and never-throw safeguards.

## 0.4.1 — 2026-11-09

- Add `/model-sync` argument completion for subcommands, `preset` actions, and preset names.

## 0.4.0 — 2026-11-09

- Add named presets (`presets` and `activePreset`) with fail-closed active-preset selection and `/model-sync preset list|create|copy|use|remove` commands.

## 0.3.1 — 2026-10-21

- Deduplicate `statSync` probes across layer resolution and the mtime/size cache, and ignore non-file paths.
- Harden `cloneSubagentMap`, `tool_call` array/record guards, thinking-level suffix detection, registry probe exception safety, and hot-path short-circuits.

## 0.3.0 — 2026-10-20

- Resolve relative `PI_MODEL_SYNC_CONFIG` and `PI_CODING_AGENT_DIR` overrides against the session `cwd`.
- Update `/model-sync set <main> * <model>` and `remove` default semantics, enforce strict subcommand arity, use unique atomic temp files for writes, and cache compiled globs.

## 0.2.0 — 2026-10-06

- Initial public release supporting omp native `before_subagent_spawn` and `@mjakl/pi-subagent` `tool_call` routing, dual-host config paths, and `/model-sync` management commands.
