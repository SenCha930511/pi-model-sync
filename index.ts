/**
 * pi-model-sync — 依「發起 spawn 的 session 當下模型」路由 subagent 模型。
 *
 * 於 before_subagent_spawn 查 profile 對應（含巢狀 spawn：事件在發起 session 觸發，
 * ctx.models.current() 即該 session 的模型）。命中且 selector 可解析時改寫 child 的
 * 模型（原 patterns 保留為 retry fallback chain）；其餘情況一律不攔截。
 * 啟動完全安靜（決策 6）：沒有 session_start 通知。
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  configFileExists,
  findProfile,
  getGlobalConfigPath,
  getProjectConfigPath,
  pickSubagentSelector,
  readConfig,
  readLayer,
  resolveActiveLayer,
  writeConfig,
} from "./config";
import type { CurrentModelRef, ModelSyncConfig, Profile, SubagentMap } from "./config";

/** 已警告過「無法解析」的 selector（每 selector 只警告一次）。 */
const warnedSelectors = new Set<string>();

interface ModelsFacade {
  current(): unknown;
  resolve(spec: string): unknown;
}

interface UiFacade {
  notify(message: string, level?: string): void;
}

interface ExtensionContextLike {
  cwd: string;
  mode?: string;
  models: ModelsFacade;
  ui: UiFacade;
}

interface SubagentSpawnEvent {
  agent?: unknown;
  patterns?: unknown;
}

/** ctx.models.current() → 比對用 { provider, id }；無法辨識時回 undefined。 */
function toModelRef(model: unknown): CurrentModelRef | undefined {
  if (!model || typeof model !== "object") return undefined;
  let id: string | undefined;
  if ("id" in model && typeof model.id === "string") id = model.id;
  else if ("modelId" in model && typeof model.modelId === "string") id = model.modelId;
  else if ("model" in model && typeof model.model === "string") id = model.model;
  if (!id) return undefined;
  let provider = "";
  if ("provider" in model && typeof model.provider === "string") provider = model.provider;
  else if ("providerId" in model && typeof model.providerId === "string") provider = model.providerId;
  return { provider, id };
}

/** event.agent 形狀未在文件明示：字串或 { name }，都失敗時 fallback "task"。 */
function extractAgentName(event: SubagentSpawnEvent): string {
  const agent = event.agent;
  if (typeof agent === "string" && agent.trim()) return agent.trim();
  if (agent && typeof agent === "object" && "name" in agent) {
    const name = agent.name;
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return "task";
}

function summarizeSubagents(subagents: Profile["subagents"]): string {
  if (typeof subagents === "string") return subagents;
  return Object.entries(subagents)
    .map(([agent, selector]) => `${agent}=${selector}`)
    .join(", ");
}

function notify(ctx: ExtensionContextLike, message: string): void {
  ctx.ui.notify(message, "info");
}

export default function modelSync(pi: ExtensionAPI): void {
  pi.setLabel("Model Sync");

  // ── spawn 路由（決策 1、2、4、7、10）─────────────────────────────
  pi.on("before_subagent_spawn", (event: SubagentSpawnEvent, ctx: ExtensionContextLike) => {
    try {
      const profile = findProfile(readConfig(ctx.cwd), toModelRef(ctx.models.current()));
      if (!profile) return undefined;
      const agentName = extractAgentName(event);
      const selector = pickSubagentSelector(profile, agentName);
      if (!selector) return undefined;
      let resolved: unknown;
      try {
        resolved = ctx.models.resolve(selector);
      } catch {
        resolved = undefined;
      }
      if (!resolved) {
        // 決策 4：解析失敗退回預設路由，TUI 一次性警告。
        if (ctx.mode === "tui" && !warnedSelectors.has(selector)) {
          warnedSelectors.add(selector);
          notify(ctx, `pi-model-sync: selector "${selector}" 無法解析為可用模型，此 spawn 使用預設路由`);
        }
        return undefined;
      }
      const rawPatterns = event.patterns;
      const basePatterns = Array.isArray(rawPatterns)
        ? rawPatterns.filter((p): p is string => typeof p === "string")
        : typeof rawPatterns === "string"
          ? [rawPatterns]
          : [];
      const patterns = basePatterns.filter((p) => p !== selector);
      return {
        model: [selector, ...patterns],
        note: `pi-model-sync: ${agentName} → ${selector} (main: ${profile.main})`,
      };
    } catch {
      return undefined; // spawn 攔截路徑絕不丟例外
    }
  });

  // ── /model-sync 指令（決策 5、9）────────────────────────────────
  const USAGE = [
    "pi-model-sync 指令：",
    "  /model-sync [list]                      顯示生效層與所有 profile",
    "  /model-sync show                        顯示目前模型、命中 profile 與 selector 解析狀態",
    "  /model-sync add <main> <model>          新增/更新 profile（所有 subagent 用 <model>）",
    "  /model-sync set <main> <agent> <model>  設定特定 agent 的模型（<agent> 為 * 時設為該 profile 預設）",
    "  /model-sync remove <main> [agent]       移除整個 profile 或其中一個 agent 設定",
    "所有子命令皆可加 --project 旗標寫入專案層（<cwd>/.omp/pi-model-sync.json）；預設寫全域檔。",
  ].join("\n");

  pi.registerCommand("model-sync", {
    description: "Manage main-model → subagent model mappings",
    handler: async (argsString: string, ctx: ExtensionContextLike) => {
      try {
        await handleCommand(String(argsString ?? ""), ctx);
      } catch (err) {
        notify(ctx, `pi-model-sync: 指令執行失敗：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  async function handleCommand(argsString: string, ctx: ExtensionContextLike): Promise<void> {
    const tokens = argsString.trim().split(/\s+/).filter((t) => t.length > 0);
    const useProject = tokens.includes("--project");
    const args = tokens.filter((t) => t !== "--project");
    const [sub, ...rest] = args;
    const target = useProject ? getProjectConfigPath(ctx.cwd) : getGlobalConfigPath();

    switch (sub) {
      case undefined:
      case "":
      case "list":
        cmdList(ctx);
        return;
      case "show":
        cmdShow(ctx);
        return;
      case "add": {
        const [main, model] = rest;
        if (!main || !model) {
          notify(ctx, "用法：/model-sync add <main> <model>");
          return;
        }
        cmdAdd(ctx, target, main, model);
        return;
      }
      case "set": {
        const [main, agent, model] = rest;
        if (!main || !agent || !model) {
          notify(ctx, "用法：/model-sync set <main> <agent> <model>");
          return;
        }
        cmdSet(ctx, target, main, agent, model);
        return;
      }
      case "remove": {
        const [main, agent] = rest;
        if (!main) {
          notify(ctx, "用法：/model-sync remove <main> [agent]");
          return;
        }
        cmdRemove(ctx, target, main, agent);
        return;
      }
      default:
        notify(ctx, USAGE);
    }
  }

  /** 讀 target 供寫入；檔案存在但壞掉時拒寫（避免蓋掉使用者手改一半的內容）。 */
  function loadForWrite(ctx: ExtensionContextLike, target: string): ModelSyncConfig | null {
    const layer = readLayer(target);
    if (layer.error && configFileExists(target)) {
      notify(ctx, `pi-model-sync: ${layer.error}\n請先修復或刪除該檔，再執行寫入指令。`);
      return null;
    }
    return {
      profiles: layer.config.profiles.map((p) => ({
        main: p.main,
        subagents: typeof p.subagents === "string" ? p.subagents : { ...p.subagents },
      })),
    };
  }

  function cmdAdd(ctx: ExtensionContextLike, target: string, main: string, model: string): void {
    const config = loadForWrite(ctx, target);
    if (!config) return;
    const existing = config.profiles.find((p) => p.main.toLowerCase() === main.toLowerCase());
    if (existing) {
      existing.main = main;
      existing.subagents = model;
    } else {
      config.profiles.push({ main, subagents: model });
    }
    writeConfig(target, config);
    notify(ctx, `已寫入 ${target}\n  ${main} → ${model}`);
  }

  function cmdSet(
    ctx: ExtensionContextLike,
    target: string,
    main: string,
    agent: string,
    model: string,
  ): void {
    const config = loadForWrite(ctx, target);
    if (!config) return;
    const existing = config.profiles.find((p) => p.main.toLowerCase() === main.toLowerCase());
    const profile: Profile = existing ?? { main, subagents: {} };
    if (agent === "*") {
      profile.subagents = model;
    } else {
      const map: SubagentMap =
        typeof profile.subagents === "string" ? { "*": profile.subagents } : { ...profile.subagents };
      map[agent] = model;
      profile.subagents = map;
    }
    if (!existing) config.profiles.push(profile);
    writeConfig(target, config);
    notify(ctx, `已寫入 ${target}\n  ${main} → ${summarizeSubagents(profile.subagents)}`);
  }

  function cmdRemove(
    ctx: ExtensionContextLike,
    target: string,
    main: string,
    agent: string | undefined,
  ): void {
    const config = loadForWrite(ctx, target);
    if (!config) return;
    const idx = config.profiles.findIndex((p) => p.main.toLowerCase() === main.toLowerCase());
    if (idx < 0) {
      notify(ctx, `找不到 main 為 ${main} 的 profile（target：${target}）`);
      return;
    }
    const profile = config.profiles[idx];
    if (agent) {
      if (typeof profile.subagents === "string") {
        notify(ctx, `此 profile 只有一個預設模型，請用 /model-sync remove ${main}`);
        return;
      }
      if (!(agent in profile.subagents)) {
        notify(ctx, `profile ${main} 沒有 agent "${agent}" 的設定`);
        return;
      }
      const map: SubagentMap = { ...profile.subagents };
      delete map[agent];
      if (Object.keys(map).length === 0) {
        config.profiles.splice(idx, 1);
      } else {
        profile.subagents = map;
      }
    } else {
      config.profiles.splice(idx, 1);
    }
    writeConfig(target, config);
    notify(ctx, `已寫入 ${target}`);
  }

  function cmdList(ctx: ExtensionContextLike): void {
    const layer = resolveActiveLayer(ctx.cwd);
    const active = readLayer(layer.path);
    const lines: string[] = [];
    lines.push(
      `pi-model-sync 生效層：${layer.layer === "project" ? "專案層（project）" : "全域層（global）"} — ${layer.path}`,
    );
    if (active.error) lines.push(active.error);
    const modelRef = toModelRef(ctx.models.current());
    const hit = findProfile(active.config, modelRef);
    if (active.config.profiles.length === 0) {
      lines.push("尚無 profile（/model-sync add <main> <model>）");
    } else {
      for (const profile of active.config.profiles) {
        lines.push(`  ${hit === profile ? "*" : " "} ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
      }
    }
    const otherPath =
      layer.layer === "project" ? getGlobalConfigPath() : getProjectConfigPath(ctx.cwd);
    if (otherPath !== layer.path && configFileExists(otherPath)) {
      const other = readLayer(otherPath);
      lines.push(`（未生效）${layer.layer === "project" ? "全域層" : "專案層"}：${otherPath}`);
      if (other.error) lines.push(`  ${other.error}`);
      for (const profile of other.config.profiles) {
        lines.push(`      ${profile.main} → ${summarizeSubagents(profile.subagents)}`);
      }
    }
    notify(ctx, lines.join("\n"));
  }

  function resolveStatus(ctx: ExtensionContextLike, selector: string): string {
    try {
      return ctx.models.resolve(selector) ? "（可解析）" : "（無法解析）";
    } catch {
      return "（無法解析）";
    }
  }

  function cmdShow(ctx: ExtensionContextLike): void {
    const modelRef = toModelRef(ctx.models.current());
    const current = modelRef
      ? modelRef.provider
        ? `${modelRef.provider}/${modelRef.id}`
        : modelRef.id
      : "（未知）";
    const layer = resolveActiveLayer(ctx.cwd);
    const active = readLayer(layer.path);
    const lines: string[] = [];
    lines.push(`目前 session 模型：${current}`);
    lines.push(
      `生效層：${layer.layer === "project" ? "專案層（project）" : "全域層（global）"} — ${layer.path}`,
    );
    if (active.error) lines.push(active.error);
    const profile = findProfile(active.config, modelRef);
    if (!profile) {
      lines.push(`目前模型 ${current} 沒有對應 profile`);
    } else {
      lines.push(`命中 profile：main=${profile.main}`);
      if (typeof profile.subagents === "string") {
        lines.push(`  * → ${profile.subagents}${resolveStatus(ctx, profile.subagents)}`);
      } else {
        for (const [agentName, selector] of Object.entries(profile.subagents)) {
          lines.push(`  ${agentName} → ${selector}${resolveStatus(ctx, selector)}`);
        }
      }
    }
    notify(ctx, lines.join("\n"));
  }
}
