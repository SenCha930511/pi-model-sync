import { statSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

// ── domain types ─────────────────────────────────────────────────

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

export interface LayerRead {
  config: ModelSyncConfig;
  error: string | null;
  exists: boolean;
  warnings: string[];
}

// ── path resolution ──────────────────────────────────────────────

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}

/** Default global paths, memoized per homedir() value so the fallback branch does not
 * re-run resolve() on every hot-path read. */
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

/** Project layer probe: `.omp` wins when both files exist; `.pi` is the upstream-pi fallback. */
function resolveProjectLayer(cwd: string): { path: string; stat: FileStat | undefined } {
  const ompPath = resolve(cwd, ".omp", "pi-model-sync.json");
  const ompStat = statFile(ompPath);
  if (ompStat) return { path: ompPath, stat: ompStat };
  const piPath = resolve(cwd, ".pi", "pi-model-sync.json");
  const piStat = statFile(piPath);
  if (piStat) return { path: piPath, stat: piStat };
  return { path: ompPath, stat: undefined };
}

/** Resolve the global layer; stat is undefined for env overrides and null when the default path is known missing. */
function resolveGlobalLayer(cwd?: string): { path: string; stat: FileStat | null | undefined } {
  const override = process.env.PI_MODEL_SYNC_CONFIG?.trim();
  if (override) {
    const expanded = expandHomePath(override);
    return {
      path: isAbsolute(expanded) ? expanded : resolve(cwd ?? process.cwd(), expanded),
      stat: undefined,
    };
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    return {
      path: resolve(cwd ?? process.cwd(), expandHomePath(agentDir), "pi-model-sync.json"),
      stat: undefined,
    };
  }
  const { ompGlobal, piGlobal } = defaultGlobalPaths();
  const ompStat = statFile(ompGlobal);
  if (ompStat) return { path: ompGlobal, stat: ompStat };
  const piStat = statFile(piGlobal);
  if (piStat) return { path: piGlobal, stat: piStat };
  return { path: ompGlobal, stat: null };
}

/**
 * Global config path:
 * PI_MODEL_SYNC_CONFIG (absolute, or relative to the session cwd; a leading ~/ expands)
 * → PI_CODING_AGENT_DIR/pi-model-sync.json (also expands ~/) → ~/.omp/agent/pi-model-sync.json.
 * Decision 12: on the final fallback, when the ~/.omp file does not exist and the ~/.pi
 * file does, return ~/.pi/agent/pi-model-sync.json. When neither exists, the omp path
 * remains the write target.
 */
export function getGlobalConfigPath(cwd?: string): string {
  return resolveGlobalLayer(cwd).path;
}

/** Project config path: current cwd only, no upward search. Decision 12 fallback: `.pi`. */
export function getProjectConfigPath(cwd: string): string {
  return resolveProjectLayer(cwd).path;
}

/** Decision 8: an existing project file wholly replaces the global file. No per-key merge. */
export function resolveActiveLayer(cwd: string): { path: string; layer: "project" | "global" } {
  const resolved = resolveActiveLayerWithStat(cwd);
  return { path: resolved.path, layer: resolved.layer };
}

function resolveActiveLayerWithStat(cwd: string): {
  path: string;
  layer: "project" | "global";
  stat: FileStat | null | undefined;
} {
  const project = resolveProjectLayer(cwd);
  if (project.stat) return { path: project.path, layer: "project", stat: project.stat };
  const global = resolveGlobalLayer(cwd);
  return { path: global.path, layer: "global", stat: global.stat };
}

// ── cache and reads ──────────────────────────────────────────────

/** File identity for cache validation. mtime+size alone can collide when a writer swaps
 * content within the same millisecond; ctime and inode close the remaining gap. */
interface FileStat {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

/** Stat a config path without throwing for a missing entry; other I/O errors stay quiet. */
function statFile(path: string): FileStat | undefined {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return undefined;
    return { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, ino: stat.ino };
  } catch {
    return undefined;
  }
}

interface CachedLayer extends FileStat {
  config: ModelSyncConfig;
  error: string | null;
  warnings: string[];
}

/** Module-level cache (child sessions share module state with the parent). Consumers
 * either read only or clone before editing; the cache stores the raw parsed document. */
const layerCache = new Map<string, CachedLayer>();

/** Shared read-only empty config for a missing file (legacy shape keeps writes downgrade-compatible). */
const EMPTY_CONFIG: ModelSyncConfig = { profiles: [] };

/** Shared fail-closed config for parse/structural errors: a named config with no presets. */
const INVALID_CONFIG: ModelSyncConfig = { presets: Object.create(null) as PresetMap };

export function readLayer(path: string): LayerRead {
  return readLayerWithStat(path, statFile(path) ?? null);
}

function readLayerWithStat(path: string, stat: FileStat | null): LayerRead {
  if (stat === null) {
    layerCache.delete(path);
    return { config: EMPTY_CONFIG, error: null, exists: false, warnings: [] };
  }
  const cached = layerCache.get(path);
  if (
    cached &&
    cached.mtimeMs === stat.mtimeMs &&
    cached.ctimeMs === stat.ctimeMs &&
    cached.size === stat.size &&
    cached.ino === stat.ino
  ) {
    return { config: cached.config, error: cached.error, exists: true, warnings: cached.warnings };
  }
  let config: ModelSyncConfig = INVALID_CONFIG;
  let error: string | null = null;
  let warnings: string[] = [];
  try {
    const parsed = parseConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
    config = parsed.config;
    warnings = parsed.warnings;
    error = parsed.error ? `Invalid config file (${path}): ${parsed.error}` : null;
  } catch (err) {
    error = `Could not parse config file (${path}): ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!layerCache.has(path) && layerCache.size >= 64) {
    const oldest = layerCache.keys().next().value;
    if (oldest !== undefined) layerCache.delete(oldest);
  }
  layerCache.set(path, { ...stat, config, error, warnings });
  return { config, error, exists: true, warnings };
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

// ── writes ───────────────────────────────────────────────────────

/** Atomic write: mkdir → unique <path>.<pid>.<timestamp>.tmp → rename; the tmp file is
 * removed on failure and the mtime cache entry invalidated after a successful rename.
 * The parse guard makes a malformed document impossible to persist. */
export function writeConfig(path: string, config: ModelSyncConfig): void {
  const parsed = parseConfig(config);
  if (parsed.error) throw new Error(`Refusing to write an invalid config: ${parsed.error}`);
  mkdirSync(dirname(path), { recursive: true });
  // Unique suffix: concurrent sessions must not fight over one shared tmp file.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(parsed.config, null, 2)}\n`, "utf8");
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

// ── matching ─────────────────────────────────────────────────────

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

// ── presets and clones ───────────────────────────────────────────

/** Null-prototype copy for the command path: a "__proto__" key stays an own property
 * (same hardening as normalizeProfiles); an object spread would restore Object.prototype. */
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

/** Deep-clone the whole document for the write path. */
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
  const profiles = config.presets[activePreset];
  if (!Object.hasOwn(config.presets, activePreset) || !profiles) {
    return {
      profiles: [],
      warning: `Active preset "${activePreset}" does not exist; no profiles are active.`,
    };
  }
  return { activePreset, profiles };
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

export function isValidPresetName(name: string): boolean {
  return name.length > 0 && !/\s/.test(name);
}

// ── parse boundary ───────────────────────────────────────────────

interface ParsedConfig {
  config: ModelSyncConfig;
  error: string | null;
  warnings: string[];
}

interface NormalizedProfiles {
  profiles: Profile[];
  warnings: string[];
}

function invalidConfig(error: string): ParsedConfig {
  return { config: INVALID_CONFIG, error, warnings: [] };
}

/**
 * Normalize raw profile entries: skip entries with a non-string/blank main, a subagents value
 * that is neither string nor object, or object keys whose values are not non-blank strings;
 * trim everything; preserve profile order. Skipped entries become warnings, not silence.
 */
function normalizeProfiles(rawProfiles: unknown, scope: string): NormalizedProfiles {
  const profiles: Profile[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(rawProfiles)) return { profiles, warnings };
  for (let index = 0; index < rawProfiles.length; index += 1) {
    const entry = rawProfiles[index];
    const where = `profile ${index + 1} in ${scope}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`Skipped ${where}: entry must be an object.`);
      continue;
    }
    const record = entry as Record<string, unknown>;
    const mainRaw = record.main;
    if (typeof mainRaw !== "string" || !mainRaw.trim()) {
      warnings.push(`Skipped ${where}: "main" must be a non-blank string.`);
      continue;
    }
    const subRaw = record.subagents;
    let subagents: Profile["subagents"];
    if (typeof subRaw === "string") {
      if (!subRaw.trim()) {
        warnings.push(`Skipped ${where}: "subagents" must be a non-blank string.`);
        continue;
      }
      subagents = subRaw.trim();
    } else if (subRaw && typeof subRaw === "object" && !Array.isArray(subRaw)) {
      // Null-prototype map: a "__proto__" key in the config stays an own property.
      const map: SubagentMap = Object.create(null) as SubagentMap;
      for (const [key, value] of Object.entries(subRaw)) {
        if (typeof value !== "string" || !value.trim()) {
          warnings.push(`Skipped agent entry "${key}" in ${where}: value must be a non-blank string.`);
          continue;
        }
        const agentName = key.trim();
        if (!agentName) {
          warnings.push(`Skipped a blank agent key in ${where}.`);
          continue;
        }
        map[agentName] = value.trim();
      }
      if (Object.keys(map).length === 0) {
        warnings.push(`Skipped ${where}: no valid agent entries.`);
        continue;
      }
      subagents = map;
    } else {
      warnings.push(`Skipped ${where}: "subagents" must be a non-blank string or an object of non-blank strings.`);
      continue;
    }
    profiles.push({ main: mainRaw.trim(), subagents });
  }
  return { profiles, warnings };
}

/** Internal parse boundary: shape errors are returned, never thrown. Structural errors
 * yield a fail-closed config so a partially valid document cannot route. */
function parseConfig(raw: unknown): ParsedConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidConfig("Config root must be a JSON object.");
  }
  const record = raw as Record<string, unknown>;
  const hasProfiles = Object.hasOwn(record, "profiles");
  const hasPresets = Object.hasOwn(record, "presets");
  const hasActive = Object.hasOwn(record, "activePreset");
  if (hasProfiles && (hasPresets || hasActive)) {
    return invalidConfig('Config cannot mix "profiles" with "presets" or "activePreset".');
  }
  if (hasPresets || hasActive) {
    if (!hasPresets) {
      return invalidConfig('A config with "activePreset" must also define a "presets" object.');
    }
    const rawPresets = record.presets;
    if (!rawPresets || typeof rawPresets !== "object" || Array.isArray(rawPresets)) {
      return invalidConfig('"presets" must be an object mapping preset names to profile arrays.');
    }
    let activePreset: string | undefined;
    if (hasActive) {
      const rawActive = record.activePreset;
      if (rawActive === null || (typeof rawActive === "string" && !rawActive.trim())) {
        activePreset = undefined;
      } else if (typeof rawActive === "string") {
        activePreset = rawActive.trim();
      } else {
        return invalidConfig('"activePreset" must be a string or null when present.');
      }
    }
    const presets: PresetMap = Object.create(null) as PresetMap;
    const warnings: string[] = [];
    for (const [rawName, rawProfiles] of Object.entries(rawPresets as Record<string, unknown>)) {
      const name = rawName.trim();
      if (!isValidPresetName(name)) {
        return invalidConfig(`Invalid preset name "${rawName}": preset names must be single tokens.`);
      }
      if (Object.hasOwn(presets, name)) {
        return invalidConfig(`Duplicate preset name "${name}" after trimming.`);
      }
      if (!Array.isArray(rawProfiles)) {
        return invalidConfig(`Preset "${name}" must be an array of profiles.`);
      }
      const normalized = normalizeProfiles(rawProfiles, `preset "${name}"`);
      presets[name] = normalized.profiles;
      warnings.push(...normalized.warnings);
    }
    return {
      config: activePreset === undefined ? { presets } : { activePreset, presets },
      error: null,
      warnings,
    };
  }
  if (!hasProfiles) {
    if (Object.keys(record).length === 0) {
      return { config: { profiles: [] }, error: null, warnings: [] };
    }
    return invalidConfig('Config must define "profiles" or "presets".');
  }
  const rawProfiles = record.profiles;
  if (!Array.isArray(rawProfiles)) {
    return invalidConfig('"profiles" must be an array of profiles.');
  }
  const normalized = normalizeProfiles(rawProfiles, "the legacy profile list");
  return { config: { profiles: normalized.profiles }, error: null, warnings: normalized.warnings };
}
