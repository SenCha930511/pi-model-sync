# pi-model-sync

omp（oh my pi）擴充功能：依「發起 spawn 的 session 當下模型」自動改寫後續 subagent（task / eval agent() / workpool worker）使用的模型。

切換主模型後，**之後新 spawn** 的 subagent 依對應清單（profile）改用指定模型；執行中的 subagent 不會中途換模型。巢狀 spawn（subagent 再往下 spawn）也會攔截：查表鍵值是「發起 spawn 的 session 當下模型」。

## 安裝

三種方式任選一種，裝好即用（Bun 直接執行 TypeScript，免建置、免 dependency）：

1. 複製整個目錄到 `~/.omp/agent/extensions/pi-model-sync/`（`package.json` 的 `omp.extensions` 會指向 `./index.ts`）。
2. 在 `~/.omp/agent/config.yml` 加入：

   ```yaml
   extensions:
     - /path/to/pi-model-sync
   ```

3. 單次載入：`omp --extension /path/to/pi-model-sync`

## 設定檔

兩層設定，JSON 格式相同：

- **全域**：`~/.omp/agent/pi-model-sync.json`
  - 環境變數 `PI_MODEL_SYNC_CONFIG` 可覆寫路徑（相對路徑以 cwd resolve）。
  - `PI_CODING_AGENT_DIR` 存在時為 `<其值>/pi-model-sync.json`（優先序低於 `PI_MODEL_SYNC_CONFIG`）。
- **專案**：`<repo>/.omp/pi-model-sync.json`（只看當下目錄，不往上找）

**專案檔存在時整份取代全域檔**（不做逐條合併；專案檔 JSON 壞掉時視為存在但無 profile）。

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

- `main`：要比對的主模型（比對規則見下）。
- `subagents`：
  - 字串 → 該 profile 下所有 agent 都用此模型；
  - 物件 → key 為 agent 名稱（如 `task`、`scout`），`"*"` 為該 profile 的預設值。
- selector 完整直通 host 解析：`provider/id`、裸 `id`、role alias（如 `@smol`）、`:level` 後綴（如 `openai/gpt-6-luna:high`）皆原字串交給 OMP 解析。

## 比對規則

- `main` 不含 `*` → 完全相等：等於 `provider/id` 或裸 `id`（不分大小寫）。
- `main` 含 `*` → 明確 glob 萬用（`*` 可跨 `/`），對 `provider/id` 與裸 `id` 兩種形式比對。
- 不做隱含 substring 比對；檔案順序**第一個命中勝出**。

## /model-sync 指令

| 指令 | 說明 |
|---|---|
| `/model-sync` 或 `/model-sync list` | 顯示生效層與所有 profile |
| `/model-sync show` | 顯示目前模型、命中 profile 與 selector 解析狀態 |
| `/model-sync add <main> <model>` | 新增/更新 profile（所有 subagent 用 `<model>`） |
| `/model-sync set <main> <agent> <model>` | 設定特定 agent 的模型（`<agent>` 為 `*` 時設為該 profile 預設） |
| `/model-sync remove <main> [agent]` | 移除整個 profile 或其中一個 agent 設定 |

指令預設寫**全域**檔；任何子命令加上 `--project` 旗標改寫**專案**檔。也可直接手改 JSON 檔（以 mtime 快取偵測變更，存檔即生效）。

## 注意事項

- 執行中的 subagent 不會中途換模型；切換主模型只影響後續 spawn。
- 巢狀 spawn 以「發起 spawn 的 session 當下模型」查表（child session 只拿得到自己的模型，這是 API 唯一乾淨做法）。僅在 host 允許深度 ≥2 的巢式 spawn 時發生；上限由 `task.maxRecursionDepth` 設定控制（OMP 文件預設 2、負值不設限），深度達上限時 subagent 的 task 工具會被移除而無法再往下 spawn。
- profile 指定的 selector 無法解析時，該次 spawn 不攔截、走 OMP 原本路由，並在 TUI 一次性警告（每個 selector 只警告一次）。
- 路由生效時，task 卡片 / Agent Hub 顯示 routing note：`pi-model-sync: <agent> → <model> (main: <main>)`。
- 啟動完全安靜，不做任何 session 啟動通知。
