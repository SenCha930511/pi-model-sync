/**
 * `/model-sync` argument completion. The host callback has no context object, so the
 * session caches its cwd and authenticated model ids; completion falls back to
 * process.cwd() only when no session has been observed yet.
 */

import {
  findProfile,
  getGlobalConfigPath,
  getProjectConfigPath,
  isNamedConfig,
  presetNames,
  projectActiveProfiles,
  readLayer,
  resolveActiveLayer,
  summarizeSubagents,
} from "./config";
import { parseSelector, selectorRefs } from "./resolver";
import { sessionSelection } from "./session";
import type { SessionState } from "./session";

export interface ArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

const TOP_LEVEL_COMPLETIONS: ArgumentCompletion[] = [
  { value: "list", label: "list", description: "Show the active layer, active preset, and profiles" },
  { value: "show ", label: "show", description: "Show the current or requested model, matched profile, and selector status" },
  { value: "add ", label: "add", description: "Add/update a profile in the active preset" },
  { value: "set ", label: "set", description: "Set a model for one agent in the active preset" },
  { value: "remove ", label: "remove", description: "Remove a profile or agent entry from the active preset" },
  { value: "move ", label: "move", description: "Reorder a profile in the active preset" },
  { value: "preset ", label: "preset", description: "List, create, copy, rename, use, or remove presets" },
  { value: "status ", label: "status", description: "Show session routing state or clear the status bar" },
  { value: "use-session ", label: "use-session", description: "Route this session with a preset without saving" },
  { value: "pause", label: "pause", description: "Pause routing for this session" },
  { value: "resume", label: "resume", description: "Resume routing for this session" },
  { value: "log ", label: "log", description: "Show or clear recent routing decisions" },
  { value: "doctor", label: "doctor", description: "Check both config layers for problems" },
  { value: "init", label: "init", description: "Create a starter config from the current model" },
  { value: "help", label: "help", description: "Show the top-level usage" },
];

const PRESET_COMPLETIONS: ArgumentCompletion[] = [
  { value: "preset list", label: "list", description: "List presets in the active layer" },
  { value: "preset create ", label: "create", description: "Create an empty inactive preset" },
  { value: "preset copy ", label: "copy", description: "Deep-copy a preset without switching" },
  { value: "preset rename ", label: "rename", description: "Rename a preset without changing its profiles" },
  { value: "preset use ", label: "use", description: "Select the active preset" },
  { value: "preset remove ", label: "remove", description: "Remove an inactive preset" },
  { value: "preset help", label: "help", description: "Show the preset usage" },
];

const POSITION_DESCRIPTIONS: Record<string, string> = {
  top: "Move to the top",
  bottom: "Move to the bottom",
  up: "Move up one position",
  down: "Move down one position",
};

interface CompletionContext {
  current: string;
  beforeCurrent: string;
  commandTokens: string[];
  projectFlagInTokens: boolean;
  useProject: boolean;
}

interface CompletionToken {
  value: string;
  start: number;
  quoted: boolean;
}

function tokenizeCompletion(input: string): CompletionToken[] | null {
  const tokens: CompletionToken[] = [];
  let current = "";
  let start = -1;
  let quote: "'" | '"' | null = null;
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
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
      if (start < 0) start = index;
      quote = char;
      quoted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (start >= 0) {
        tokens.push({ value: current, start, quoted });
        current = "";
        start = -1;
        quoted = false;
      }
      continue;
    }
    if (start < 0) start = index;
    current += char;
  }
  if (quote !== null) return null;
  if (start >= 0) tokens.push({ value: current, start, quoted });
  return tokens;
}

function parseCompletionContext(argumentPrefix: string): CompletionContext | null {
  const tokens = tokenizeCompletion(argumentPrefix);
  if (!tokens) return null;
  const hasTrailingSpace = /\s$/.test(argumentPrefix);
  const last = tokens[tokens.length - 1];
  const current = hasTrailingSpace ? "" : last?.value ?? "";
  if (!hasTrailingSpace && last) tokens.pop();
  const projectFlagInTokens = tokens.some((token) => !token.quoted && token.value === "--project");
  const useProject = projectFlagInTokens || current === "--project";
  const commandTokens = tokens
    .filter((token) => token.quoted || token.value !== "--project")
    .map((token) => token.value);
  const beforeCurrent = hasTrailingSpace ? argumentPrefix : last ? argumentPrefix.slice(0, last.start) : argumentPrefix;
  return { current, beforeCurrent, commandTokens, projectFlagInTokens, useProject };
}

/** Append a typed --project flag, keeping any trailing space for the next argument. */
function withProject(value: string, context: CompletionContext): string {
  if (!context.useProject) return value;
  const trailing = value.endsWith(" ") ? " " : "";
  return `${value.trimEnd()} --project${trailing}`;
}

function completionTarget(useProject: boolean, state: SessionState): string {
  const cwd = state.cwd ?? process.cwd();
  return useProject ? getProjectConfigPath(cwd) : getGlobalConfigPath(cwd);
}

function presetCompletionItems(
  target: string,
  action: string,
  current: string,
  context: CompletionContext,
): ArgumentCompletion[] | null {
  const layer = readLayer(target);
  if (!layer.exists || layer.error) return null;
  const active = isNamedConfig(layer.config) ? layer.config.activePreset : "default";
  const items: ArgumentCompletion[] = [];
  for (const name of presetNames(layer.config)) {
    if (!name.startsWith(current)) continue;
    let description = "preset";
    if (name === active) {
      description =
        action === "use"
          ? "already active"
          : action === "remove"
            ? "active; switch away before removing"
            : "active preset";
    }
    const needsArgument = action === "copy" || action === "rename";
    items.push({
      value: withProject(`preset ${action} ${name}${needsArgument ? " " : ""}`, context),
      label: name,
      description,
    });
  }
  return items.length > 0 ? items : null;
}

function sessionPresetCompletionItems(
  state: SessionState,
  current: string,
  context: CompletionContext,
): ArgumentCompletion[] | null {
  const target = resolveActiveLayer(state.cwd ?? process.cwd()).path;
  const layer = readLayer(target);
  if (!layer.exists || layer.error) return null;
  const active = isNamedConfig(layer.config) ? layer.config.activePreset : "default";
  const items: ArgumentCompletion[] = [];
  if ("off".startsWith(current)) {
    items.push({
      value: withProject("use-session off", context),
      label: "off",
      description: "Clear the session override",
    });
  }
  for (const name of presetNames(layer.config)) {
    if (!name.startsWith(current)) continue;
    items.push({
      value: withProject(`use-session ${name}`, context),
      label: name,
      description: name === active ? "on-disk active preset" : "preset",
    });
  }
  return items.length > 0 ? items : null;
}

function modelCompletionItems(
  prefix: string,
  baseTokens: string[],
  context: CompletionContext,
  state: SessionState,
  trailing = false,
): ArgumentCompletion[] | null {
  if (state.availableModels.length === 0) return null;
  const base = baseTokens.join(" ");
  const needle = prefix.toLowerCase();
  const items = state.availableModels
    .filter((id) => id.toLowerCase().startsWith(needle))
    .slice(0, 30)
    .map((id) => ({
      value: withProject(`${base} ${id}${trailing ? " " : ""}`, context),
      label: id,
      description: "available model",
    }));
  return items.length > 0 ? items : null;
}

function mergeCompletions(
  ...lists: Array<ArgumentCompletion[] | null>
): ArgumentCompletion[] | null {
  const items: ArgumentCompletion[] = [];
  const labels = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      if (labels.has(item.label)) continue;
      labels.add(item.label);
      items.push(item);
    }
  }
  return items.length > 0 ? items : null;
}

function profileCompletionItems(
  sub: string,
  rest: string[],
  current: string,
  context: CompletionContext,
  state: SessionState,
): ArgumentCompletion[] | null {
  const layer = readLayer(completionTarget(context.useProject, state));
  if (!layer.exists || layer.error) return null;
  const effective = projectActiveProfiles(layer.config);
  if (effective.warning || !effective.activePreset) return null;
  if (rest.length === 0) {
    const prefix = current.toLowerCase();
    const items = effective.profiles
      .filter((profile) => profile.main.toLowerCase().startsWith(prefix))
      .map((profile) => ({
        value: withProject(`${sub} ${profile.main} `, context),
        label: profile.main,
        description: summarizeSubagents(profile.subagents),
      }));
    return items.length > 0 ? items : null;
  }
  if (sub === "move" && rest.length === 1) {
    const items = Object.entries(POSITION_DESCRIPTIONS)
      .filter(([position]) => position.startsWith(current))
      .map(([position, description]) => ({
        value: withProject(`move ${rest[0]} ${position}`, context),
        label: position,
        description,
      }));
    return items.length > 0 ? items : null;
  }
  if ((sub === "set" || sub === "remove") && rest.length === 1) {
    const main = rest[0];
    if (!main) return null;
    const profile = effective.profiles.find((item) => item.main.toLowerCase() === main.toLowerCase());
    if (!profile) return null;
    const entries =
      typeof profile.subagents === "string"
        ? sub === "set"
          ? [["*", profile.subagents] as const]
          : []
        : Object.entries(profile.subagents);
    const items = entries
      .filter(([agent]) => agent.startsWith(current))
      .map(([agent, selector]) => ({
        value: withProject(`${sub} ${profile.main} ${agent}${sub === "set" ? " " : ""}`, context),
        label: agent,
        description: agent === "*" ? `profile default → ${selector}` : `→ ${selector}`,
      }));
    return items.length > 0 ? items : null;
  }
  return null;
}

function showAgentCompletionItems(
  rest: string[],
  current: string,
  context: CompletionContext,
  state: SessionState,
): ArgumentCompletion[] | null {
  const modelArg = rest[0];
  if (!modelArg) return null;
  const parsed = parseSelector(modelArg);
  if (!parsed || parsed.kind !== "reference") return null;
  const layer = readLayer(resolveActiveLayer(state.cwd ?? process.cwd()).path);
  if (!layer.exists || layer.error) return null;
  const effective = projectActiveProfiles(layer.config, sessionSelection(state));
  if (effective.warning || !effective.activePreset) return null;
  const profile = selectorRefs(parsed)
    .map((ref) => findProfile(effective, ref))
    .find((hit) => hit !== undefined);
  if (!profile) return null;
  const subagents = profile.subagents;
  const agents = typeof subagents === "string" ? ["*"] : Object.keys(subagents);
  const prefix = current.toLowerCase();
  const items = agents
    .filter((agent) => agent.toLowerCase().startsWith(prefix))
    .map((agent) => ({
      value: withProject(`show ${modelArg} ${agent}`, context),
      label: agent,
      description:
        typeof subagents === "string"
          ? `profile default → ${subagents}`
          : agent === "*"
            ? `profile default → ${subagents["*"] ?? ""}`
            : `→ ${subagents[agent] ?? ""}`,
    }));
  return items.length > 0 ? items : null;
}

/** Never throws; returns null when the prefix is unknown or malformed. */
export function modelSyncArgumentCompletions(
  argumentPrefix: string,
  state: SessionState,
): ArgumentCompletion[] | null {
  try {
    const context = parseCompletionContext(argumentPrefix);
    if (!context) return null;
    const { current, beforeCurrent, commandTokens, projectFlagInTokens } = context;
    if (current.startsWith("-")) {
      if (projectFlagInTokens || !"--project".startsWith(current)) return null;
      return [{ value: `${beforeCurrent}--project`, label: "--project", description: "Target the project config" }];
    }
    const [sub, ...rest] = commandTokens;
    if (!sub) {
      const filtered = TOP_LEVEL_COMPLETIONS.filter((item) => item.label.startsWith(current));
      return filtered.length > 0
        ? filtered.map((item) => ({ ...item, value: withProject(item.value, context) }))
        : null;
    }
    if (sub === "preset") {
      const [action, ...actionArgs] = rest;
      if (!action) {
        const filtered = PRESET_COMPLETIONS.filter((item) => item.label.startsWith(current));
        return filtered.length > 0
          ? filtered.map((item) => ({ ...item, value: withProject(item.value, context) }))
          : null;
      }
      if (action !== "use" && action !== "remove" && action !== "copy" && action !== "rename") return null;
      if (actionArgs.length > 0) return null;
      return presetCompletionItems(completionTarget(context.useProject, state), action, current, context);
    }
    if (sub === "use-session") {
      if (rest.length > 0) return null;
      return sessionPresetCompletionItems(state, current, context);
    }
    if (sub === "log") {
      if (rest.length > 0) return null;
      return "clear".startsWith(current)
        ? [{ value: withProject("log clear", context), label: "clear", description: "Clear the session route log" }]
        : null;
    }
    if (sub === "status") {
      if (rest.length > 0) return null;
      return "off".startsWith(current)
        ? [{ value: withProject("status off", context), label: "off", description: "Clear the status bar" }]
        : null;
    }
    if (sub === "show") {
      if (rest.length === 0) return modelCompletionItems(current, commandTokens, context, state);
      if (rest.length === 1) return showAgentCompletionItems(rest, current, context, state);
      return null;
    }
    if (sub === "add") {
      if (rest.length > 1) return null;
      if (rest.length === 0) {
        return mergeCompletions(
          profileCompletionItems(sub, rest, current, context, state),
          modelCompletionItems(current, commandTokens, context, state, true),
        );
      }
      return modelCompletionItems(current, commandTokens, context, state);
    }
    if (sub === "set") {
      if (rest.length > 2) return null;
      if (rest.length < 2) return profileCompletionItems(sub, rest, current, context, state);
      return modelCompletionItems(current, commandTokens, context, state);
    }
    if (sub === "remove" || sub === "move") {
      return profileCompletionItems(sub, rest, current, context, state);
    }
    return null;
  } catch {
    return null;
  }
}
