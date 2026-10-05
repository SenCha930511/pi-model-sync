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
 * 全域設定檔路徑：
 * PI_MODEL_SYNC_CONFIG（絕對或相對於 cwd）→ PI_CODING_AGENT_DIR/pi-model-sync.json
 * → ~/.omp/agent/pi-model-sync.json。
 * 已知限制：named profile（omp --profile <name>）的 agent dir 不受這兩個 env 控制，
 * 此時用預設路徑；可用 PI_MODEL_SYNC_CONFIG 覆寫。
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
  return resolve(homedir(), ".omp", "agent", "pi-model-sync.json");
}

/** 專案設定檔路徑：只看當下 cwd，不往上找（與 OMP 專案設定慣例一致）。 */
export function getProjectConfigPath(cwd: string): string {
  return resolve(cwd, ".omp", "pi-model-sync.json");
}

/**
 * 決定生效層（決策 8）：專案檔存在（即使 JSON 壞掉）→ project，整份取代全域；
 * 否則 global。不做任何逐條合併。
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

/** 檔案是否存在（與 readLayer 的 error 訊息無關的獨立判斷）。 */
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

/** module-level：mtime 快取（child session 與 parent 共享 module 狀態）。 */
const layerCache = new Map<string, CachedLayer>();

/** readConfig 最後一次讀到的生效層錯誤（成功時為 null）。 */
let lastError: string | null = null;

export function readLayer(path: string): { config: ModelSyncConfig; error: string | null } {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    layerCache.delete(path);
    return { config: { profiles: [] }, error: `設定檔不存在：${path}` };
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
    error = `設定檔無法解析（${path}）：${err instanceof Error ? err.message : String(err)}`;
  }
  layerCache.set(path, { mtimeMs, config, error });
  return { config: { profiles: [...config.profiles] }, error };
}

/** spawn 攔截路徑用：絕不丟例外，讀不到就回空設定。 */
export function readConfig(cwd: string): ModelSyncConfig {
  const { path } = resolveActiveLayer(cwd);
  const result = readLayer(path);
  lastError = result.error;
  return result.config;
}

export function getLastConfigError(): string | null {
  return lastError;
}

/** atomic 寫入：mkdir → <path>.tmp → rename，寫完使 mtime 快取失效。 */
export function writeConfig(path: string, config: ModelSyncConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
  renameSync(tmp, path);
  layerCache.delete(path);
}

/** `*` 視為任意字串（含 `/`），其餘 regex 元字元 escape；輸入請先 lowercase。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

/**
 * 比對規則（決策 3，全部 lowercase）：
 * - main 不含 `*`：完全等於 provider/id 或裸 id。
 * - main 含 `*`：glob，對 provider/id 與裸 id 兩種形式各做整串比對。
 * 依 profiles 順序第一個命中者勝出；model 為 undefined 回 undefined。
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

/** 字串形式直接回傳；物件形式先 exact agent key，再 fallback `*`。 */
export function pickSubagentSelector(profile: Profile, agentName: string): string | undefined {
  if (typeof profile.subagents === "string") return profile.subagents;
  return profile.subagents[agentName] ?? profile.subagents["*"];
}

/**
 * 正規化原始 JSON：略過非字串/空白的 main、非字串且非物件的 subagents、
 * 物件內 value 非字串或空白的 key；全部 trim；保持 profiles 順序。
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
      const map: SubagentMap = {};
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
