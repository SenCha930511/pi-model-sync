import { statSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export type SubagentMap = Record<string, string>;

export interface Profile {
  main: string;
  subagents: string | SubagentMap;
}

export interface ModelSyncConfig {
  profiles: Profile[];
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

/** Shared read-only empty config for not-found and parse-failure results. */
const EMPTY_CONFIG: ModelSyncConfig = { profiles: [] };

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
    // rebuilds profiles), matching the documented shared-nested-maps cache contract.
    return { config: cached.config, error: cached.error };
  }
  let config: ModelSyncConfig = EMPTY_CONFIG;
  let error: string | null = null;
  try {
    config = normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (err) {
    error = `Could not parse config file (${path}): ${err instanceof Error ? err.message : String(err)}`;
  }
  if (layerCache.size >= 64) layerCache.clear();
  layerCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, config, error });
  return { config, error };
}

/** For the spawn-interception path: never throws; returns an empty config when unreadable. */
export function readConfig(cwd: string): ModelSyncConfig {
  try {
    const { path, stat } = resolveActiveLayerWithStat(cwd);
    return readLayerWithStat(path, stat !== undefined ? stat : statFile(path) ?? null).config;
  } catch {
    return EMPTY_CONFIG;
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
export function findProfile(config: ModelSyncConfig, model: CurrentModelRef | undefined): Profile | undefined {
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

/**
 * Normalize raw JSON: skip entries with a non-string/blank main, a subagents value that is
 * neither string nor object, or object keys whose values are not non-blank strings;
 * trim everything; preserve profile order.
 */
export function normalizeConfig(raw: unknown): ModelSyncConfig {
  const profiles: Profile[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { profiles };
  const rawProfiles = "profiles" in raw ? raw.profiles : undefined;
  if (!Array.isArray(rawProfiles)) return { profiles };
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
  return { profiles };
}
