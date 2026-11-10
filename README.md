# pi-model-sync

[![npm version](https://img.shields.io/npm/v/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![npm downloads](https://img.shields.io/npm/dm/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![GitHub stars](https://img.shields.io/github/stars/SenCha930511/pi-model-sync)](https://github.com/SenCha930511/pi-model-sync)
[![License: MIT](https://img.shields.io/github/license/SenCha930511/pi-model-sync)](LICENSE)

An extension for **omp (oh my pi) and upstream pi**: rewrites the model used by subsequent subagents based on the *spawning session's current model*. Two delegation paths are supported:

- omp native subagents (task / eval `agent()` / workpool workers).
- The `subagent` tool of [pi-subagent](https://github.com/mjakl/pi-subagent) (`@mjakl/pi-subagent`), under both omp and upstream pi (pi-subagent itself requires Pi ≥ 0.87.1 or a compatible host).

After the main model changes, **newly spawned/delegated** subagents switch to the model mapped by the matching profile; running subagents never switch mid-flight. Nested spawns (a subagent spawning further subagents) are intercepted too: the lookup key is the spawning session's current model.

Profiles live in a two-layer JSON config and can be grouped into named presets, with exactly one active preset per layer.

## Installation

No build, no dependencies — both hosts run the TypeScript sources directly.

### omp

```sh
# from the omp marketplace
omp plugin marketplace add SenCha930511/omp-marketplace
omp plugin install pi-model-sync@sencha930511
# or from git (pin a tag for a fixed version)
omp plugin install git:github.com/SenCha930511/pi-model-sync@v0.4.2
# or from npm (the same package feeds the Pi gallery)
omp plugin install npm:@sencha930511/pi-model-sync
```

### upstream pi

```sh
# from npm (listed in the Pi package gallery at pi.dev/packages)
pi install npm:@sencha930511/pi-model-sync
# or straight from git
pi install git:github.com/SenCha930511/pi-model-sync@v0.4.2
```

One-off trial without installing: `omp --extension /path/to/pi-model-sync` / `pi --extension /path/to/pi-model-sync` (`-e` is repeatable; `pi -e npm:@sencha930511/pi-model-sync` works too).

### Local / offline

1. Copy the whole directory to `~/.omp/agent/extensions/pi-model-sync/` (omp) or `~/.pi/agent/extensions/pi-model-sync/` (upstream pi); each `package.json` load key points at `./index.ts`.
2. omp alternative: add to `~/.omp/agent/config.yml`:

   ```yaml
   extensions:
     - /path/to/pi-model-sync
   ```

### Via your AI agent

This repo ships an [`llms.txt`](llms.txt) index ([llmstxt.org](https://llmstxt.org) convention), so coding agents can discover the project and install it directly. Ask yours:

> Install pi-model-sync for my omp (or pi) setup.

The agent should run the host-matching command from the sections above, then verify with `/model-sync list`.

## Config files

Two layers, same JSON format. A file is either a **named-preset** document or the older **legacy** profile list; both live at the same paths:

- **Global**: `~/.omp/agent/pi-model-sync.json`
  - `PI_MODEL_SYNC_CONFIG` overrides the path (relative paths resolve against the session cwd).
  - When `PI_CODING_AGENT_DIR` is set: `<its value>/pi-model-sync.json` (lower precedence than `PI_MODEL_SYNC_CONFIG`).
  - Dual-host landing: when none of the above applies, if the `~/.omp` file does **not** exist and `~/.pi/agent/pi-model-sync.json` does, the `.pi` path is used; when neither exists, the write target stays the `~/.omp` path.
- **Project**: `<repo>/.omp/pi-model-sync.json` (current directory only, no upward search)
  - Isomorphic fallback: when the `.omp` file does not exist and `<repo>/.pi/pi-model-sync.json` does, the `.pi` path is used.

**An existing project file wholly replaces the global file** (no per-key merge; a broken-JSON project file counts as "exists with no profiles"). Each layer carries its own `presets` and `activePreset`, so the two layers select presets independently.

### Named presets

```json
{
  "activePreset": "daily",
  "presets": {
    "daily": [
      {
        "main": "openai/gpt-6.1-sol",
        "subagents": {
          "*": "openai/gpt-6-luna",
          "scout": "openai/gpt-6-mini"
        }
      },
      {
        "main": "anthropic/claude-opus-*",
        "subagents": "anthropic/claude-sonnet-5"
      }
    ],
    "deep-work": [
      {
        "main": "openai/gpt-6.1-sol",
        "subagents": {
          "explore": "openai/gpt-6-mini"
        }
      }
    ]
  }
}
```

- `presets`: maps preset names to ordered `Profile[]` arrays. Names are single tokens (no whitespace), matched exactly and case-sensitively.
- `activePreset`: names the one preset whose profiles are in effect for this layer. When omitted, no preset is active and nothing routes.
- In `deep-work` only `explore` is bound; an agent with neither its own key nor a `"*"` default is not intercepted, so the host's default routing applies to it.
- Profile fields (`main`, `subagents`) and selector syntax are described below.

### Legacy format

```json
{
  "profiles": [
    {
      "main": "openai/gpt-6.1-sol",
      "subagents": { "*": "openai/gpt-6-luna", "scout": "openai/gpt-6-mini" }
    }
  ]
}
```

A legacy file behaves as a single virtual preset named `default` that is always active. Ordinary `add`/`set`/`remove` writes keep the legacy syntax; the first successful `preset create` or `preset copy` converts the file (see "Preset conversion and downgrade").

### Profile fields

- `main`: the main model to match (rules below).
- `subagents`:
  - a string → every agent under this profile uses that model;
  - an object → keys are agent names (e.g. `task`, `scout`); `"*"` is the profile default. An agent with neither an exact key nor a `"*"` default is left alone.
- Selectors pass through verbatim to host resolution: `provider/id`, bare `id`, role aliases (e.g. `@smol`), and `:level` suffixes (e.g. `openai/gpt-6-luna:high`) are handed to the host resolver as-is. Under upstream pi, see "pi-subagent routing rules" for validation semantics.

### Active preset selection

`activePreset` selects the whole profile list of its layer — profiles are never merged across presets or layers. Selection **fails closed** and never falls back:

- `activePreset` omitted → no profiles are active; `/model-sync list` and `/model-sync show` print `No active preset is selected; no profiles are active.`
- `activePreset` names a missing preset → no profiles are active; the warning is `Active preset "<name>" does not exist; no profiles are active.`
- A malformed preset document (a non-object JSON root, mixing `profiles` with `presets`/`activePreset`, `activePreset` without `presets`, a preset value that is not an array, or a blank/whitespace/duplicate preset name) is a config error: nothing routes, and write commands refuse to touch the file until it is repaired or deleted.

Routing on the spawn path is silent when it fails closed; `/model-sync list` and `/model-sync show` report the active preset and the warning.

### Preset conversion and downgrade

- `add`, `set`, and `remove` edit only the active preset of the target layer; there is no `--preset` flag. Run `/model-sync preset use <name>` first to edit another preset.
- `preset create` creates an empty preset without switching to it; `preset copy` deep-copies a preset into a new name without switching and never overwrites an existing name; `preset use` is a no-op when the name is already active; `preset remove` refuses the active preset.
- On a legacy file the first successful `preset create <name>` or `preset copy default <name>` converts it: the existing profiles move to `presets.default`, `activePreset` becomes `default`, and the top-level `profiles` key is removed. (`preset create default` is refused because that name is the virtual legacy preset.)
- A missing/empty config is written in legacy form (`{ "profiles": [] }`) until a preset command converts it.
- **Downgrade limit**: files using `presets`/`activePreset` need an extension version with preset support. Older versions only read `profiles` — they see a preset file as empty (no routing) — and their next write rewrites the document as legacy, dropping `presets` and `activePreset`. Keep a legacy copy if you switch between versions.

## Matching rules

- `main` without `*` → exact equality against `provider/id` or bare `id` (case-insensitive).
- `main` with `*` → explicit glob wildcard (`*` crosses `/`), tested against both the `provider/id` and bare `id` forms.
- No implicit substring matching; the **first** match in file order wins.

## pi-subagent routing rules

The extension intercepts pi-subagent's `subagent` tool input `{calls: [{agent, prompt, model?, ...}]}` at `tool_call` time: when a call has no `model`, the spawning session's current model is matched against profile `main`, the call's `agent` name picks a selector (exact key first, then `"*"`; key matching is **case-sensitive** — align pi-subagent agent names with profile keys manually), and `call.model` is injected. When neither the exact key nor `"*"` exists, the call is not intercepted and pi-subagent's default routing applies. All other fields (`prompt`, `thinking`, `cwd`, `session`, ...) are preserved.

- **An explicit per-call `model` always wins** and is never overwritten. pi-subagent's own precedence is `call model → agent frontmatter model → parent model`; injection sits at the call-model layer, so an agent frontmatter `model` is overridden by profile routing — by design: the profile is the single source of "which model to use now".
- Named-session continuations get injected too.
- Shape guard: only a tool named `subagent` whose input carries a `calls` array is intercepted; other same-named tools with a different shape (e.g. nicobailon/pi-subagents) are not affected.
- Under omp, selectors are fully validated via `ctx.models.resolve()`; under upstream pi they are tier-checked:
  - `@alias` (an omp-only concept, unresolvable upstream) → unresolvable, no injection;
  - a `:level` suffix (`off/minimal/low/medium/high/xhigh/max`) → stripped before validating the base;
  - a glob containing `*` → passed through for the child process to resolve (a failure surfaces as an explicit error on that delegation);
  - `provider/id` (split at the first `/`) → looked up via `modelRegistry.find`; a bare id → looked up in `modelRegistry.getAvailable()/getAll()`; no hit, no injection.
- An unresolvable selector is not injected; pi-subagent's default routing (frontmatter → parent model) applies, with a one-time TUI warning (once per selector).
- An injected selector must be resolvable by the **child process** itself: pi-subagent spawns an independent child (upstream pi or omp), whose model registration sources (e.g. `~/.pi/agent/models.json`) must know that selector.

## /model-sync command

All command help, output, notifications, and config error messages are in English.

| Command | Description |
|---|---|
| `/model-sync` or `/model-sync list` | Show the active layer, active preset, and its profiles (plus the other layer when that file exists) |
| `/model-sync show` | Show the current model, active preset, matched profile, and selector resolution status |
| `/model-sync add <main> <model>` | Add/update a profile in the active preset (all subagents use `<model>`) |
| `/model-sync set <main> <agent> <model>` | Set a model for one agent in the active preset (`*` sets/updates the profile default while keeping per-agent entries) |
| `/model-sync remove <main> [agent]` | Remove a whole profile or one agent entry from the active preset |
| `/model-sync preset list` | List the presets in the active layer (`*` marks the active one) |
| `/model-sync preset create <name>` | Create an empty, inactive preset |
| `/model-sync preset copy <source> <name>` | Deep-copy a preset into a new inactive preset (never overwrites) |
| `/model-sync preset use <name>` | Select the active preset (no-op when it is already active) |
| `/model-sync preset remove <name>` | Remove a preset; the active preset is refused |

Commands reject extra arguments with a usage hint. Writes target the **global** file by default; any subcommand with `--project` writes the **project** file. `add`, `set`, and `remove` edit only the active preset of the target layer and refuse to write when no preset is active; `preset create` and `preset copy` leave the active profiles unchanged; `preset list` always reports the active layer, so `--project` does not change its output. You can also edit the JSON directly (changes are detected via an mtime+size cache and take effect on save).

Typing `/model-sync ` or `/model-sync preset ` opens argument completion with descriptions for each subcommand. `preset use`, `preset remove`, and the source argument of `preset copy` also suggest existing preset names from the target config layer. Preset names are global by default; include `--project` before the name to complete project-layer names.

## Updating

No self-update machinery — the hosts' package managers own updates:

| Installed via | Update with |
|---|---|
| `pi install npm:...` | `pi update --extensions` (or `pi update --all`) |
| `pi install git:...@vX.Y.Z` | Pinned by ref: reinstall with a newer tag to move |
| `omp plugin install npm:...` | `omp plugin upgrade pi-model-sync` |
| `omp plugin install pi-model-sync@sencha930511` | `omp plugin upgrade pi-model-sync@sencha930511` |
| `omp plugin install git:...` / copied directory | `git pull` / re-copy |

## Notes

- Running subagents never switch mid-flight; switching the main model only affects later spawns.
- Nested spawns resolve against the spawning session's current model (a child session only knows its own model — the only clean API). This happens only when the host allows nesting depth ≥ 2; the cap is governed by `task.maxRecursionDepth` (omp doc default 2, negative = unlimited); at the cap, the subagent's task tool is removed so it cannot spawn further.
- When a profile selector is unresolvable, that spawn or delegation is not intercepted — default routing applies — and a warning shows once per selector in the TUI.
- For omp-native spawns, when routing takes effect the task card / Agent Hub shows the routing note: `pi-model-sync: <agent> → <model> (main: <main>)`. pi-subagent delegations show the injected model in the call rendering instead — no extra note, by design.
- Startup is fully silent: no session-start notification.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Review expectations and conventions live in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © SenCha930511.
