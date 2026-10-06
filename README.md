# pi-model-sync

[![npm version](https://img.shields.io/npm/v/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![npm downloads](https://img.shields.io/npm/dm/@sencha930511/pi-model-sync)](https://www.npmjs.com/package/@sencha930511/pi-model-sync)
[![GitHub stars](https://img.shields.io/github/stars/SenCha930511/pi-model-sync)](https://github.com/SenCha930511/pi-model-sync)
[![License: MIT](https://img.shields.io/github/license/SenCha930511/pi-model-sync)](LICENSE)

An extension for **omp (oh my pi) and upstream pi**: rewrites the model used by subsequent subagents based on the *spawning session's current model*. Three routing paths are supported:

- omp native subagents (task / eval `agent()` / workpool workers).
- The `subagent` tool of [pi-subagent](https://github.com/mjakl/pi-subagent) (`@mjakl/pi-subagent`), under both omp and upstream pi (pi-subagent itself requires Pi ≥ 0.87.1 or a compatible host).
- omp's **advisor** role: the matched profile's `advisor` entry is applied to the host's advisor model role, so the paired advisor session follows the profile table too (omp only; upstream pi has no settings API for this).

After the main model changes, **newly spawned/delegated** subagents switch to the model mapped by the matching profile; running subagents never switch mid-flight. Nested spawns (a subagent spawning further subagents) are intercepted too: the lookup key is the spawning session's current model.

## Installation

No build, no dependencies — both hosts run the TypeScript sources directly.

### omp

```sh
# from git (pin a tag for a fixed version)
omp plugin install git:github.com/SenCha930511/pi-model-sync@v0.2.0
# or from npm (the same package feeds the Pi gallery)
omp plugin install npm:@sencha930511/pi-model-sync
```

### upstream pi

```sh
# from npm (listed in the Pi package gallery at pi.dev/packages)
pi install npm:@sencha930511/pi-model-sync
# or straight from git
pi install git:github.com/SenCha930511/pi-model-sync@v0.2.0
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

Two layers, same JSON format:

- **Global**: `~/.omp/agent/pi-model-sync.json`
  - `PI_MODEL_SYNC_CONFIG` overrides the path (relative paths resolve against cwd).
  - When `PI_CODING_AGENT_DIR` is set: `<its value>/pi-model-sync.json` (lower precedence than `PI_MODEL_SYNC_CONFIG`).
  - Dual-host landing: when none of the above applies, if the `~/.omp` file does **not** exist and `~/.pi/agent/pi-model-sync.json` does, the `.pi` path is used; when neither exists, the write target stays the `~/.omp` path.
- **Project**: `<repo>/.omp/pi-model-sync.json` (current directory only, no upward search)
  - Isomorphic fallback: when the `.omp` file does not exist and `<repo>/.pi/pi-model-sync.json` does, the `.pi` path is used.

**An existing project file wholly replaces the global file** (no per-key merge; a broken-JSON project file counts as "exists with no profiles").

```json
{
  "profiles": [
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
  ]
}
```

- `main`: the main model to match (rules below).
- `subagents`:
  - a string → every agent under this profile uses that model;
  - an object → keys are agent names (e.g. `task`, `scout`); `"*"` is the profile default.
  - `advisor` is honored as omp's advisor model role (see "Advisor routing"); other model-role names (e.g. `plan`) match no spawnable agent and are inert.
- Selectors pass through verbatim to host resolution: `provider/id`, bare `id`, role aliases (e.g. `@smol`), and `:level` suffixes (e.g. `openai/gpt-6-luna:high`) are handed to the host resolver as-is. Under upstream pi, see "pi-subagent routing rules" for validation semantics.

## Matching rules

- `main` without `*` → exact equality against `provider/id` or bare `id` (case-insensitive).
- `main` with `*` → explicit glob wildcard (`*` crosses `/`), tested against both the `provider/id` and bare `id` forms.
- No implicit substring matching; the **first** match in file order wins.

## pi-subagent routing rules

The extension intercepts pi-subagent's `subagent` tool input `{calls: [{agent, prompt, model?, ...}]}` at `tool_call` time: when a call has no `model`, the spawning session's current model is matched against profile `main`, the call's `agent` name picks a selector (exact key first, then `"*"`; key matching is **case-sensitive** — align pi-subagent agent names with profile keys manually), and `call.model` is injected. All other fields (`prompt`, `thinking`, `cwd`, `session`, ...) are preserved.

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

## Advisor routing (omp)

omp's advisor is a paired session, not a spawnable subagent — neither delegation path can intercept it. When the matched profile has an `advisor` entry, the extension applies it through omp's exported settings singleton (`settings.setModelRole("advisor", ...)`):

- Checked on `session_start` and every `turn_start` (compared first; a same-value call is a no-op), covering both new sessions and mid-session `/model` switches.
- omp persists the value per-role into `config.yml` (`modelRoles.advisor`) and hot-rebuilds the live advisor — no restart needed.
- Removing the `advisor` entry from the profile stops management; the role keeps its last value until you reset it (e.g. back to `"@default"`).
- Only the main session writes the role; subagent sessions never touch it.
- Upstream pi exports no settings API — the entry is skipped there with a one-time TUI warning.
- When routing takes effect, a notification shows: `pi-model-sync: advisor → <model> (main: <main>)`.

## /model-sync command

All command help, output, notifications, and config error messages are in English.

| Command | Description |
|---|---|
| `/model-sync` or `/model-sync list` | Show the active layer and all profiles |
| `/model-sync show` | Show the current model, matched profile, and selector resolution status |
| `/model-sync add <main> <model>` | Add/update a profile (all subagents use `<model>`) |
| `/model-sync set <main> <agent> <model>` | Set a model for one agent (when `<agent>` is `*`, sets the profile default) |
| `/model-sync remove <main> [agent]` | Remove a whole profile, or one agent entry |

## Updating

No self-update machinery — the hosts' package managers own updates:

| Installed via | Update with |
|---|---|
| `pi install npm:...` | `pi update --extensions` (or `pi update --all`) |
| `pi install git:...@vX.Y.Z` | Pinned by ref: reinstall with a newer tag to move |
| `omp plugin install npm:...` | `omp plugin upgrade pi-model-sync` |
| `omp plugin install git:...` / copied directory | `git pull` / re-copy |

Commands write to the **global** file by default; any subcommand with `--project` writes the **project** file. You can also edit the JSON directly (changes are detected via an mtime cache and take effect on save).

## Notes

- Running subagents never switch mid-flight; switching the main model only affects later spawns.
- Nested spawns resolve against the spawning session's current model (a child session only knows its own model — the only clean API). This happens only when the host allows nesting depth ≥ 2; the cap is governed by `task.maxRecursionDepth` (omp doc default 2, negative = unlimited); at the cap, the subagent's task tool is removed so it cannot spawn further.
- When a profile selector is unresolvable, that spawn or delegation is not intercepted — default routing applies — and a warning shows once per selector in the TUI.
- For omp-native spawns, when routing takes effect the task card / Agent Hub shows the routing note: `pi-model-sync: <agent> → <model> (main: <main>)`. pi-subagent delegations show the injected model in the call rendering instead — no extra note, by design.
- Advisor routing rewrites `modelRoles.advisor` in `config.yml` while a profile `advisor` entry is active; that line is plugin-managed state, not a hand-edited value.
- Startup is fully silent: no session-start notification (the advisor path only notifies when it actually changes the role).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Review expectations and conventions live in [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © SenCha930511.
