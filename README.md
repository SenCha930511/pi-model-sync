# pi-model-sync

[![npm version](https://img.shields.io/npm/v/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![npm downloads](https://img.shields.io/npm/dm/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![GitHub stars](https://img.shields.io/github/stars/SenCha930511/pi-model-sync)](https://github.com/SenCha930511/pi-model-sync)
[![License: MIT](https://img.shields.io/github/license/SenCha930511/pi-model-sync)](LICENSE)

**Route subagent models from the model that spawned them.**

An extension for **omp (oh my pi)** and **upstream pi**. When a session spawns or delegates to a subagent, the extension looks up the spawning session's current model in an ordered profile table and rewrites the child's model. Running subagents never switch mid-flight. Nested spawns use the spawning session's model, not the root's.

Two interception paths:

- **omp native subagents** through `before_subagent_spawn` (task, eval `agent()`, workpool workers).
- **Third-party subagent plugins** through `tool_call`, when the plugin exposes a per-call `model` field.

Supported plugin tools:

| Plugin | Tool |
|---|---|
| `@mjakl/pi-subagent` | `subagent` |
| `pi-subagents` (nicobailon) | `subagent` |
| `@tintinweb/pi-subagents` | `Agent` |
| `@gotgenes/pi-subagents` | `subagent` |
| `pi-interactive-subagents` (HazAT) | `subagent` |
| `edxeth/pi-subagents` | `subagent` |

The plugin is identified from its registered tool schema, with the call shape as a fallback. An explicit per-call model is never overwritten. Resume and management calls are never given a model. Details are in [Subagent plugin support](#subagent-plugin-support).

## Installation

No build, no dependencies. Both hosts run the TypeScript sources directly.

### omp

```sh
# from the omp marketplace
omp plugin marketplace add SenCha930511/omp-marketplace
omp plugin install pi-model-sync@sencha930511
# or from git (pin a tag for a fixed version)
omp plugin install git:github.com/SenCha930511/pi-model-sync@v0.6.1
# or from npm (the same package feeds the Pi gallery)
omp plugin install npm:@sencha930511/pi-model-sync
```

### upstream pi

```sh
# from npm (listed in the Pi package gallery at pi.dev/packages)
pi install npm:@sencha930511/pi-model-sync
# or straight from git
pi install git:github.com/SenCha930511/pi-model-sync@v0.6.1
```

One-off trial without installing:

```sh
omp --extension /path/to/pi-model-sync
pi --extension /path/to/pi-model-sync
```

`-e` is repeatable. `pi -e npm:@sencha930511/pi-model-sync` also works.

### Local / offline

1. Copy the whole directory to `~/.omp/agent/extensions/pi-model-sync/` (omp) or `~/.pi/agent/extensions/pi-model-sync/` (upstream pi). Each `package.json` load key points at `./index.ts`.
2. omp alternative: add the path to `~/.omp/agent/config.yml`:

   ```yaml
   extensions:
     - /path/to/pi-model-sync
   ```

### Via your AI agent

This repo ships an [`llms.txt`](llms.txt) index ([llmstxt.org](https://llmstxt.org) convention), so coding agents can discover the project and install it directly. Ask yours:

> Install pi-model-sync for my omp (or pi) setup.

The agent should run the host-matching command from the sections above, then verify with `/model-sync list`. With no config file yet, `list` prints the first-run hint instead of an error.

## Quick start

Install the extension, then create a profile.

```text
/model-sync add openai/gpt-6.1-sol openai/gpt-6-mini
```

This writes a global profile whose `main` is `openai/gpt-6.1-sol` and whose `subagents` is the string `openai/gpt-6-mini`. The new profile routes every subagent spawned while the session runs `openai/gpt-6.1-sol`, unless an earlier profile matches that model first. Add `--project` to write the repo-local layer instead.

Verify what is active:

```text
/model-sync list
/model-sync show
```

For a first config, `/model-sync init` creates a starter preset from the current model. `/model-sync doctor` checks both layers for problems.

Then spawn a subagent. For omp native spawns, the task card shows the routing note:

```text
pi-model-sync: <agent> → <model> (main: <main>)
```

For plugin delegations, the injected model appears in the call rendering instead. There is no extra note, by design.

A minimal named-preset config looks like this:

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
      }
    ]
  }
}
```

## How routing works

### omp native spawns

`before_subagent_spawn` fires in the spawning session, including nested spawns.

1. Read the spawning session's current model.
2. Find the first profile whose `main` matches that model.
3. Pick the subagent selector with the exact agent key, then the `"*"` default.
4. Validate the selector with `ctx.models.resolve()`.
5. Return `[selector, ...originalPatterns]`. The original patterns stay as retry fallbacks.

A failed lookup, an unresolvable selector, or any error leaves the spawn untouched. This path never throws.

### Plugin tool calls

`tool_call` fires before a supported plugin tool executes.

1. Check the tool name against the adapter set.
2. Identify the plugin from its registered schema, then from the call shape.
3. Split the input into call slots. A slot is only collected when it has an agent and no explicit model, and when the call is not a resume or management action.
4. For each slot, find the profile, pick the selector, translate it into the plugin's selector dialect, and validate it.
5. Write `model` into the slot, plus a split `thinking` field where the plugin expects one.
6. Mutate the input in place. Upstream pi documents in-place mutation; omp passes the same object for non-edit tools. The extension does not return an `input` field, so another extension's last-wins input is not overwritten.

An explicit per-call model always wins. Resume and management calls are left alone. The path never throws.

### Nested spawns

A nested spawn is resolved against the spawning session's current model, not the root session's. This happens only when the host allows nesting depth of at least 2. The cap is governed by `task.maxRecursionDepth` (omp doc default 2, negative means unlimited). At the cap, the subagent's task tool is removed so it cannot spawn further.

### Unresolvable selectors

When a selector cannot be resolved, that spawn or delegation is not intercepted. The host's default routing applies, and a one-time TUI warning appears. The warning set is bounded so long sessions stay lean. Under upstream pi, a glob is passed through because the child process resolves it.

### Session controls

These commands affect only the current session. They never write a config file, so switching a preset in one terminal does not change another terminal's routing.

- `/model-sync use-session <preset|off>` routes this session with an existing preset from the active layer. `off` clears the override.
- `/model-sync pause` stops routing for this session; `/model-sync resume` re-enables it. A session override survives a pause.
- `/model-sync status [off]` prints the routing state and sets the status bar when the host has one. `status off` clears the bar. Other session commands update the bar only while it is enabled.
- `/model-sync log [clear]` prints the last 50 routing decisions for this session, including skipped selectors and their reasons.
- `/model-sync doctor` scans the active and inactive layers, every preset, and every profile. It reports unknown keys, shadowed literal and glob rules with the layer named, selectors the host or installed plugins cannot resolve, and agent keys that differ only by case.
- `/model-sync init` creates a starter named preset from the current model. It refuses to overwrite an existing file and reports a corrupt one instead of overwriting it.

Writes still target the on-disk active preset while a session override is active; the command tells you when that happens.

### Startup

Startup is fully silent. There is no session-start notification.

## Config files

Two layers, same JSON format. A file is either a **named-preset** document or the older **legacy** profile list; both live at the same paths.

- **Global**: `~/.omp/agent/pi-model-sync.json`
  - `PI_MODEL_SYNC_CONFIG` overrides the path. Relative paths resolve against the session cwd. A leading `~/` expands to the home directory.
  - When `PI_CODING_AGENT_DIR` is set: `<its value>/pi-model-sync.json`. Lower precedence than `PI_MODEL_SYNC_CONFIG`. A leading `~/` also expands.
  - Dual-host landing: when none of the above applies, if the `~/.omp` file does **not** exist and `~/.pi/agent/pi-model-sync.json` does, the `.pi` path is used. When neither exists, the write target stays the `~/.omp` path.
- **Project**: `<repo>/.omp/pi-model-sync.json` (current directory only, no upward search)
  - Isomorphic fallback: when the `.omp` file does not exist and `<repo>/.pi/pi-model-sync.json` does, the `.pi` path is used.

A missing config file is not an error. `/model-sync list` and `/model-sync preset list` print the first-run hint, and the first write creates the file.

**An existing project file wholly replaces the global file.** There is no per-key merge. A broken-JSON project file still counts as "exists" and fails closed. Each layer carries its own `presets` and `activePreset`, so the two layers select presets independently.

Writes target the global file by default. Any subcommand with `--project` targets the project file. When the project file exists and you write the global file without `--project`, the notification reminds you that the project layer overrides it. The write is atomic, follows a symlink to its target, and invalidates the read cache.

## Config schema

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

- `presets` maps preset names to ordered `Profile[]` arrays. Names are single tokens (no whitespace), matched exactly and case-sensitively.
- `activePreset` names the one preset whose profiles are in effect for this layer. When omitted, empty, or null, no preset is active and nothing routes. `/model-sync preset use <name>` can repair it.
- In `deep-work` only `explore` is bound. An agent with neither its own key nor a `"*"` default is not intercepted, so the host's default routing applies to it.
- Profile fields (`main`, `subagents`) and selector syntax are described below.

### Legacy format

```json
{
  "profiles": [
    {
      "main": "openai/gpt-6.1-sol",
      "subagents": {
        "*": "openai/gpt-6-luna",
        "scout": "openai/gpt-6-mini"
      }
    }
  ]
}
```

A legacy file behaves as a single virtual preset named `default` that is always active. Ordinary `add`, `set`, `remove`, and `move` writes keep the legacy syntax. The first successful `preset create`, `preset copy`, or `preset rename` converts the file.

### Profile fields

- `main`: the main model to match. Matching rules are below.
- `subagents`:
  - a string: every agent under this profile uses that model;
  - an object: keys are agent names (for example `task`, `scout`, `Explore`); `"*"` is the profile default. An agent with neither an exact key nor a `"*"` default is left alone.
- Selectors pass through to host resolution: `provider/id`, bare `id`, role aliases (for example `@smol`), and `:level` suffixes (for example `openai/gpt-6-luna:high`). Each plugin adapter decides which forms it can express; see [Subagent plugin support](#subagent-plugin-support).
- `agentMatch` (optional): `"exact"` (default) or `"case-insensitive"`. Exact keys are always tried first; `"case-insensitive"` adds a case-insensitive pass before the `"*"` default. Use it when omp and a Claude-style plugin spell the same agent differently, for example `explore` and `Explore`.

### Active preset selection

`activePreset` selects the whole profile list of its layer. Profiles are never merged across presets or layers. Selection **fails closed** and never falls back:

- `activePreset` omitted, empty, or null: no profiles are active. `/model-sync list` and `/model-sync show` print `No active preset is selected; no profiles are active.` The `preset use` command can repair the selection.
- `activePreset` names a missing preset: no profiles are active. The warning is `Active preset "<name>" does not exist; no profiles are active.`
- A malformed document is a config error: nothing routes, and write commands refuse to touch the file until it is repaired or deleted.

Routing on the spawn path is silent when it fails closed. `/model-sync list` and `/model-sync show` report the active preset and the warning.

### Structural errors

The parse boundary never throws. These shapes are structural errors:

- a non-object JSON root;
- mixing `profiles` with `presets` or `activePreset`;
- `activePreset` without `presets`;
- a non-object `presets` value;
- a preset value that is not an array;
- a preset name that is blank, contains whitespace, or duplicates another name after trimming;
- a non-string, non-null `activePreset` value;
- a non-array `profiles` value;
- a non-empty root object with neither `profiles` nor `presets`.

An empty object is a valid empty legacy config. A missing file yields the same empty legacy config, which keeps writes downgrade-compatible.

Invalid profile entries are skipped with a warning, not silently. This covers a non-string or blank `main`, a `subagents` value that is neither a non-blank string nor an object of non-blank strings, and object entries whose values are not non-blank strings. `list`, `show`, and `preset list` print the warnings. Unknown root or profile keys are reported too. A write command warns that those entries will be dropped before it rewrites the file.

### Preset conversion and downgrade

- `add`, `set`, `remove`, and `move` edit only the active preset of the target layer. There is no `--preset` flag. Run `/model-sync preset use <name>` first to edit another preset.
- `preset create` creates an empty preset without switching to it.
- `preset copy` deep-copies a preset into a new name without switching and never overwrites an existing name.
- `preset rename` renames a preset in place, keeps its profiles and document order, and updates `activePreset` when the old name was active.
- `preset use` is a no-op when the name is already active.
- `preset remove` refuses the active preset.
- `add <main> <model>` replaces any per-agent map for that profile with the single model. The notification warns when that drops per-agent entries. `add` and `set` also warn when a newly appended literal rule appears after an earlier profile that may match the same model first.
- `move <main> top|bottom|up|down` changes profile order. First match wins, so use it to put a specific rule before a broader glob or `*` rule.
- On a legacy file, the first successful `preset create <name>` or `preset copy default <name>` converts it. The existing profiles move to `presets.default`, `activePreset` becomes `default`, and the top-level `profiles` key is removed. `preset rename default <name>` also converts it and makes `<name>` active. `preset create default` is refused because that name is the virtual legacy preset.
- A missing or empty config is written in legacy form (`{ "profiles": [] }`) until a preset command converts it.
- **Downgrade limit**: files using `presets` or `activePreset` need an extension version with preset support. Older versions only read `profiles`. They see a preset file as empty (no routing), and their next write rewrites the document as legacy, dropping `presets` and `activePreset`. Keep a legacy copy if you switch between versions.

## Matching rules

- `main` without `*`: exact equality against `provider/id` or bare `id`, case-insensitive.
- `main` with `*`: explicit glob wildcard. `*` crosses `/`, and all other regex metacharacters are escaped. The pattern is tested against both the `provider/id` and bare `id` forms.
- There is no implicit substring matching. The **first** match in profile order wins.
- Profile order matters. Use `/model-sync move <main> top|bottom|up|down` to put a rule before a broader glob or `*` rule.
- Agent keys are exact by default. A profile with `"agentMatch": "case-insensitive"` tries an exact key, then a case-insensitive key, then `"*"`.

## Subagent plugin support

### Detection

At `tool_call` time the extension identifies the plugin behind the call and injects a model only when that call has none.

1. The tool name must be one of the adapter tool names (`subagent` or `Agent`).
2. `pi.getAllTools()` is read once. Each adapter declares required and forbidden schema property names, including a `model` field. The schema properties are collected recursively through `properties`, `items`, `anyOf`, `oneOf`, and `allOf`, and through local `$ref` targets in `$defs` or `definitions`, up to a bounded depth.
3. Adapters whose required properties are present and whose forbidden properties are absent become candidates. The call shape then picks the adapter that can actually inject into this input.
4. A host without `getAllTools()`, or a schema that no longer matches, falls back to a stricter call-shape check. The fallback requires an adapter-specific marker property, so an ambiguous `{agent, task}` shape is not claimed.
5. If more than one adapter still matches, the call is skipped with a one-time TUI warning. This is a setup problem, not a per-call guess.

An adapter only claims a call when it can inject into it. An explicit model, a resume, or a management action yields no slot and therefore no adapter.

Routing starts only after the host registers the plugin's tool. A plugin that fails to load on your host version never reaches this layer, so check that plugin's own host requirements first. For example, `pi-subagents@0.88.1` needs a host that exports the TUI `MouseRegion` API, which omp 18.20.3 does not.

### Support matrix

| Plugin | Tool | Agent key | Selector handling |
|---|---|---|---|
| `@mjakl/pi-subagent` | `subagent` (`calls[]`) | `call.agent` | Passed through verbatim: `@alias`, glob, `:level`, bare id |
| `pi-subagents` (nicobailon) | `subagent` (`agent`, `tasks[]`, `chain[]`, `workflow`) | `agent` per slot; `*` for a workflow | `provider/id`; bare id when unique or the spawning provider disambiguates; `:level` suffix; no `@alias` or glob |
| `@tintinweb/pi-subagents` | `Agent` | `subagent_type` | `provider/id` or bare id; `:level` split into `thinking`; no `@alias` or glob |
| `@gotgenes/pi-subagents` | `subagent` | `subagent_type` | Same as `@tintinweb` |
| `pi-interactive-subagents` (HazAT) | `subagent` | `agent`, else `*` | `provider/id` or bare id; `:level` stripped because the plugin appends its own thinking level; no `@alias` or glob |
| `edxeth/pi-subagents` | `subagent` (`children[]` batches) | `agent` per slot; single call `agent`, else `*` | Exact `provider/id`; `:level` split into `thinking`; no bare id, `@alias`, or glob |

### `@mjakl/pi-subagent`

- Input: `{ calls: [{ agent, prompt, model?, ... }] }`.
- Each call without a `model` is a slot. `call.model` is never overwritten.
- The selector is passed through verbatim. The host or child process resolves aliases, globs, bare ids, and `:level` suffixes.
- Named-session continuations are injected too.
- An injected selector must be resolvable by the **child process** itself. `pi-subagent` spawns an independent child whose model sources (for example `~/.pi/agent/models.json`) must know that selector.

### `pi-subagents` (nicobailon)

- Input: a direct `{ agent, task }` call, `tasks[]` items, `chain[]` steps, or a `workflow`.
- Direct calls and `tasks[]` items are slots when they have an `agent` and no `model`. `chain[]` steps are collected recursively through `parallel` arrays.
- An explicit top-level `model`, `options.model`, or per-item `model` wins and is never overwritten.
- A non-blank `action` is a management call and is skipped.
- A `workflow` is a default-only seam. The profile `"*"` selector is injected as the top-level model, which becomes the workflow children's default. A child that names its own model keeps it. The script's internal agent names are not visible to `tool_call`.
- The selector dialect accepts `provider/id` and `:level` suffixes. It does not accept `@alias` or glob. A bare id is accepted only when exactly one provider exposes it, or when the spawning session's provider is one of the candidates. On omp, the authenticated `ctx.models.list()` is counted; on upstream pi, the registry is counted. A slash-containing bare id is counted by its full id.

### `@tintinweb/pi-subagents` and `@gotgenes/pi-subagents`

- `@tintinweb` registers the tool `Agent`; `@gotgenes` registers `subagent`.
- Input: `{ prompt, subagent_type, model?, thinking?, resume? }`.
- `subagent_type` is the agent key. It is matched case-sensitively, exact key first, then `"*"`.
- A non-blank `model` or a set `resume` flag yields no slot.
- `provider/id` and bare ids are accepted. `@alias` and glob are not. A known `:level` suffix is split into the `thinking` field, but only when that field is empty.
- These plugins have their own model policies. `@tintinweb` prefers an agent's frontmatter `model` over the tool parameter. `@gotgenes` lets the call win unless the agent is `locked`. A plugin policy can therefore override or ignore the injected value; that is not a routing failure.

### `pi-interactive-subagents` (HazAT)

- Input: `{ name, task, agent?, interactive?, resumeSessionId?, model? }`.
- `name` and `task` are required. A non-blank `model` or `resumeSessionId` yields no slot.
- The agent key is `agent` when present, otherwise `"*"`.
- `provider/id` and bare ids are accepted. `@alias` and glob are not. A `:level` suffix is stripped, because the plugin appends its own thinking level from agent frontmatter; keeping the suffix would produce `model:level:level`.

### `edxeth/pi-subagents`

- Input: a single `{ name, task, title, agent?, model? }` call, or a `children[]` batch.
- A non-empty `children[]` collects one slot per child with no `model`; a missing `agent` falls back to `"*"`. An empty `children[]` is treated as a single spawn.
- An explicit top-level or per-child `model` wins and is never overwritten.
- The agent key is `agent`, otherwise `"*"`.
- Only exact `provider/id` selectors are accepted. A bare id, `@alias`, or glob is skipped rather than guessed, because the wrong provider would be worse than default routing. A known `:level` suffix is split into `thinking`.
- The plugin honors its own `allow-model-override: false` and `allowed-models` policies.

### Rules that apply to every adapter

- **An explicit per-call model always wins** and is never overwritten. This includes `options.model` on nicobailon, per-item models in `tasks[]` and `chain[]`, and child models in `children[]`.
- **Resume and management calls are never given a model.** `action` (nicobailon), `resume` (`@tintinweb`, `@gotgenes`), and `resumeSessionId` (HazAT) are left untouched.
- **Agent keys are case-sensitive by default.** The extension tries the exact key first, then `"*"`. Set `"agentMatch": "case-insensitive"` on the profile to add a case-insensitive pass before `"*"`.
- An unresolvable selector, or one the adapter cannot express (`@alias`, glob, or a bare id where unsupported), is not injected. The plugin's default routing applies and a one-time TUI warning appears.
- Under omp, selectors are validated with `ctx.models.resolve()`. Under upstream pi they are checked against `modelRegistry`: a leading `@` is unresolvable, a known `:level` suffix is stripped, a glob is passed through, and `provider/id` or a bare id is looked up. A `provider/id` selector must also report configured auth through `hasConfiguredAuth()`. If the provider reading misses, the whole base is retried as a bare id, because model ids may contain `/`. Comparisons are case-sensitive because the child resolves ids exactly.
- Calls that bypass `tool_call` are not intercepted. This includes workflow scripts (apart from the top-level default), agent mentions, `/subagent` commands, service APIs, and cross-extension RPC.

## `/model-sync` command

All command help, output, notifications, and config error messages are in English.

| Command | Description |
|---|---|
| `/model-sync` or `/model-sync list` | Show the active layer, active preset, and its profiles (plus the other layer when that file exists) |
| `/model-sync show [model] [agent]` | Show the current or requested model, active preset, matched profile, and selector resolution status, including the installed plugin dialects that accept each selector |
| `/model-sync add <main> <model>` | Add or update a profile in the active preset (all subagents use `<model>`) |
| `/model-sync set <main> <agent> <model>` | Set a model for one agent in the active preset (`*` sets or updates the profile default while keeping per-agent entries) |
| `/model-sync remove <main> [agent]` | Remove a whole profile or one agent entry from the active preset |
| `/model-sync move <main> <top\|bottom\|up\|down>` | Reorder a profile in the active preset |
| `/model-sync preset list` | List the presets in the active layer (`*` marks the active one) |
| `/model-sync preset create <name>` | Create an empty, inactive preset |
| `/model-sync preset copy <source> <name>` | Deep-copy a preset into a new inactive preset (never overwrites) |
| `/model-sync preset rename <old> <new>` | Rename a preset in place and keep its profiles |
| `/model-sync preset use [name]` | Select the active preset (no-op when it is already active); with no name and a UI, show an interactive picker |
| `/model-sync preset remove <name>` | Remove a preset; the active preset is refused |
| `/model-sync status [off]` | Show session routing state and set the status bar; `off` clears it |
| `/model-sync use-session <preset\|off>` | Route this session with an existing preset without writing the config; `off` clears it |
| `/model-sync pause` | Pause routing for this session |
| `/model-sync resume` | Resume routing for this session |
| `/model-sync log [clear]` | Show or clear the last 50 routing decisions for this session |
| `/model-sync doctor` | Scan both layers for unknown keys, shadowed rules, selector gaps, and case-only agent keys |
| `/model-sync init` | Create a starter preset from the current model |
| `/model-sync help` | Show the top-level usage |
| `/model-sync preset help` | Show the preset usage |

Commands reject extra arguments and unknown `--` options with a usage hint. Single or double quotes keep a value with spaces together; preset names still cannot contain whitespace. A missing config file is not an error. `list` and `preset list` print the first-run hint, and the first write creates the file.

`add`, `set`, `remove`, and `move` edit only the active preset of the target layer and refuse to write when no preset is active or the active name dangles. `preset create`, `preset copy`, and `preset rename` leave the active profile list unchanged; rename updates the active name when the old name was active. `preset list` always reports the active layer, so `--project` only affects writes for that command.

`show` reports the host resolution and the installed plugin dialects that accept each selector. Typing `/model-sync ` or `/model-sync preset ` opens argument completion with descriptions for each subcommand. A typed `--project` flag is preserved in the completion value and is not suggested twice. `add` completes existing profile `main` values and authenticated model ids for the first argument, and model ids for the second. `set`, `remove`, and `move` complete existing profile `main` values and agent keys from the target layer's active preset. `show` completes the model and, after a model, the agent keys from the matched profile. `preset use`, `preset remove`, `preset copy`, and `preset rename` suggest existing preset names from the target config layer. Completion also suggests `off` or `clear` for `status` and `log`. Preset names are global by default; include `--project` before the name to complete project-layer names.

## Updating

No self-update machinery. The hosts' package managers own updates.

| Installed via | Update with |
|---|---|
| `pi install npm:...` | `pi update --extensions` (or `pi update --all`) |
| `pi install git:...@vX.Y.Z` | Pinned by ref: reinstall with a newer tag to move |
| `omp plugin install npm:...` | `omp plugin upgrade pi-model-sync` |
| `omp plugin install pi-model-sync@sencha930511` | `omp plugin upgrade pi-model-sync@sencha930511` |
| `omp plugin install git:...` / copied directory | `git pull` / re-copy |

## Troubleshooting

**`/model-sync list` says "No config file yet."**
That is the first-run state. Create a profile with `/model-sync add <main> <model>` or write the JSON file directly.

**Nothing is being intercepted.**
Check `/model-sync show`. If it reports a config error, no active preset, or a dangling preset name, fix that first. If the profile matches but the selector is marked unresolvable, the host cannot resolve it; use a selector the host knows. For plugin calls, confirm the plugin's tool is registered in this session. A plugin that failed to load cannot be intercepted.

**A session override or pause is active.**
Run `/model-sync status`. `use-session` and `pause` affect only the current session and never write the config. Use `use-session off` or `resume` to clear them.

**A plugin tool is not intercepted, but the config looks right.**
The plugin may not expose a per-call `model` field, or the call may be a resume or management action. Calls that bypass `tool_call` (workflow scripts, agent mentions, `/subagent` commands, service APIs) are not intercepted. Also check that the agent key matches the plugin's name exactly; keys are case-sensitive unless the profile sets `"agentMatch": "case-insensitive"`.

**`show` says no plugin accepts a selector.**
`show` lists the installed plugin dialects that can express each selector. Check the adapter rules below; an exact-only plugin rejects a bare id, and a Claude-style plugin rejects `@alias` and glob.

**A real plugin fails to load on omp.**
The plugin may need a TUI API that omp does not provide. `pi-subagents@0.88.1` needs `MouseRegion`, which omp 18.20.3 lacks. Check the plugin's own host requirements. The extension only sees tools that the host successfully registers.

**I wrote the global file, but the project file still wins.**
An existing project file wholly replaces the global file. Use `--project` to edit the project layer, or remove the project file.

**A running subagent did not switch models.**
That is expected. Running subagents never switch mid-flight. The new mapping applies to later spawns.

## Development and verification

The package has zero runtime dependencies and zero root dev dependencies. The host runs the TypeScript sources directly.

Install the isolated CI tools once:

```sh
npm ci --prefix .github/omp-tools
```

Run the full check:

```sh
npm run check
```

It covers:

- strict typechecking (`scripts/typecheck.mjs`, `scripts/tsconfig.typecheck.json`, `scripts/host-stub.d.ts`);
- a compile-time contract probe against the installed omp and upstream pi type packages (`scripts/host-contract.ts`, `scripts/tsconfig.hosts.json`);
- release version consistency;
- release helper `node:test` suites;
- the runtime load graph (`scripts/test-load-graph.ts`);
- Bun behavioral suites (`test/portable.test.ts`, `test/adapters.test.ts`, `test/commands.test.ts`, `test/features.test.ts`, `test/resolver.test.ts`, `test/posix.test.ts`);
- packed-tarball installation, isolated-home `omp` loading, and upstream pi RPC execution of `/model-sync list` (`scripts/test-packed.mjs`).

The adapter suite covers schema fingerprints, same-named tool separation, call-shape fallback, ambiguity handling, explicit-model and resume guards, selector dialects, and model injection. The portable suite covers config paths, parsing, projection, matching, the spawn and `tool_call` hooks, commands, and completions. The command, feature, and resolver suites cover command guards, session overrides, pause and resume, status, route log, doctor, init, interactive preset use, completion, and selector resolution. `npm run test:unit` enforces a per-file coverage ratchet of 88% lines and 95% functions; the POSIX-only symlink test runs in `test:posix`.

Manual host verification is still useful for interactive UX. Load the extension with a throwaway config:

```sh
PI_MODEL_SYNC_CONFIG=/tmp/test.json omp --extension /path/to/pi-model-sync
PI_MODEL_SYNC_CONFIG=/tmp/test.json pi --extension /path/to/pi-model-sync
```

Then exercise `/model-sync add|set|list|show|remove|move`, the `preset` commands, `use-session`, `pause`, `resume`, `status`, `log`, `doctor`, `init`, completion, and a real subagent spawn. The plugin adapters have been exercised against the published schemas of all six supported plugins. A real `pi-subagents@0.88.1` child delegation was verified on upstream pi 1.5.2, including the routed child model.

## Contributing

See [CONTRIBUTING.md](https://github.com/SenCha930511/pi-model-sync/blob/main/CONTRIBUTING.md). Review expectations and conventions live in [AGENTS.md](https://github.com/SenCha930511/pi-model-sync/blob/main/AGENTS.md).

## License

[MIT](LICENSE) © SenCha930511.
