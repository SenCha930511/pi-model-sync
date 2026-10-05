import { statSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
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
 * PI_MODEL_SYNC_CONFIG (absolute, or relative to cwd) → PI_CODING_AGENT_DIR/pi-model-sync.json
 * → ~/.omp/agent/pi-model-sync.json.
 * Decision 12 (dual-host landing): on the final fallback, when the ~/.omp file does not exist
 * and the ~/.pi file does, return ~/.pi/agent/pi-model-sync.json (the upstream pi host's
 * default agent dir); when neither exists, the omp path remains the write target.
 * Known limit: named-profile (omp --profile <name>) agent dirs aren't covered by these two
 * env vars, so the default path applies there; override with PI_MODEL_SYNC_CONFIG.
 */
export function getGlobalConfigPath(): string {
  const override = process.env.PI_MODEL_SYNC_CONFIG?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(override);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) {
    return resolve(agentDir, "pi-model-sync.json");
  }
  const ompPath = resolve(homedir(), ".omp", "agent", "pi-model-sync.json");
  const piPath = resolve(homedir(), ".pi", "agent", "pi-model-sync.json");
  if (!configFileExists(ompPath) && configFileExists(piPath)) {
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
  if (!configFileExists(ompPath) && configFileExists(piPath)) {
    return piPath;
  }
  return ompPath;
}

/**
 * Active layer (decision 8): an existing project file (even broken JSON) → project, wholly
 * replacing the global file; otherwise global. No per-key merging.
 */
export function resolveActiveLayer(cwd: string): { path: string; layer: "project" | "global" } {
  const projectPath = getProjectConfigPath(cwd);
  try {
    statSync(projectPath);
    return { path: projectPath, layer: "project" };
  } catch {
    return { path: getGlobalConfigPath(), layer: "global" };
  }
}

/** Whether the file exists (independent of readLayer's error message). */
export function configFileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

interface CachedLayer {
  mtimeMs: number;
  config: ModelSyncConfig;
  error: string | null;
}

/** Module-level mtime cache (child sessions share module state with the parent). */
const layerCache = new Map<string, CachedLayer>();

/** Last active-layer error seen by readConfig (null on success). */
let lastError: string | null = null;

export function readLayer(path: string): { config: ModelSyncConfig; error: string | null } {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    layerCache.delete(path);
    return { config: { profiles: [] }, error: `Config file not found: ${path}` };
  }
  const cached = layerCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { config: { profiles: [...cached.config.profiles] }, error: cached.error };
  }
  let config: ModelSyncConfig = { profiles: [] };
  let error: string | null = null;
  try {
    config = normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (err) {
    error = `Could not parse config file (${path}): ${err instanceof Error ? err.message : String(err)}`;
  }
  layerCache.set(path, { mtimeMs, config, error });
  return { config: { profiles: [...config.profiles] }, error };
}

/** For the spawn-interception path: never throws; returns an empty config when unreadable. */
export function readConfig(cwd: string): ModelSyncConfig {
  const { path } = resolveActiveLayer(cwd);
  const result = readLayer(path);
  lastError = result.error;
  return result.config;
}

export function getLastConfigError(): string | null {
  return lastError;
}

/** Atomic write: mkdir → <path>.tmp → rename; invalidates the mtime cache entry afterwards. */
export function writeConfig(path: string, config: ModelSyncConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  layerCache.delete(path);
}

/** `*` matches any string (including `/`); all other regex metachars are escaped. Input must already be lowercased. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

/**
 * Matching rules (decision 3; everything lowercased):
 * - main without `*`: exact equality against provider/id or bare id.
 * - main with `*`: glob, whole-string match against both the provider/id and bare id forms.
 * First match in profile order wins; returns undefined when model is undefined.
 */
export function findProfile(config: ModelSyncConfig, model: CurrentModelRef | undefined): Profile | undefined {
  if (!model) return undefined;
  const provider = model.provider.toLowerCase();
  const id = model.id.toLowerCase();
  const full = provider ? `${provider}/${id}` : id;
  for (const profile of config.profiles) {
    const main = profile.main.toLowerCase();
    if (main.includes("*")) {
      const re = globToRegExp(main);
      if (re.test(full) || re.test(id)) return profile;
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
