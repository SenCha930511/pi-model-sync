import { statSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export type SubagentMap = Record<string, string>;

export interface Profile {
  main: string;
  subagents: string | SubagentMap;
}

export type PresetMap = Record<string, Profile[]>;

export type ModelSyncConfig =
  | { profiles: Profile[] }
  | { activePreset?: string; presets: PresetMap };

export interface EffectiveConfig {
  activePreset?: string;
  profiles: Profile[];
  warning?: string;
}

export interface CurrentModelRef {
  provider: string;
  id: string;
}

/**
 * Global config path:
 * PI_MODEL_SYNC_CONFIG (absolute, or relative to the session cwd) → PI_CODING_AGENT_DIR/pi-model-sync.json
 * → ~/.omp/agent/pi-model-sync.json.
 * Decision 12 (dual-host landing): on the final fallback, when the ~/.omp file does not exist
 * and the ~/.pi file does, return ~/.pi/agent/pi-model-sync.json (the upstream pi host's
 * default agent dir); when neither exists, the omp path remains the write target.
 * Known limit: named-profile (omp --profile <name>) agent dirs aren't covered by these two
 * env vars, so the default path applies there; override with PI_MODEL_SYNC_CONFIG.
 */
export function getGlobalConfigPath(cwd?: string): string {
  // Relative overrides resolve against the session cwd when the caller provides one;
  // the host process cwd is only a fallback (a session may run in another directory).
  const override = process.env.PI_MODEL_SYNC_CONFIG?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(cwd ?? process.cwd(), override);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    return resolve(cwd ?? process.cwd(), agentDir, "pi-model-sync.json");
  }
  const { ompGlobal: ompPath, piGlobal: piPath } = defaultGlobalPaths();
  if (!statFile(ompPath) && statFile(piPath)) {
    return piPath;
  }
  return ompPath;
}

/**
 * Project config path: current cwd only, no upward search (matches the OMP project convention).
 * Decision 12 (dual-host landing): when the .omp file does not exist and the .pi file does,
 * use <cwd>/.pi/pi-model-sync.json.
 */
export function getProjectConfigPath(cwd: string): string {
  const ompPath = resolve(cwd, ".omp", "pi-model-sync.json");
  const piPath = resolve(cwd, ".pi", "pi-model-sync.json");
  if (!statFile(ompPath) && statFile(piPath)) {
    return piPath;
  }
  return ompPath;
}

/**
 * Active layer (decision 8): an existing project file (even broken JSON) → project, wholly
 * replacing the global file; otherwise global. No per-key merging.
 */
export function resolveActiveLayer(cwd: string): { path: string; layer: "project" | "global" } {
  const resolved = resolveActiveLayerWithStat(cwd);
  return { path: resolved.path, layer: resolved.layer };
}

/** Whether a regular config file exists (independent of readLayer's error message);
 * directories, FIFOs, and other non-files never count as a config layer. */
export function configFileExists(path: string): boolean {
  return statFile(path) !== undefined;
}

/** File identity for cache validation: mtime alone can collide when a writer swaps
 * content within the same millisecond; pairing it with size keeps the check exact. */
interface FileStat {
  mtimeMs: number;
  size: number;
}

/** Stat a config path; undefined when missing, unreadable, or not a regular file. */
function statFile(path: string): FileStat | undefined {
  try {
    const st = statSync(path);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : undefined;
  } catch {
    return undefined;
  }
}

/** Default global paths, memoized per homedir() value so the fallback branch does not
 * re-run resolve() on every hot-path read (tests may swap HOME between scenarios). */
let defaultGlobalPathsCache: { home: string; ompGlobal: string; piGlobal: string } | null = null;
function defaultGlobalPaths(): { home: string; ompGlobal: string; piGlobal: string } {
  const home = homedir();
  if (!defaultGlobalPathsCache || defaultGlobalPathsCache.home !== home) {
    defaultGlobalPathsCache = {
      home,
      ompGlobal: resolve(home, ".omp", "agent", "pi-model-sync.json"),
      piGlobal: resolve(home, ".pi", "agent", "pi-model-sync.json"),
    };
  }
  return defaultGlobalPathsCache;
}

/** resolveActiveLayer's probe with the resolved file's stat attached:
 * FileStat — the layer was found by probing; null — the final default is known missing;
 * undefined — the path came from an env override and has not been probed yet. */
function resolveActiveLayerWithStat(cwd: string): {
  path: string;
  layer: "project" | "global";
  stat: FileStat | null | undefined;
} {
  const ompProject = resolve(cwd, ".omp", "pi-model-sync.json");
  const ompProjectStat = statFile(ompProject);
  if (ompProjectStat) {
    return { path: ompProject, layer: "project", stat: ompProjectStat };
  }
  const piProject = resolve(cwd, ".pi", "pi-model-sync.json");
  const piProjectStat = statFile(piProject);
  if (piProjectStat) {
    return { path: piProject, layer: "project", stat: piProjectStat };
  }
  const override = process.env.PI_MODEL_SYNC_CONFIG?.trim();
  if (override) {
    const path = isAbsolute(override) ? override : resolve(cwd, override);
    return { path, layer: "global", stat: undefined };
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    const path = resolve(cwd, agentDir, "pi-model-sync.json");
    return { path, layer: "global", stat: undefined };
  }
  const { ompGlobal, piGlobal } = defaultGlobalPaths();
  const ompGlobalStat = statFile(ompGlobal);
  if (ompGlobalStat) {
    return { path: ompGlobal, layer: "global", stat: ompGlobalStat };
  }
  const piGlobalStat = statFile(piGlobal);
  if (piGlobalStat) {
    return { path: piGlobal, layer: "global", stat: piGlobalStat };
  }
  return { path: ompGlobal, layer: "global", stat: null };
}

interface CachedLayer {
  mtimeMs: number;
  size: number;
  config: ModelSyncConfig;
  error: string | null;
}

/** Module-level mtime+size cache (child sessions share module state with the parent). */
const layerCache = new Map<string, CachedLayer>();

/** Shared read-only empty config for a missing file (legacy shape keeps writes downgrade-compatible). */
const EMPTY_CONFIG: ModelSyncConfig = { profiles: [] };

/** Shared fail-closed config for parse/structural errors: a named config with no presets. */
const INVALID_CONFIG: ModelSyncConfig = { presets: Object.create(null) as PresetMap };

export function readLayer(path: string): { config: ModelSyncConfig; error: string | null } {
  return readLayerWithStat(path, statFile(path) ?? null);
}

function readLayerWithStat(
  path: string,
  stat: FileStat | null,
): { config: ModelSyncConfig; error: string | null } {
  if (stat === null) {
    layerCache.delete(path);
    return { config: EMPTY_CONFIG, error: `Config file not found: ${path}` };
  }
  const cached = layerCache.get(path);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    // Zero-copy hit: consumers either read only or clone before editing (loadForWrite
    // clones the whole document), matching the documented shared-nested-maps cache contract.
    return { config: cached.config, error: cached.error };
  }
  let config: ModelSyncConfig = INVALID_CONFIG;
  let error: string | null = null;
  try {
    const parsed = parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
    config = parsed.config;
    error = parsed.error ? `Invalid config file (${path}): ${parsed.error}` : null;
  } catch (err) {
    error = `Could not parse config file (${path}): ${err instanceof Error ? err.message : String(err)}`;
  }
  if (layerCache.size >= 64) layerCache.clear();
  layerCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, config, error });
  return { config, error };
}

/** For the spawn-interception path: never throws; zero profiles on any file error and
 * the same active-preset projection the command displays use otherwise. */
export function readConfig(cwd: string): EffectiveConfig {
  try {
    const { path, stat } = resolveActiveLayerWithStat(cwd);
    const layer = readLayerWithStat(path, stat !== undefined ? stat : statFile(path) ?? null);
    if (layer.error) return { profiles: [], warning: layer.error };
    return projectActiveProfiles(layer.config);
  } catch {
    return { profiles: [] };
  }
}

/** Atomic write: mkdir → unique <path>.<pid>.<timestamp>.tmp → rename; the tmp file is
 * removed on failure and the mtime cache entry invalidated after a successful rename. */
export function writeConfig(path: string, config: ModelSyncConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  // Unique suffix: concurrent sessions must not fight over one shared tmp file.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort: the tmp file may never have been created.
    }
    throw err;
  }
  layerCache.delete(path);
}

/** Compiled glob cache keyed by (already lowercased) pattern; configs are small and user-authored. */
const globCache = new Map<string, RegExp>();

/** `*` matches any string (including `/`); all other regex metachars are escaped. Input must already be lowercased. */
function globToRegExp(pattern: string): RegExp {
  let re = globCache.get(pattern);
  if (!re) {
    if (globCache.size >= 256) globCache.clear();
    const escaped = pattern.replace(/\*+|[.+?^${}()|[\]\\]/g, (match) => (match[0] === "*" ? ".*" : `\\${match}`));
    re = new RegExp(`^${escaped}$`);
    globCache.set(pattern, re);
  }
  return re;
}

/**
 * Matching rules (decision 3; everything lowercased):
 * - main without `*`: exact equality against provider/id or bare id.
 * - main with `*`: glob, whole-string match against both the provider/id and bare id forms.
 * First match in profile order wins; returns undefined when model is undefined.
 */
export function findProfile(
  config: EffectiveConfig | { profiles: Profile[] },
  model: CurrentModelRef | undefined,
): Profile | undefined {
  if (!model || !model.id || config.profiles.length === 0) return undefined;
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  const full = provider ? `${provider}/${id}` : id;
  for (const profile of config.profiles) {
    const main = profile.main.toLowerCase();
    if (main.includes("*")) {
      const re = globToRegExp(main);
      if (re.test(full) || (full !== id && re.test(id))) return profile;
    } else if (main === full || main === id) {
      return profile;
    }
  }
  return undefined;
}

/**
 * String form returns itself; object form tries the exact agent key, then falls back to `*`.
 * Own-property lookup only: prototype-member agent names ("toString", "constructor", ...)
 * must fall through to `*` — pi-subagent agent names are arbitrary model input.
 */
export function pickSubagentSelector(profile: Profile, agentName: string): string | undefined {
  if (typeof profile.subagents === "string") return profile.subagents;
  return Object.hasOwn(profile.subagents, agentName) ? profile.subagents[agentName] : profile.subagents["*"];
}

/** Null-prototype copy for the command path: a "__proto__" key stays an own property
 * (same hardening as normalizeConfig); an object spread would restore Object.prototype. */
export function cloneSubagentMap(source: SubagentMap): SubagentMap {
  const map: SubagentMap = Object.create(null) as SubagentMap;
  Object.assign(map, source);
  return map;
}

export function isNamedConfig(
  config: ModelSyncConfig,
): config is { activePreset?: string; presets: PresetMap } {
  return "presets" in config;
}

/** Deep-clone profile lists; nested subagent maps become null-prototype copies. */
export function cloneProfiles(profiles: Profile[]): Profile[] {
  return profiles.map((profile) => ({
    main: profile.main,
    subagents:
      typeof profile.subagents === "string" ? profile.subagents : cloneSubagentMap(profile.subagents),
  }));
}

/** Full-document deep clone for the write path: every preset and every nested map. */
export function cloneConfig(config: ModelSyncConfig): ModelSyncConfig {
  if (!isNamedConfig(config)) return { profiles: cloneProfiles(config.profiles) };
  const presets: PresetMap = Object.create(null) as PresetMap;
  for (const [name, profiles] of Object.entries(config.presets)) {
    presets[name] = cloneProfiles(profiles);
  }
  return config.activePreset === undefined
    ? { presets }
    : { activePreset: config.activePreset, presets };
}

/** The only active-selection policy. Legacy configs expose the virtual "default" preset.
 * Named configs fail closed on a missing or dangling active name — never fall back. */
export function projectActiveProfiles(config: ModelSyncConfig): EffectiveConfig {
  if (!isNamedConfig(config)) {
    return { activePreset: "default", profiles: config.profiles };
  }
  const activePreset = config.activePreset;
  if (!activePreset) {
    return {
      profiles: [],
      warning: "No active preset is selected; no profiles are active.",
    };
  }
  if (!Object.hasOwn(config.presets, activePreset)) {
    return {
      profiles: [],
      warning: `Active preset "${activePreset}" does not exist; no profiles are active.`,
    };
  }
  return { activePreset, profiles: config.presets[activePreset] };
}

/** Preset names in document order; a legacy config exposes the virtual "default". */
export function presetNames(config: ModelSyncConfig): string[] {
  return isNamedConfig(config) ? Object.keys(config.presets) : ["default"];
}

/** Exact, case-sensitive preset lookup; legacy "default" maps to its profiles array. */
export function getPresetProfiles(config: ModelSyncConfig, name: string): Profile[] | undefined {
  if (!isNamedConfig(config)) return name === "default" ? config.profiles : undefined;
  return Object.hasOwn(config.presets, name) ? config.presets[name] : undefined;
}

/** Convert a legacy document to named mode without switching away from its profiles. */
export function toPresetConfig(config: { profiles: Profile[] }): {
  activePreset: string;
  presets: PresetMap;
} {
  const presets: PresetMap = Object.create(null) as PresetMap;
  presets.default = cloneProfiles(config.profiles);
  return { activePreset: "default", presets };
}

/**
 * Normalize raw profile entries: skip entries with a non-string/blank main, a subagents value
 * that is neither string nor object, or object keys whose values are not non-blank strings;
 * trim everything; preserve profile order.
 */
function normalizeProfiles(rawProfiles: unknown): Profile[] {
  const profiles: Profile[] = [];
  if (!Array.isArray(rawProfiles)) return profiles;
  for (const entry of rawProfiles) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const mainRaw = "main" in entry ? entry.main : undefined;
    if (typeof mainRaw !== "string" || !mainRaw.trim()) continue;
    const subRaw = "subagents" in entry ? entry.subagents : undefined;
    let subagents: Profile["subagents"];
    if (typeof subRaw === "string") {
      if (!subRaw.trim()) continue;
      subagents = subRaw.trim();
    } else if (subRaw && typeof subRaw === "object" && !Array.isArray(subRaw)) {
      // Null-prototype map: a "__proto__" key in the config stays an own property.
      const map: SubagentMap = Object.create(null) as SubagentMap;
      for (const [key, value] of Object.entries(subRaw)) {
        if (typeof value !== "string" || !value.trim()) continue;
        const agentName = key.trim();
        if (!agentName) continue;
        map[agentName] = value.trim();
      }
      if (Object.keys(map).length === 0) continue;
      subagents = map;
    } else {
      continue;
    }
    profiles.push({ main: mainRaw.trim(), subagents });
  }
  return profiles;
}

interface ParsedConfig {
  config: ModelSyncConfig;
  error: string | null;
}

/** Internal parse boundary: shape errors are returned, never thrown. Structural errors
 * yield a fail-closed config so a partially valid document cannot route. */
function parseConfig(raw: unknown): ParsedConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      config: INVALID_CONFIG,
      error: "Config root must be a JSON object.",
    };
  }
  const record = raw as Record<string, unknown>;
  const hasProfiles = Object.hasOwn(record, "profiles");
  const hasPresets = Object.hasOwn(record, "presets");
  const hasActive = Object.hasOwn(record, "activePreset");
  if (hasProfiles && (hasPresets || hasActive)) {
    return {
      config: INVALID_CONFIG,
      error: 'Config cannot mix "profiles" with "presets" or "activePreset".',
    };
  }
  if (hasPresets || hasActive) {
    if (!hasPresets) {
      return {
        config: INVALID_CONFIG,
        error: 'A config with "activePreset" must also define a "presets" object.',
      };
    }
    const rawPresets = record.presets;
    if (!rawPresets || typeof rawPresets !== "object" || Array.isArray(rawPresets)) {
      return {
        config: INVALID_CONFIG,
        error: '"presets" must be an object mapping preset names to profile arrays.',
      };
    }
    const rawActive = hasActive ? record.activePreset : undefined;
    if (hasActive && (typeof rawActive !== "string" || !rawActive.trim())) {
      return {
        config: INVALID_CONFIG,
        error: '"activePreset" must be a non-blank string when present.',
      };
    }
    const presets: PresetMap = Object.create(null) as PresetMap;
    for (const [rawName, rawProfiles] of Object.entries(rawPresets as Record<string, unknown>)) {
      const name = rawName.trim();
      if (!name || /\s/.test(name)) {
        return {
          config: INVALID_CONFIG,
          error: `Invalid preset name "${rawName}": preset names must be single tokens.`,
        };
      }
      if (Object.hasOwn(presets, name)) {
        return {
          config: INVALID_CONFIG,
          error: `Duplicate preset name "${name}" after trimming.`,
        };
      }
      if (!Array.isArray(rawProfiles)) {
        return {
          config: INVALID_CONFIG,
          error: `Preset "${name}" must be an array of profiles.`,
        };
      }
      presets[name] = normalizeProfiles(rawProfiles);
    }
    const activePreset = typeof rawActive === "string" ? rawActive.trim() : undefined;
    return {
      config: activePreset === undefined ? { presets } : { activePreset, presets },
      error: null,
    };
  }
  const rawProfiles = hasProfiles ? record.profiles : undefined;
  return {
    config: { profiles: Array.isArray(rawProfiles) ? normalizeProfiles(rawProfiles) : [] },
    error: null,
  };
}

/** Normalize raw JSON for reads and writes; malformed preset envelopes fail closed. */
export function normalizeConfig(raw: unknown): ModelSyncConfig {
  return parseConfig(raw).config;
}
