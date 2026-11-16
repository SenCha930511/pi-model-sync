# pi-model-sync

[![npm version](https://img.shields.io/npm/v/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![npm downloads](https://img.shields.io/npm/dm/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![GitHub stars](https://img.shields.io/github/stars/SenCha930511/pi-model-sync)](https://github.com/SenCha930511/pi-model-sync)
[![License: MIT](https://img.shields.io/github/license/SenCha930511/pi-model-sync)](LICENSE)

An extension for **omp (oh my pi) and upstream pi**: rewrites the model used by subsequent subagents based on the *spawning session's current model*. Supported delegation paths:

- omp native subagents (task / eval `agent()` / workpool workers).
- Third-party subagent plugins with a per-call `model` field: `@mjakl/pi-subagent`, `pi-subagents` (nicobailon), `@tintinweb/pi-subagents`, `@gotgenes/pi-subagents`, `pi-interactive-subagents` (HazAT), and `edxeth/pi-subagents`. The plugin is identified from its registered tool schema, with the call shape as the fallback.

After the main model changes, **newly spawned/delegated** subagents switch to the model mapped by the matching profile; running subagents never switch mid-flight. Nested spawns (a subagent spawning further subagents) are intercepted too: the lookup key is the spawning session's current model.

Profiles live in a two-layer JSON config and can be grouped into named presets, with exactly one active preset per layer.

## Installation

No build, no dependencies. Both hosts run the TypeScript sources directly.

### omp

```sh
# from the omp marketplace
omp plugin marketplace add SenCha930511/omp-marketplace
omp plugin install pi-model-sync@sencha930511
# or from git (pin a tag for a fixed version)
omp plugin install git:github.com/SenCha930511/pi-model-sync@v0.5.0
# or from npm (the same package feeds the Pi gallery)
omp plugin install npm:@sencha930511/pi-model-sync
```

### upstream pi

```sh
# from npm (listed in the Pi package gallery at pi.dev/packages)
pi install npm:@sencha930511/pi-model-sync
# or straight from git
pi install git:github.com/SenCha930511/pi-model-sync@v0.5.0
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

The agent should run the host-matching command from the sections above, then verify with `/model-sync list`. With no config file yet, `list` prints the first-run hint instead of an error.

## Config files

Two layers, same JSON format. A file is either a **named-preset** document or the older **legacy** profile list; both live at the same paths:

- **Global**: `~/.omp/agent/pi-model-sync.json`
  - `PI_MODEL_SYNC_CONFIG` overrides the path (relative paths resolve against the session cwd; a leading `~/` expands to the home directory).
  - When `PI_CODING_AGENT_DIR` is set: `<its value>/pi-model-sync.json` (lower precedence than `PI_MODEL_SYNC_CONFIG`; a leading `~/` also expands).
  - Dual-host landing: when none of the above applies, if the `~/.omp` file does **not** exist and `~/.pi/agent/pi-model-sync.json` does, the `.pi` path is used; when neither exists, the write target stays the `~/.omp` path.
- **Project**: `<repo>/.omp/pi-model-sync.json` (current directory only, no upward search)
  - Isomorphic fallback: when the `.omp` file does not exist and `<repo>/.pi/pi-model-sync.json` does, the `.pi` path is used.

A missing config file is not an error. `/model-sync list` and `/model-sync preset list` print the first-run hint, and the first write creates the file.

**An existing project file wholly replaces the global file** (no per-key merge; a broken-JSON project file still counts as "exists" and fails closed). Each layer carries its own `presets` and `activePreset`, so the two layers select presets independently.

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
- `activePreset`: names the one preset whose profiles are in effect for this layer. When omitted, empty, or null, no preset is active and nothing routes; `/model-sync preset use <name>` can repair it.
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

A legacy file behaves as a single virtual preset named `default` that is always active. Ordinary `add`/`set`/`remove`/`move` writes keep the legacy syntax; the first successful `preset create`, `preset copy`, or `preset rename` converts the file (see "Preset conversion and downgrade").

### Profile fields

- `main`: the main model to match (rules below).
- `subagents`:
  - a string → every agent under this profile uses that model;
  - an object → keys are agent names (e.g. `task`, `scout`); `"*"` is the profile default. An agent with neither an exact key nor a `"*"` default is left alone.
- Selectors pass through verbatim to host resolution: `provider/id`, bare `id`, role aliases (e.g. `@smol`), and `:level` suffixes (e.g. `openai/gpt-6-luna:high`) are handed to the host resolver as-is. Under upstream pi, see "pi-subagent routing rules" for validation semantics.

### Active preset selection

`activePreset` selects the whole profile list of its layer. Profiles are never merged across presets or layers. Selection **fails closed** and never falls back:

- `activePreset` omitted, empty, or null → no profiles are active; `/model-sync list` and `/model-sync show` print `No active preset is selected; no profiles are active.` The `preset use` command can repair the selection.
- `activePreset` names a missing preset → no profiles are active; the warning is `Active preset "<name>" does not exist; no profiles are active.`
- A malformed document (a non-object JSON root, mixing `profiles` with `presets`/`activePreset`, `activePreset` without `presets`, a non-array `profiles` value, a preset value that is not an array, a preset name with whitespace, a duplicate preset name, a non-string, non-null `activePreset` value, or a root object with neither `profiles` nor `presets` and at least one other key) is a config error: nothing routes, and write commands refuse to touch the file until it is repaired or deleted.
- Invalid profile entries are skipped with a warning, not silently. `list`, `show`, and `preset list` print the warnings. A write command warns that those entries will be dropped before it rewrites the file.

Routing on the spawn path is silent when it fails closed; `/model-sync list` and `/model-sync show` report the active preset and the warning.

### Preset conversion and downgrade

- `add`, `set`, `remove`, and `move` edit only the active preset of the target layer; there is no `--preset` flag. Run `/model-sync preset use <name>` first to edit another preset.
- `preset create` creates an empty preset without switching to it; `preset copy` deep-copies a preset into a new name without switching and never overwrites an existing name; `preset rename` renames a preset in place, keeps its profiles and document order, and updates `activePreset` when the old name was active; `preset use` is a no-op when the name is already active; `preset remove` refuses the active preset.
- `add <main> <model>` replaces any per-agent map for that profile with the single model. The notification warns when that drops per-agent entries. `add` and `set` also warn when a newly appended literal rule appears after an earlier profile that may match the same model first.
- `move <main> top|bottom|up|down` changes profile order. First match wins, so use it to put a specific rule before a broader glob or `*` rule.
- On a legacy file the first successful `preset create <name>` or `preset copy default <name>` converts it: the existing profiles move to `presets.default`, `activePreset` becomes `default`, and the top-level `profiles` key is removed. `preset rename default <name>` also converts it and makes `<name>` active. (`preset create default` is refused because that name is the virtual legacy preset.)
- A missing/empty config is written in legacy form (`{ "profiles": [] }`) until a preset command converts it.
- **Downgrade limit**: files using `presets`/`activePreset` need an extension version with preset support. Older versions only read `profiles`. They see a preset file as empty (no routing), and their next write rewrites the document as legacy, dropping `presets` and `activePreset`. Keep a legacy copy if you switch between versions.

## Matching rules

- `main` without `*` → exact equality against `provider/id` or bare `id` (case-insensitive).
- `main` with `*` → explicit glob wildcard (`*` crosses `/`), tested against both the `provider/id` and bare `id` forms.
- No implicit substring matching; the **first** match in file order wins.

## Subagent plugin routing

At `tool_call` time the extension identifies the plugin behind the call and injects a model only when that call has none. Identification uses the tool's registered JSON Schema (`pi.getAllTools()`) first. Each adapter requires a set of property names and rejects others, so same-named tools are separated. A host without `getAllTools()`, or a schema that no longer matches, falls back to a stricter call-shape check.

| Plugin | Tool | Agent key | Selector handling |
|---|---|---|---|
| `@mjakl/pi-subagent` | `subagent` (`calls[]`) | `call.agent` | Passed through verbatim: `@alias`, glob, `:level`, bare id |
| `pi-subagents` (nicobailon) | `subagent` (`agent`, `tasks[]`, `chain[]`, `workflow`) | `agent` per slot; `*` for a workflow | `provider/id`, bare id, `:level` suffix; no `@alias` or glob |
| `@tintinweb/pi-subagents` | `Agent` | `subagent_type` | `provider/id` or fuzzy name; `:level` split into `thinking`; no `@alias` or glob |
| `@gotgenes/pi-subagents` | `subagent` | `subagent_type` | Same as `@tintinweb` |
| `pi-interactive-subagents` (HazAT) | `subagent` | `agent`, else `*` | `provider/id`; `:level` stripped (the plugin appends its own thinking level) |
| `edxeth/pi-subagents` | `subagent` (`children[]` batches) | `agent` per slot | Exact `provider/id`; bare id, `@alias`, and glob are skipped |

Rules that apply to every adapter:

- **An explicit per-call `model` always wins** and is never overwritten. This includes `options.model` on nicobailon, per-item models in `tasks[]`/`chain[]`, and child models in `children[]`.
- **Resume and management calls are never given a model.** `action` (nicobailon), `resume` (`@tintinweb`, `@gotgenes`), `resumeSessionId` (HazAT), and workflow or management calls are left untouched.
- **Workflow scripts are a default-only seam.** nicobailon's `subagent({ workflow: ... })` receives the profile `"*"` selector as the workflow child default; a child that names its own model keeps it. The script's internal agent names are not visible to `tool_call`.
- **Agent keys are case-sensitive.** The extension tries the exact key first, then `"*"`. Match the plugin's names (`Explore`, `Plan`, `general-purpose`, ...) exactly.
- An unresolvable selector, or one the adapter cannot express (`@alias`, glob, or a bare id where unsupported), is not injected. The plugin's default routing applies and a one-time TUI warning appears.
- Under omp, selectors are validated with `ctx.models.resolve()`; under upstream pi they are checked against `modelRegistry` (`:level` stripped, glob passed through, `@alias` unresolvable).
- **Frontmatter and model scope still win where the plugin says so.** `@tintinweb` prefers an agent's frontmatter `model` over the tool parameter; `@gotgenes` lets the call win unless the agent is `locked`; `edxeth` honors `allow-model-override: false` and `allowed-models`. These are plugin policies, not routing failures.
- Calls that bypass `tool_call` (workflow scripts, agent mentions, `/subagent` commands, service APIs, cross-extension RPC) are not intercepted.

pi-subagent (`@mjakl`) keeps its original behavior: `{calls: [{agent, prompt, model?, ...}]}`, `call.model` injection, and named-session continuations are injected too. An injected selector must be resolvable by the **child process** itself: pi-subagent spawns an independent child whose model sources (e.g. `~/.pi/agent/models.json`) must know that selector.

## /model-sync command

All command help, output, notifications, and config error messages are in English.

| Command | Description |
|---|---|
| `/model-sync` or `/model-sync list` | Show the active layer, active preset, and its profiles (plus the other layer when that file exists) |
| `/model-sync show [model] [agent]` | Show the current or requested model, active preset, matched profile, and selector resolution status; with an agent, show only that binding |
| `/model-sync add <main> <model>` | Add/update a profile in the active preset (all subagents use `<model>`) |
| `/model-sync set <main> <agent> <model>` | Set a model for one agent in the active preset (`*` sets/updates the profile default while keeping per-agent entries) |
| `/model-sync remove <main> [agent]` | Remove a whole profile or one agent entry from the active preset |
| `/model-sync move <main> <top\|bottom\|up\|down>` | Reorder a profile in the active preset |
| `/model-sync preset list` | List the presets in the active layer (`*` marks the active one) |
| `/model-sync preset create <name>` | Create an empty, inactive preset |
| `/model-sync preset copy <source> <name>` | Deep-copy a preset into a new inactive preset (never overwrites) |
| `/model-sync preset rename <old> <new>` | Rename a preset in place and keep its profiles |
| `/model-sync preset use <name>` | Select the active preset (no-op when it is already active) |
| `/model-sync preset remove <name>` | Remove a preset; the active preset is refused |
| `/model-sync help` | Show the top-level usage |
| `/model-sync preset help` | Show the preset usage |

Commands reject extra arguments with a usage hint. A missing config file is not an error; `list` and `preset list` print the first-run hint, and the first write creates the file. Writes target the **global** file by default; any subcommand with `--project` writes the **project** file. When the project file exists and you write the global file without `--project`, the notification reminds you that the project layer overrides it. `add`, `set`, `remove`, and `move` edit only the active preset of the target layer and refuse to write when no preset is active; `preset create`, `preset copy`, and `preset rename` leave the active profile list unchanged (rename updates the active name when the old name was active); `preset list` always reports the active layer, so `--project` does not change its output. You can also edit the JSON directly (changes are detected via an mtime+ctime+size+inode cache and take effect on save).

Typing `/model-sync ` or `/model-sync preset ` opens argument completion with descriptions for each subcommand. A typed `--project` flag is preserved in the completion value and is not suggested twice. `add`, `set`, `remove`, and `move` complete existing profile `main` values and agent keys from the target layer's active preset. `preset use`, `preset remove`, `preset copy`, and `preset rename` suggest existing preset names from the target config layer. Preset names are global by default; include `--project` before the name to complete project-layer names.

## Updating

No self-update machinery. The hosts' package managers own updates:

| Installed via | Update with |
|---|---|
| `pi install npm:...` | `pi update --extensions` (or `pi update --all`) |
| `pi install git:...@vX.Y.Z` | Pinned by ref: reinstall with a newer tag to move |
| `omp plugin install npm:...` | `omp plugin upgrade pi-model-sync` |
| `omp plugin install pi-model-sync@sencha930511` | `omp plugin upgrade pi-model-sync@sencha930511` |
| `omp plugin install git:...` / copied directory | `git pull` / re-copy |

## Notes

- Running subagents never switch mid-flight; switching the main model only affects later spawns.
- Nested spawns resolve against the spawning session's current model (a child session only knows its own model, the only clean API). This happens only when the host allows nesting depth ≥ 2; the cap is governed by `task.maxRecursionDepth` (omp doc default 2, negative = unlimited); at the cap, the subagent's task tool is removed so it cannot spawn further.
- When a profile selector is unresolvable, that spawn or delegation is not intercepted. Default routing applies, and a warning shows once per selector in the TUI.
- For omp-native spawns, when routing takes effect the task card / Agent Hub shows the routing note: `pi-model-sync: <agent> → <model> (main: <main>)`. pi-subagent delegations show the injected model in the call rendering instead. There is no extra note, by design.
- Startup is fully silent: no session-start notification.
- A missing config file is not an error. `list` and `preset list` show the first-run hint, and the first write creates the file.
- Profile order matters. Use `/model-sync move <main> top|bottom|up|down` to put a rule before a broader glob or `*` rule.

## Contributing

See [CONTRIBUTING.md](https://github.com/SenCha930511/pi-model-sync/blob/main/CONTRIBUTING.md). Review expectations and conventions live in [AGENTS.md](https://github.com/SenCha930511/pi-model-sync/blob/main/AGENTS.md).

## License

[MIT](LICENSE) © SenCha930511.
