/**
 * `/model-sync` command dispatch, writes, and display. All writes target one layer
 * (global by default, `--project` for the project layer) and one preset (the on-disk
 * active preset). Session overrides and pauses live in SessionState and never write.
 */

import type { SubagentAdapter } from "./adapters";
import {
  cloneConfig,
  cloneProfiles,
  cloneSubagentMap,
  findProfile,
  getGlobalConfigPath,
  getPresetProfiles,
  getProjectConfigPath,
  isNamedConfig,
  isValidPresetName,
  pickSubagentSelector,
  presetNames,
  projectActiveProfiles,
  readLayer,
  resolveActiveLayer,
  summarizeSubagents,
  toPresetConfig,
  writeConfig,
} from "./config";
import type {
  CurrentModelRef,
  EffectiveConfig,
  ModelSyncConfig,
  PresetMap,
  Profile,
  SessionSelection,
} from "./config";
import {
  adapterAcceptsSelector,
  createRegistrySnapshot,
  currentModelRef,
  formatModelRef,
  installedAdapters,
  parseSelector,
  readToolInfos,
  selectorRefs,
  selectorResolvable,
} from "./resolver";
import type { ExtensionContextLike, RegistrySnapshot, ToolHost } from "./resolver";
import {
  applyStatus,
  notify,
  refreshSessionCache,
  ROUTE_LOG_LIMIT,
  sessionSelection,
  statusText,
} from "./session";
import type { SessionState } from "./session";

export interface CommandHost {
  state: SessionState;
  pi?: ToolHost;
}

const POSITION_DESCRIPTIONS: Record<string, string> = {
  top: "Move to the top",
  bottom: "Move to the bottom",
  up: "Move up one position",
  down: "Move down one position",
};

const USAGE = [
  "pi-model-sync commands:",
  "  /model-sync [list]                      Show the active layer, active preset, and all profiles",
  "  /model-sync show [model] [agent]        Show the current or requested model, matched profile, and selector status",
  "  /model-sync add <main> <model>          Add/update a profile in the active preset (all subagents use <model>)",
  "  /model-sync set <main> <agent> <model>  Set a model for one agent (use * for the profile default)",
  "  /model-sync remove <main> [agent]       Remove a whole profile or one agent entry",
  "  /model-sync move <main> <top|bottom|up|down>  Reorder a profile in the active preset",
  "  /model-sync preset list                 List presets in the active layer",
  "  /model-sync preset create <name>        Create an empty inactive preset",
  "  /model-sync preset copy <source> <name> Deep-copy a preset without switching to it",
  "  /model-sync preset rename <old> <new>   Rename a preset without changing its profiles",
  "  /model-sync preset use [name]           Select the active preset (interactive when the name is omitted)",
  "  /model-sync preset remove <name>        Remove an inactive preset",
  "  /model-sync status [off]                Show session routing state; set or clear the status bar",
  "  /model-sync use-session <preset|off>    Route this session with a preset without saving",
  "  /model-sync pause | resume              Pause or resume routing for this session",
  "  /model-sync log [clear]                 Show or clear recent routing decisions",
  "  /model-sync doctor                      Check both config layers for problems",
  "  /model-sync init                        Create a starter config from the current model",
  "Writes use the global file by default. Add --project to target <cwd>/.omp/pi-model-sync.json (or <cwd>/.pi/pi-model-sync.json when the .omp file is absent and the .pi file exists).",
].join("\n");

const PRESET_USAGE = [
  "pi-model-sync preset commands:",
  "  /model-sync preset list",
  "  /model-sync preset create <name>",
  "  /model-sync preset copy <source> <name>",
  "  /model-sync preset rename <old> <new>",
  "  /model-sync preset use [name]",
  "  /model-sync preset remove <name>",
].join("\n");

// ── command parsing ─────────────────────────────────────────────

interface CommandToken {
  value: string;
  quoted: boolean;
}

/** Split on whitespace, honour single and double quotes, and keep whether a token was quoted. */
export function parseCommandLine(input: string): CommandToken[] | null {
  const tokens: CommandToken[] = [];
  let current = "";
  let quoted = false;
  let quote: "'" | '"' | null = null;
  let started = false;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        quoted = true;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) {
        tokens.push({ value: current, quoted });
        current = "";
        quoted = false;
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== null) return null;
  if (started || current.length > 0) tokens.push({ value: current, quoted });
  return tokens;
}

function flagValue(tokens: CommandToken[], name: string): boolean {
  return tokens.some((token) => !token.quoted && token.value === name);
}

function unknownFlag(tokens: CommandToken[]): string | undefined {
  const allowed = new Set(["--project", "--help", "-h"]);
  return tokens.find((token) => !token.quoted && token.value.startsWith("-") && !allowed.has(token.value))?.value;
}

function positional(tokens: CommandToken[]): string[] {
  return tokens
    .filter((token) => token.quoted || (token.value !== "--project" && token.value !== "--help" && token.value !== "-h"))
    .map((token) => token.value);
}

// ── command dispatch (decisions 5, 9) ───────────────────────────

export async function commandHandler(
  argsString: string,
  ctx: ExtensionContextLike,
  host: CommandHost,
): Promise<void> {
  try {
    await handleCommand(String(argsString ?? ""), ctx, host);
  } catch (err) {
    notify(
      ctx,
      `pi-model-sync: command failed: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
  }
}

async function handleCommand(
  argsString: string,
  ctx: ExtensionContextLike,
  host: CommandHost,
): Promise<void> {
  const tokens = parseCommandLine(argsString);
  if (!tokens) {
    notify(ctx, `Unbalanced quotes in command.\n${USAGE}`, "warning");
    return;
  }
  const invalid = unknownFlag(tokens);
  if (invalid !== undefined) {
    notify(ctx, `Unknown option "${invalid}".\n${USAGE}`, "warning");
    return;
  }
  const useProject = flagValue(tokens, "--project");
  const help = flagValue(tokens, "--help") || flagValue(tokens, "-h");
  const args = positional(tokens);
  const [sub, ...rest] = args;
  if (help) {
    notify(ctx, sub === "preset" ? PRESET_USAGE : USAGE);
    return;
  }
  const target = useProject ? getProjectConfigPath(ctx.cwd) : getGlobalConfigPath(ctx.cwd);
  refreshSessionCache(ctx, host.state);

  switch (sub) {
    case undefined:
    case "":
    case "list":
      if (rest.length > 0) {
        notify(ctx, `Unexpected argument for list: ${rest[0]}\n${USAGE}`, "warning");
        return;
      }
      cmdList(ctx, host);
      return;
    case "show": {
      if (rest.length > 2) {
        notify(ctx, `Usage: /model-sync show [model] [agent]\n${USAGE}`, "warning");
        return;
      }
      const [modelArg, agentArg] = rest;
      cmdShow(ctx, host, modelArg, agentArg);
      return;
    }
    case "add": {
      const [main, model] = rest;
      if (rest.length !== 2 || !main || !model) {
        notify(ctx, "Usage: /model-sync add <main> <model>", "warning");
        return;
      }
      cmdAdd(ctx, target, host, main, model);
      return;
    }
    case "set": {
      const [main, agent, model] = rest;
      if (rest.length !== 3 || !main || !agent || !model) {
        notify(ctx, "Usage: /model-sync set <main> <agent> <model>", "warning");
        return;
      }
      cmdSet(ctx, target, host, main, agent, model);
      return;
    }
    case "remove": {
      const [main, agent] = rest;
      if (rest.length < 1 || rest.length > 2 || !main || (agent !== undefined && !agent)) {
        notify(ctx, "Usage: /model-sync remove <main> [agent]", "warning");
        return;
      }
      cmdRemove(ctx, target, host, main, agent);
      return;
    }
    case "move": {
      const [main, position] = rest;
      if (rest.length !== 2 || !main || !position) {
        notify(ctx, "Usage: /model-sync move <main> <top|bottom|up|down>", "warning");
        return;
      }
      cmdMove(ctx, target, host, main, position);
      return;
    }
    case "preset":
      await handlePresetCommand(ctx, target, host, rest);
      return;
    case "status":
      if (rest.length > 1) {
        notify(ctx, "Usage: /model-sync status [off]", "warning");
        return;
      }
      cmdStatus(ctx, host, rest[0]);
      return;
    case "use-session": {
      const [name] = rest;
      if (rest.length !== 1 || !name) {
        notify(ctx, "Usage: /model-sync use-session <preset|off>", "warning");
        return;
      }
      cmdUseSession(ctx, host, name);
      return;
    }
    case "pause":
      if (rest.length > 0) {
        notify(ctx, "Usage: /model-sync pause", "warning");
        return;
      }
      cmdPause(ctx, host);
      return;
    case "resume":
      if (rest.length > 0) {
        notify(ctx, "Usage: /model-sync resume", "warning");
        return;
      }
      cmdResume(ctx, host);
      return;
    case "log":
      if (rest.length > 1) {
        notify(ctx, "Usage: /model-sync log [clear]", "warning");
        return;
      }
      cmdLog(ctx, host, rest[0]);
      return;
    case "doctor":
      if (rest.length > 0) {
        notify(ctx, "Usage: /model-sync doctor", "warning");
        return;
      }
      cmdDoctor(ctx, host);
      return;
    case "init":
      if (rest.length > 0) {
        notify(ctx, "Usage: /model-sync init", "warning");
        return;
      }
      cmdInit(ctx, useProject ? target : resolveActiveLayer(ctx.cwd).path, host);
      return;
    case "help":
      if (rest.length > 0) {
        notify(ctx, `Unexpected argument for help: ${rest[0]}\n${USAGE}`, "warning");
        return;
      }
      notify(ctx, USAGE);
      return;
    default:
      notify(ctx, USAGE);
  }
}

async function handlePresetCommand(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  args: string[],
): Promise<void> {
  const [action, ...presetArgs] = args;
  if (!action) {
    notify(ctx, PRESET_USAGE);
    return;
  }
  switch (action) {
    case "list":
      if (presetArgs.length > 0) {
        notify(ctx, `Unexpected argument for preset list: ${presetArgs[0]}\n${PRESET_USAGE}`, "warning");
        return;
      }
      cmdPresetList(ctx, host);
      return;
    case "create": {
      const [name] = presetArgs;
      if (presetArgs.length !== 1 || !name) {
        notify(ctx, "Usage: /model-sync preset create <name>", "warning");
        return;
      }
      cmdPresetCreate(ctx, target, host, name);
      return;
    }
    case "copy": {
      const [source, name] = presetArgs;
      if (presetArgs.length !== 2 || !source || !name) {
        notify(ctx, "Usage: /model-sync preset copy <source> <name>", "warning");
        return;
      }
      cmdPresetCopy(ctx, target, host, source, name);
      return;
    }
    case "rename": {
      const [oldName, newName] = presetArgs;
      if (presetArgs.length !== 2 || !oldName || !newName) {
        notify(ctx, "Usage: /model-sync preset rename <old> <new>", "warning");
        return;
      }
      cmdPresetRename(ctx, target, host, oldName, newName);
      return;
    }
    case "use": {
      if (presetArgs.length > 1) {
        notify(ctx, "Usage: /model-sync preset use [name]", "warning");
        return;
      }
      await cmdPresetUse(ctx, target, host, presetArgs[0]);
      return;
    }
    case "remove": {
      const [name] = presetArgs;
      if (presetArgs.length !== 1 || !name) {
        notify(ctx, "Usage: /model-sync preset remove <name>", "warning");
        return;
      }
      cmdPresetRemove(ctx, target, host, name);
      return;
    }
    case "help":
      if (presetArgs.length > 0) {
        notify(ctx, `Unexpected argument for preset help: ${presetArgs[0]}\n${PRESET_USAGE}`, "warning");
        return;
      }
      notify(ctx, PRESET_USAGE);
      return;
    default:
      notify(ctx, `Unknown preset command: ${action}\n${PRESET_USAGE}`, "warning");
  }
}

// ── write helpers ───────────────────────────────────────────────

/** Save, then warn when a project layer is shadowing the global file that was just written. */
function saveConfig(
  ctx: ExtensionContextLike,
  target: string,
  config: ModelSyncConfig,
  message: string,
  host: CommandHost,
): void {
  writeConfig(target, config);
  const active = resolveActiveLayer(ctx.cwd);
  const shadow =
    active.layer === "project" && target !== active.path
      ? `\nNote: the project config (${active.path}) overrides the global config. Add --project to edit it.`
      : "";
  notify(ctx, `${message}${shadow}`);
  if (host.state.statusVisible) {
    applyStatus(ctx, host.state, statusText(host.state, diskActivePreset(ctx)));
  }
}

/** Read target for writing; refuse a corrupt existing file and surface entries a rewrite would drop. */
function loadForWrite(ctx: ExtensionContextLike, target: string): ModelSyncConfig | null {
  const layer = readLayer(target);
  if (layer.error) {
    notify(
      ctx,
      `pi-model-sync: ${layer.error}\nRepair or delete this file before running a write command.`,
      "error",
    );
    return null;
  }
  if (layer.warnings.length > 0) {
    notify(
      ctx,
      `pi-model-sync: config warnings:\n${layer.warnings.join("\n")}\nThese entries will be dropped when the file is rewritten.`,
      "warning",
    );
  }
  // Full-document clone: every preset and every nested subagent map stays isolated
  // from the shared cache, not just the active preset.
  return cloneConfig(layer.config);
}

function availablePresetsHint(config: ModelSyncConfig): string {
  const names = presetNames(config);
  if (names.length === 0) return "No presets yet (/model-sync preset create <name>).";
  return `Available presets: ${names.join(", ")}. Run /model-sync preset use <name> to select one.`;
}

/** Resolve the on-disk active preset on a cloned document; a missing/dangling selection fails closed. */
function loadActiveForWrite(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
): { config: ModelSyncConfig; profiles: Profile[] } | null {
  const config = loadForWrite(ctx, target);
  if (!config) return null;
  const effective = projectActiveProfiles(config);
  if (effective.warning || !effective.activePreset) {
    const warning = effective.warning ?? "No active preset is selected; no profiles are active.";
    notify(
      ctx,
      `pi-model-sync: ${warning}\n${availablePresetsHint(config)}\nNo changes were written (target: ${target}).`,
      "warning",
    );
    return null;
  }
  if (host.state.paused) {
    notify(
      ctx,
      "Routing is paused for this session; this write still targets the on-disk active preset.",
      "info",
    );
  } else if (host.state.presetOverride !== undefined) {
    notify(
      ctx,
      `Session preset "${host.state.presetOverride}" is active; this write still targets the on-disk active preset.`,
      "info",
    );
  }
  return { config, profiles: effective.profiles };
}

function findProfileIndexByMain(profiles: Profile[], main: string): number {
  const mainLower = main.toLowerCase();
  return profiles.findIndex((profile) => profile.main.toLowerCase() === mainLower);
}

/** Warn when an appended literal rule would be shadowed by an earlier matching profile. */
function shadowWarning(profiles: Profile[], main: string): string {
  const parsed = parseSelector(main);
  if (!parsed || parsed.kind !== "reference") return "";
  const refs = selectorRefs(parsed);
  if (parsed.provider === undefined) {
    for (const profile of profiles) {
      const earlier = parseSelector(profile.main);
      if (!earlier || earlier.kind !== "reference" || earlier.provider === undefined) continue;
      refs.push({ provider: earlier.provider, id: parsed.base });
    }
  }
  const shadow = refs.map((ref) => findProfile({ profiles }, ref)).find((hit) => hit !== undefined);
  return shadow ? `\nNote: profile "${shadow.main}" appears earlier and may match this model first.` : "";
}

// ── profile commands ────────────────────────────────────────────

function cmdAdd(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  main: string,
  model: string,
): void {
  const loaded = loadActiveForWrite(ctx, target, host);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  let note = "";
  if (index >= 0) {
    const existing = profiles[index];
    if (!existing) return;
    const keys = typeof existing.subagents === "string" ? [] : Object.keys(existing.subagents);
    if (keys.some((key) => key !== "*")) {
      note = "\nNote: replaced the existing per-agent entries for this profile.";
    }
    existing.main = main;
    existing.subagents = model;
  } else {
    note = shadowWarning(profiles, main);
    profiles.push({ main, subagents: model });
  }
  saveConfig(ctx, target, config, `Saved to ${target}\n  ${main} → ${model}${note}`, host);
}

function cmdSet(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  main: string,
  agent: string,
  model: string,
): void {
  const loaded = loadActiveForWrite(ctx, target, host);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  const existing = index >= 0 ? profiles[index] : undefined;
  const shadow = existing ? "" : shadowWarning(profiles, main);
  const profile: Profile = existing ?? { main, subagents: agent === "*" ? model : cloneSubagentMap({}) };
  profile.main = main;
  if (agent === "*") {
    // Profile default: preserve existing per-agent entries; collapse to the plain
    // string form only when no per-agent entry exists (set * must not behave like add).
    // Mirrors cmdRemove's collapse so both writers keep the same documented shape.
    const hasPerAgentEntry =
      typeof profile.subagents !== "string" && Object.keys(profile.subagents).some((key) => key !== "*");
    if (!hasPerAgentEntry) {
      profile.subagents = model;
    } else {
      const map = cloneSubagentMap(profile.subagents);
      map["*"] = model;
      profile.subagents = map;
    }
  } else {
    // Null-prototype map (same hardening as the parse boundary): an exotic agent name like
    // "__proto__" must stay an own property instead of being coerced away on assignment.
    const map = cloneSubagentMap(
      typeof profile.subagents === "string" ? { "*": profile.subagents } : profile.subagents,
    );
    map[agent] = model;
    profile.subagents = map;
  }
  if (!existing) profiles.push(profile);
  saveConfig(
    ctx,
    target,
    config,
    `Saved to ${target}\n  ${main} → ${summarizeSubagents(profile.subagents)}${shadow}`,
    host,
  );
}

function cmdRemove(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  main: string,
  agent: string | undefined,
): void {
  const loaded = loadActiveForWrite(ctx, target, host);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  if (index < 0) {
    notify(ctx, `No profile found for main ${main} (target: ${target})`, "warning");
    return;
  }
  const profile = profiles[index];
  if (!profile) return;
  if (agent !== undefined) {
    if (typeof profile.subagents === "string") {
      notify(ctx, `This profile has a single default model; use /model-sync remove ${main}`, "warning");
      return;
    }
    if (!Object.hasOwn(profile.subagents, agent)) {
      const available = Object.keys(profile.subagents).join(", ");
      notify(
        ctx,
        `Profile ${main} has no entry for agent "${agent}"${available ? `\nAvailable agents: ${available}` : ""}`,
        "warning",
      );
      return;
    }
    const map = cloneSubagentMap(profile.subagents);
    delete map[agent];
    const keys = Object.keys(map);
    if (keys.length === 0) {
      profiles.splice(index, 1);
    } else if (keys.length === 1 && keys[0] === "*") {
      const only = map["*"];
      if (only !== undefined) profile.subagents = only;
    } else {
      profile.subagents = map;
    }
  } else {
    profiles.splice(index, 1);
  }
  saveConfig(ctx, target, config, `Saved to ${target}`, host);
}

function cmdMove(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  main: string,
  position: string,
): void {
  if (!Object.hasOwn(POSITION_DESCRIPTIONS, position)) {
    notify(ctx, "Usage: /model-sync move <main> <top|bottom|up|down>", "warning");
    return;
  }
  const loaded = loadActiveForWrite(ctx, target, host);
  if (!loaded) return;
  const { config, profiles } = loaded;
  const index = findProfileIndexByMain(profiles, main);
  if (index < 0) {
    notify(ctx, `No profile found for main ${main} (target: ${target})`, "warning");
    return;
  }
  let targetIndex = index;
  if (position === "top") targetIndex = 0;
  else if (position === "bottom") targetIndex = profiles.length - 1;
  else if (position === "up") targetIndex = index - 1;
  else targetIndex = index + 1;
  if (targetIndex < 0 || targetIndex >= profiles.length) {
    const edge = position === "up" ? "top" : "bottom";
    notify(ctx, `Profile ${main} is already at the ${edge} of the active preset (target: ${target}).`, "warning");
    return;
  }
  if (targetIndex === index) {
    notify(ctx, `Profile ${main} is already in that position (target: ${target}).`);
    return;
  }
  const removed = profiles.splice(index, 1);
  profiles.splice(targetIndex, 0, ...removed);
  saveConfig(
    ctx,
    target,
    config,
    `Moved profile ${main} to position ${targetIndex + 1} of ${profiles.length} (${target}).`,
    host,
  );
}

// ── preset commands ─────────────────────────────────────────────

function formatActivePreset(config: ModelSyncConfig, effective: EffectiveConfig): string {
  if (!effective.activePreset) return "(none)";
  return isNamedConfig(config) ? effective.activePreset : `${effective.activePreset} (legacy)`;
}

function cmdPresetList(ctx: ExtensionContextLike, host: CommandHost): void {
  const view = loadActiveLayerView(ctx.cwd);
  const lines: string[] = [];
  const ok = appendLayerSummary(
    lines,
    view,
    `pi-model-sync active layer: ${view.layer.layer} (${view.layer.path})`,
  );
  if (!ok) {
    if (!view.exists) lines.push("No presets yet (/model-sync preset create <name>)");
    notify(ctx, lines.join("\n"));
    return;
  }
  if (host.state.paused) lines.push("Session routing: paused");
  else if (host.state.presetOverride !== undefined) {
    lines.push(`Session preset: ${host.state.presetOverride} (not saved)`);
  }
  const names = presetNames(view.config);
  if (names.length === 0) {
    lines.push("No presets yet (/model-sync preset create <name>)");
  } else {
    const legacySuffix = isNamedConfig(view.config) ? "" : " (legacy)";
    for (const name of names) {
      lines.push(`  ${view.effective.activePreset === name ? "*" : " "} ${name}${legacySuffix}`);
    }
  }
  notify(ctx, lines.join("\n"));
}

function cmdPresetCreate(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  name: string,
): void {
  if (!isValidPresetName(name)) {
    notify(ctx, `Invalid preset name "${name}". Preset names must be single tokens.`, "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Preset "default" is the virtual legacy preset and cannot be created (target: ${target}).`, "warning");
      return;
    }
    const converted = toPresetConfig(config);
    converted.presets[name] = [];
    const note =
      config.profiles.length > 0
        ? `\nLegacy profiles moved to preset "default" (active).`
        : `\nActive preset: default.`;
    saveConfig(ctx, target, converted, `Created preset "${name}" (inactive) in ${target}${note}`, host);
    return;
  }
  if (Object.hasOwn(config.presets, name)) {
    notify(ctx, `Preset "${name}" already exists (target: ${target}).`, "warning");
    return;
  }
  config.presets[name] = [];
  saveConfig(ctx, target, config, `Created preset "${name}" (inactive) in ${target}`, host);
}

function cmdPresetCopy(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  source: string,
  name: string,
): void {
  if (!isValidPresetName(source) || !isValidPresetName(name)) {
    notify(ctx, "Invalid preset name. Preset names must be single tokens.", "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Preset "default" already exists (target: ${target}).`, "warning");
      return;
    }
    if (source !== "default") {
      notify(ctx, `Preset "${source}" not found. Available presets: default (target: ${target}).`, "warning");
      return;
    }
    const converted = toPresetConfig(config);
    const defaultProfiles = converted.presets.default;
    if (!defaultProfiles) return;
    converted.presets[name] = cloneProfiles(defaultProfiles);
    const note =
      config.profiles.length > 0
        ? `\nLegacy profiles moved to preset "default" (active).`
        : `\nActive preset: default.`;
    saveConfig(
      ctx,
      target,
      converted,
      `Copied preset "default" to "${name}" (inactive) in ${target}${note}`,
      host,
    );
    return;
  }
  if (Object.hasOwn(config.presets, name)) {
    notify(ctx, `Preset "${name}" already exists (target: ${target}).`, "warning");
    return;
  }
  const sourceProfiles = getPresetProfiles(config, source);
  if (!sourceProfiles) {
    notify(
      ctx,
      `Preset "${source}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  config.presets[name] = cloneProfiles(sourceProfiles);
  saveConfig(ctx, target, config, `Copied preset "${source}" to "${name}" (inactive) in ${target}`, host);
}

async function cmdPresetUse(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  requestedName?: string,
): Promise<void> {
  let name = requestedName;
  if (name === undefined) {
    const layer = readLayer(target);
    if (layer.error) {
      notify(ctx, `pi-model-sync: ${layer.error}`, "error");
      return;
    }
    const names = presetNames(layer.config);
    if (names.length === 0) {
      notify(ctx, `No presets yet (/model-sync preset create <name>).`, "warning");
      return;
    }
    if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.select !== "function") {
      notify(ctx, "Usage: /model-sync preset use <name>", "warning");
      return;
    }
    const selected = await ctx.ui.select("Select a preset", names);
    if (selected === undefined || selected.trim() === "") return;
    name = selected.trim();
  }
  if (!isValidPresetName(name)) {
    notify(ctx, `Invalid preset name "${name}". Preset names must be single tokens.`, "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Preset "default" is already active (legacy config; target: ${target}).`);
      return;
    }
    notify(ctx, `Preset "${name}" not found. Available presets: default (target: ${target}).`, "warning");
    return;
  }
  if (getPresetProfiles(config, name) === undefined) {
    notify(
      ctx,
      `Preset "${name}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  if (config.activePreset === name) {
    notify(ctx, `Preset "${name}" is already active (target: ${target}).`);
    return;
  }
  config.activePreset = name;
  saveConfig(ctx, target, config, `Active preset: ${name} (${target})`, host);
}

function cmdPresetRemove(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  name: string,
): void {
  if (!isValidPresetName(name)) {
    notify(ctx, `Invalid preset name "${name}". Preset names must be single tokens.`, "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (name === "default") {
      notify(ctx, `Cannot remove the active virtual legacy preset "default" (target: ${target}).`, "warning");
      return;
    }
    notify(ctx, `Preset "${name}" not found. Available presets: default (target: ${target}).`, "warning");
    return;
  }
  if (getPresetProfiles(config, name) === undefined) {
    notify(
      ctx,
      `Preset "${name}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  if (config.activePreset === name) {
    notify(
      ctx,
      `Cannot remove the active preset "${name}" (target: ${target}).\nSwitch to another preset first: /model-sync preset use <name>.`,
      "warning",
    );
    return;
  }
  delete config.presets[name];
  saveConfig(ctx, target, config, `Removed preset "${name}" (${target})`, host);
}

function cmdPresetRename(
  ctx: ExtensionContextLike,
  target: string,
  host: CommandHost,
  oldName: string,
  newName: string,
): void {
  if (!isValidPresetName(oldName) || !isValidPresetName(newName)) {
    notify(ctx, "Invalid preset name. Preset names must be single tokens.", "warning");
    return;
  }
  const config = loadForWrite(ctx, target);
  if (!config) return;
  if (!isNamedConfig(config)) {
    if (oldName !== "default") {
      notify(ctx, `Preset "${oldName}" not found. Available presets: default (target: ${target}).`, "warning");
      return;
    }
    if (oldName === newName) {
      notify(ctx, `Preset "${oldName}" is already named that (target: ${target}).`);
      return;
    }
    const converted = toPresetConfig(config);
    const defaultProfiles = converted.presets.default;
    if (!defaultProfiles) return;
    const renamed: PresetMap = Object.create(null) as PresetMap;
    renamed[newName] = defaultProfiles;
    saveConfig(
      ctx,
      target,
      { activePreset: newName, presets: renamed },
      `Renamed preset "default" to "${newName}" (active) in ${target}.`,
      host,
    );
    return;
  }
  const profiles = getPresetProfiles(config, oldName);
  if (profiles === undefined) {
    notify(
      ctx,
      `Preset "${oldName}" not found (target: ${target}).\n${availablePresetsHint(config)}`,
      "warning",
    );
    return;
  }
  if (oldName === newName) {
    notify(ctx, `Preset "${oldName}" is already named that (target: ${target}).`);
    return;
  }
  if (getPresetProfiles(config, newName) !== undefined) {
    notify(ctx, `Preset "${newName}" already exists (target: ${target}).`, "warning");
    return;
  }
  const presets: PresetMap = Object.create(null) as PresetMap;
  for (const [name, list] of Object.entries(config.presets)) {
    presets[name === oldName ? newName : name] = list;
  }
  config.presets = presets;
  if (config.activePreset === oldName) config.activePreset = newName;
  const activeNote = config.activePreset === newName ? " (active)" : "";
  saveConfig(ctx, target, config, `Renamed preset "${oldName}" to "${newName}"${activeNote} (${target}).`, host);
}

// ── display commands ────────────────────────────────────────────

interface LayerView {
  layer: { path: string; layer: "project" | "global" };
  config: ModelSyncConfig;
  effective: EffectiveConfig;
  error: string | null;
  exists: boolean;
  warnings: string[];
}

function loadActiveLayerView(cwd: string, selection?: SessionSelection): LayerView {
  const layer = resolveActiveLayer(cwd);
  const read = readLayer(layer.path);
  return {
    layer,
    config: read.config,
    effective: projectActiveProfiles(read.config, selection),
    error: read.error,
    exists: read.exists,
    warnings: read.warnings,
  };
}

/** Shared header for list, preset list, and show. Returns false when there is no usable config. */
function appendLayerSummary(lines: string[], view: LayerView, header: string): boolean {
  lines.push(header);
  if (!view.exists) {
    lines.push("No config file yet.");
    return false;
  }
  if (view.error) {
    lines.push(view.error);
    return false;
  }
  lines.push(`Active preset: ${formatActivePreset(view.config, view.effective)}`);
  if (view.effective.warning) lines.push(view.effective.warning);
  for (const warning of view.warnings) lines.push(`Config warning: ${warning}`);
  return true;
}

function appendInactiveLayer(lines: string[], view: LayerView): void {
  if (!view.exists) return;
  lines.push(`(inactive) ${view.layer.layer} layer: ${view.layer.path}`);
  if (view.error) {
    lines.push(`  ${view.error}`);
    return;
  }
  lines.push(`  Active preset: ${formatActivePreset(view.config, view.effective)}`);
  if (view.effective.warning) lines.push(`  ${view.effective.warning}`);
  for (const warning of view.warnings) lines.push(`  Config warning: ${warning}`);
  if (view.effective.profiles.length === 0) {
    lines.push("  No profiles in the inactive layer");
  } else {
    for (const profile of view.effective.profiles) {
      lines.push(`      ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
    }
  }
}

function cmdList(ctx: ExtensionContextLike, host: CommandHost): void {
  const view = loadActiveLayerView(ctx.cwd, sessionSelection(host.state));
  const lines: string[] = [];
  const ok = appendLayerSummary(
    lines,
    view,
    `pi-model-sync active layer: ${view.layer.layer} (${view.layer.path})`,
  );
  if (host.state.paused) lines.push("Session routing: paused");
  else if (host.state.presetOverride !== undefined) {
    lines.push(`Session preset: ${host.state.presetOverride} (not saved)`);
  }
  if (!ok) {
    if (!view.exists) {
      lines.push("No profiles yet. Create the config with /model-sync add <main> <model>.");
    } else if (view.error) {
      lines.push("No profiles are active because the active config has an error.");
    }
  } else {
    const modelRef = currentModelRef(ctx);
    const hit = findProfile(view.effective, modelRef);
    if (view.effective.profiles.length === 0) {
      lines.push("No profiles in the active preset (/model-sync add <main> <model>)");
    } else {
      for (const profile of view.effective.profiles) {
        lines.push(`  ${hit === profile ? "*" : " "} ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
      }
    }
  }
  const otherLayer = view.layer.layer === "project" ? "global" : "project";
  const otherPath = otherLayer === "project" ? getProjectConfigPath(ctx.cwd) : getGlobalConfigPath(ctx.cwd);
  if (otherPath !== view.layer.path) {
    const otherRead = readLayer(otherPath);
    appendInactiveLayer(lines, {
      layer: { path: otherPath, layer: otherLayer },
      config: otherRead.config,
      effective: projectActiveProfiles(otherRead.config),
      error: otherRead.error,
      exists: otherRead.exists,
      warnings: otherRead.warnings,
    });
  }
  notify(ctx, lines.join("\n"));
}

/** Status for one selector: host resolution plus the installed plugin dialects that accept it. */
function describeSelector(
  ctx: ExtensionContextLike,
  selector: string,
  adapters: SubagentAdapter[] | undefined,
  snapshot: RegistrySnapshot,
  modelRef: CurrentModelRef | undefined,
): string {
  const host = selectorResolvable(ctx, selector, snapshot);
  const hostText =
    host === true ? "resolvable" : host === false ? "unresolvable" : "host cannot pre-validate";
  if (adapters === undefined) return ` (${hostText})`;
  if (adapters.length === 0) return ` (${hostText}; no supported subagent plugin is registered)`;
  const accepted = adapters
    .filter((adapter) => adapterAcceptsSelector(ctx, selector, adapter, snapshot, modelRef))
    .map((adapter) => adapter.id);
  if (accepted.length === 0) {
    return ` (${hostText}; no installed plugin accepts this selector)`;
  }
  return ` (${hostText}; plugins: ${accepted.join(", ")})`;
}

function cmdShow(
  ctx: ExtensionContextLike,
  host: CommandHost,
  modelArg?: string,
  agentArg?: string,
): void {
  let requestedRefs: CurrentModelRef[] | undefined;
  let requestedDisplay: string | undefined;
  if (modelArg !== undefined) {
    const parsed = parseSelector(modelArg);
    if (!parsed || parsed.kind !== "reference") {
      notify(ctx, "Usage: /model-sync show [model] [agent]", "warning");
      return;
    }
    requestedRefs = selectorRefs(parsed);
    requestedDisplay = parsed.raw;
  }
  const modelRef = requestedRefs?.[0] ?? currentModelRef(ctx);
  const current = requestedDisplay ?? formatModelRef(modelRef);
  const view = loadActiveLayerView(ctx.cwd, sessionSelection(host.state));
  const lines: string[] = [];
  lines.push(`${requestedRefs ? "Requested" : "Current session"} model: ${current}`);
  if (host.state.paused) lines.push("Session routing: paused");
  else if (host.state.presetOverride !== undefined) {
    lines.push(`Session preset: ${host.state.presetOverride} (not saved)`);
  }
  const ok = appendLayerSummary(lines, view, `Active layer: ${view.layer.layer} (${view.layer.path})`);
  if (!ok) {
    if (!view.exists) lines.push("Nothing to match yet. Create the config with /model-sync add <main> <model>.");
    notify(ctx, lines.join("\n"));
    return;
  }
  const profile = requestedRefs
    ? requestedRefs.map((ref) => findProfile(view.effective, ref)).find((hit) => hit !== undefined)
    : findProfile(view.effective, modelRef);
  if (!profile) {
    lines.push(`No matching profile for ${current}`);
    notify(ctx, lines.join("\n"));
    return;
  }
  lines.push(`Matched profile: main=${profile.main}`);
  if (profile.agentMatch === "case-insensitive") lines.push("Agent matching: case-insensitive");
  const snapshot = createRegistrySnapshot();
  const adapters = installedAdapters(readToolInfos(host.pi));
  if (agentArg !== undefined) {
    const selector = pickSubagentSelector(profile, agentArg);
    if (!selector) {
      lines.push(`No selector for agent "${agentArg}" under this profile.`);
    } else {
      lines.push(`  ${agentArg} → ${selector}${describeSelector(ctx, selector, adapters, snapshot, modelRef)}`);
    }
  } else if (typeof profile.subagents === "string") {
    lines.push(`  * → ${profile.subagents}${describeSelector(ctx, profile.subagents, adapters, snapshot, modelRef)}`);
  } else {
    const statusCache = new Map<string, string>();
    for (const [agentName, selector] of Object.entries(profile.subagents)) {
      let status = statusCache.get(selector);
      if (status === undefined) {
        status = describeSelector(ctx, selector, adapters, snapshot, modelRef);
        statusCache.set(selector, status);
      }
      lines.push(`  ${agentName} → ${selector}${status}`);
    }
  }
  notify(ctx, lines.join("\n"));
}

// ── session commands ────────────────────────────────────────────

function diskActivePreset(ctx: ExtensionContextLike): string | undefined {
  return loadActiveLayerView(ctx.cwd).effective.activePreset;
}

function cmdStatus(ctx: ExtensionContextLike, host: CommandHost, action?: string): void {
  if (action !== undefined && action !== "off") {
    notify(ctx, "Usage: /model-sync status [off]", "warning");
    return;
  }
  if (action === "off") {
    applyStatus(ctx, host.state, undefined);
    notify(ctx, "Status bar cleared.");
    return;
  }
  const view = loadActiveLayerView(ctx.cwd, sessionSelection(host.state));
  const disk = loadActiveLayerView(ctx.cwd);
  const modelRef = currentModelRef(ctx);
  const hit = findProfile(view.effective, modelRef);
  const lines = [
    "pi-model-sync session status",
    `  Routing: ${host.state.paused ? "paused" : "active"}`,
    `  Session preset: ${host.state.presetOverride ?? "(none)"}`,
    `  Active layer: ${view.layer.layer} (${view.layer.path})`,
    `  On-disk active preset: ${formatActivePreset(disk.config, disk.effective)}`,
    `  Current model: ${formatModelRef(modelRef)}`,
    `  Matched profile: ${hit ? hit.main : "(none)"}`,
    `  Cached models: ${host.state.availableModels.length}`,
    `  Route log: ${host.state.routeLog.length} entries`,
  ];
  if (view.effective.warning) lines.push(`  ${view.effective.warning}`);
  applyStatus(ctx, host.state, statusText(host.state, disk.effective.activePreset));
  if (!ctx.ui || typeof ctx.ui.setStatus !== "function") {
    lines.push("  This host has no status bar; the report is shown here.");
  }
  notify(ctx, lines.join("\n"));
}

function cmdUseSession(
  ctx: ExtensionContextLike,
  host: CommandHost,
  name: string,
): void {
  if (name === "off") {
    delete host.state.presetOverride;
    if (host.state.statusVisible) {
      applyStatus(ctx, host.state, statusText(host.state, diskActivePreset(ctx)));
    }
    notify(ctx, "Session preset override cleared.");
    return;
  }
  if (!isValidPresetName(name)) {
    notify(ctx, `Invalid preset name "${name}". Preset names must be single tokens.`, "warning");
    return;
  }
  const target = resolveActiveLayer(ctx.cwd).path;
  const layer = readLayer(target);
  if (layer.error) {
    notify(ctx, `pi-model-sync: ${layer.error}`, "error");
    return;
  }
  const profiles = getPresetProfiles(layer.config, name);
  if (profiles === undefined) {
    notify(
      ctx,
      `Preset "${name}" not found (target: ${target}).\n${availablePresetsHint(layer.config)}`,
      "warning",
    );
    return;
  }
  host.state.presetOverride = name;
  host.state.paused = false;
  if (host.state.statusVisible) {
    applyStatus(ctx, host.state, statusText(host.state, projectActiveProfiles(layer.config).activePreset));
  }
  notify(
    ctx,
    `Session preset: ${name} (not saved; ${profiles.length} profile${profiles.length === 1 ? "" : "s"}; target: ${target}).`,
  );
}

function cmdPause(ctx: ExtensionContextLike, host: CommandHost): void {
  host.state.paused = true;
  if (host.state.statusVisible) {
    applyStatus(ctx, host.state, statusText(host.state, diskActivePreset(ctx)));
  }
  notify(ctx, "Routing paused for this session. Run /model-sync resume to re-enable it.");
}

function cmdResume(ctx: ExtensionContextLike, host: CommandHost): void {
  host.state.paused = false;
  if (host.state.statusVisible) {
    applyStatus(ctx, host.state, statusText(host.state, diskActivePreset(ctx)));
  }
  notify(
    ctx,
    host.state.presetOverride === undefined
      ? "Routing resumed for this session."
      : `Routing resumed with session preset "${host.state.presetOverride}".`,
  );
}

function cmdLog(ctx: ExtensionContextLike, host: CommandHost, action?: string): void {
  if (action === "clear") {
    host.state.routeLog.length = 0;
    notify(ctx, "Session route log cleared.");
    return;
  }
  if (action !== undefined) {
    notify(ctx, "Usage: /model-sync log [clear]", "warning");
    return;
  }
  if (host.state.routeLog.length === 0) {
    notify(ctx, "No routing decisions recorded in this session.");
    return;
  }
  const lines = [
    `pi-model-sync route log (last ${host.state.routeLog.length} of ${ROUTE_LOG_LIMIT}):`,
  ];
  for (const entry of host.state.routeLog) {
    const time = new Date(entry.at).toISOString().slice(11, 19);
    const main = entry.main === undefined ? "" : ` main=${entry.main}`;
    const selector = entry.selector === undefined ? "" : ` selector=${entry.selector}`;
    const adapter = entry.adapter === undefined ? "" : ` adapter=${entry.adapter}`;
    lines.push(`  ${time} ${entry.path} ${entry.agent}${main}${selector}${adapter} → ${entry.outcome}`);
  }
  notify(ctx, lines.join("\n"));
}

// ── doctor and init ─────────────────────────────────────────────
function shadowProbe(main: string): CurrentModelRef | undefined {
  if (!main.includes("*")) return undefined;
  const parsed = parseSelector(main.replace(/\*+/g, "probe"));
  if (!parsed || parsed.kind !== "reference") return undefined;
  return selectorRefs(parsed)[0];
}


function checkProfiles(
  ctx: ExtensionContextLike,
  preset: string,
  profiles: Profile[],
  installed: SubagentAdapter[] | undefined,
  snapshot: RegistrySnapshot,
  issues: Set<string>,
): void {
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index];
    if (!profile) continue;
    const parsed = parseSelector(profile.main);
    const isGlob = parsed?.kind === "glob";
    const refs =
      parsed?.kind === "reference"
        ? selectorRefs(parsed)
        : isGlob
          ? [shadowProbe(profile.main)].filter(
              (ref): ref is CurrentModelRef => ref !== undefined,
            )
          : [];
    for (const ref of refs) {
      const earlier = findProfile({ profiles: profiles.slice(0, index) }, ref);
      if (earlier) {
        issues.add(
          `Preset "${preset}" profile "${profile.main}" ${isGlob ? "may be shadowed by" : "is shadowed by"} earlier profile "${earlier.main}".`,
        );
        break;
      }
    }
    const selectors =
      typeof profile.subagents === "string" ? [profile.subagents] : Object.values(profile.subagents);
    for (const selector of selectors) {
      if (selectorResolvable(ctx, selector, snapshot) === false) {
        issues.add(`Preset "${preset}" selector "${selector}" cannot be resolved by this host.`);
      }
      if (installed !== undefined && installed.length > 0) {
        const accepted = installed.some((adapter) =>
          adapterAcceptsSelector(ctx, selector, adapter, snapshot),
        );
        if (!accepted) {
          issues.add(
            `Preset "${preset}" selector "${selector}" is not accepted by any installed plugin for tool calls (${installed
              .map((adapter) => adapter.id)
              .join(", ")}).`,
          );
        }
      }
    }
    if (typeof profile.subagents !== "string") {
      const byLower = new Map<string, string[]>();
      for (const key of Object.keys(profile.subagents)) {
        const lower = key.toLowerCase();
        const keys = byLower.get(lower);
        if (keys) keys.push(key);
        else byLower.set(lower, [key]);
      }
      for (const keys of byLower.values()) {
        if (keys.length > 1) {
          issues.add(
            `Preset "${preset}" profile "${profile.main}" has agent keys ${keys.join(", ")} that differ only by case.`,
          );
        }
      }
    }
  }
}

function cmdDoctor(ctx: ExtensionContextLike, host: CommandHost): void {
  const active = resolveActiveLayer(ctx.cwd);
  const layers: Array<{ label: string; path: string }> = [
    { label: active.layer, path: active.path },
  ];
  const otherPath = active.layer === "project" ? getGlobalConfigPath(ctx.cwd) : getProjectConfigPath(ctx.cwd);
  if (otherPath !== active.path) {
    layers.push({ label: active.layer === "project" ? "global" : "project", path: otherPath });
  }
  const installed = installedAdapters(readToolInfos(host.pi));
  const snapshot = createRegistrySnapshot();
  const issues = new Set<string>();
  const lines = ["pi-model-sync doctor"];
  for (const layer of layers) {
    const read = readLayer(layer.path);
    if (!read.exists) {
      lines.push(`${layer.label} (${layer.path}): no file`);
      continue;
    }
    const layerIssues = new Set<string>();
    if (read.error) {
      lines.push(`${layer.label} (${layer.path}): error`);
      layerIssues.add(read.error);
    } else {
      const names = presetNames(read.config);
      const profileCount = names.reduce(
        (total, name) => total + (getPresetProfiles(read.config, name)?.length ?? 0),
        0,
      );
      lines.push(
        `${layer.label} (${layer.path}): ${names.length} preset${names.length === 1 ? "" : "s"}, ${profileCount} profile${profileCount === 1 ? "" : "s"}`,
      );
      for (const warning of read.warnings) layerIssues.add(warning);
      for (const name of names) {
        checkProfiles(ctx, name, getPresetProfiles(read.config, name) ?? [], installed, snapshot, layerIssues);
      }
    }
    for (const issue of layerIssues) issues.add(`[${layer.label}] ${issue}`);
  }
  if (host.state.presetOverride !== undefined) {
    const activeRead = readLayer(active.path);
    if (activeRead.exists && getPresetProfiles(activeRead.config, host.state.presetOverride) === undefined) {
      issues.add(`[${active.layer}] Session preset "${host.state.presetOverride}" does not exist in the active layer.`);
    }
  }
  if (issues.size === 0) {
    lines.push("No issues found.");
    notify(ctx, lines.join("\n"));
    return;
  }
  lines.push(`Found ${issues.size} issue${issues.size === 1 ? "" : "s"}:`);
  for (const issue of issues) lines.push(`  - ${issue}`);
  notify(ctx, lines.join("\n"), "warning");
}

function cmdInit(ctx: ExtensionContextLike, target: string, host: CommandHost): void {
  const layer = readLayer(target);
  if (layer.error) {
    notify(
      ctx,
      `Config already exists at ${target} but cannot be parsed: ${layer.error}\nRepair or delete it before running /model-sync init.`,
      "error",
    );
    return;
  }
  if (layer.exists) {
    notify(
      ctx,
      `Config already exists at ${target}. Edit it with /model-sync add <main> <model> or the preset commands.`,
    );
    return;
  }
  const modelRef = currentModelRef(ctx);
  if (!modelRef) {
    notify(
      ctx,
      "Cannot determine the current model. Use /model-sync add <main> <model> instead.",
      "warning",
    );
    return;
  }
  const main = formatModelRef(modelRef);
  const presets: PresetMap = Object.create(null) as PresetMap;
  presets.default = [{ main, subagents: main }];
  saveConfig(
    ctx,
    target,
    { activePreset: "default", presets },
    `Created starter config at ${target}\n  ${main} → ${main}\nEdit it with /model-sync set <main> <agent> <model>.`,
    host,
  );
}
