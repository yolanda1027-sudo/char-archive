# 人物檔案館（char-archive）交接說明

SillyTavern（酒館）前端擴充，目前版本 **v0.7.9**。
用途：追蹤聊天中出現過的人物、年齡與外貌變化、經歷時間軸，以及人物之間的「關係」和「看法」，並在每輪把相關資料送給主聊天 AI。概念類似柏寶書，但專門記人物。

作者：小曦（使用者）＆ 墨墨（Claude）。所有介面文字、提示詞、註解都是繁體中文，之後修改也請維持繁體中文。

---

## 1. 檔案結構

```
char-archive/
├── manifest.json   擴充資訊（display_name、version）
├── index.js        全部邏輯，約 2600 行，單一 IIFE，沒有 import、沒有建置步驟
├── style.css       全部樣式，都掛在 #ca-root 底下；另有 #chat .ca-chip（訊息下方的小標籤）
├── HANDOFF.md      本文件
├── tests/mock-run.js     不開酒館也能跑的模擬測試
└── tests/keep-recent.js  「留最近幾則不整理」的模擬測試
```

- 純前端擴充，不需要伺服器插件。只透過 `SillyTavern.getContext()` 和酒館的事件取得資料。
- 每次發版：同步改 `manifest.json` 的 `version`、`index.js` 裡標題旁的 `ca-ver`、啟動時的 `console.log` 版本字串（用 `grep -n "v0.7.9"` 找）。

## 2. 使用者的環境

- 酒館跑在使用者自己的 **Android 手機（Termux）** 上，路徑 `~/SillyTavern`，手機用 Chrome 開。電腦是連手機熱點登入。（之前在 Zeabur，已經搬走。）
- 主要在**手機**上操作，所以畫面一定要在手機寬度下正常顯示。
- LLM 用 OpenRouter。整理人物檔預設走「獨立 API」（OpenAI 相容端點），不吃主聊天的額度。
- 安裝位置：用 `find ~/SillyTavern -type d -name char-archive` 找到現有的擴充資料夾，把三個檔案蓋過去即可。更新後要把酒館分頁完全關掉再開，確認標題旁的版本號。

## 3. 資料存放

### 每個聊天各一份：`chatMetadata.char_archive`

```js
{
  v: 3,
  characters: { [id]: Character },
  links: [Link],        // 關係：from 對 to 是什麼關係（友善、陌生、故人之子…），有方向
  views: [View],        // 看法：from 心裡對 to 的評價，有方向
  lastFloor: number,    // 已整理到第幾樓（樓層＝chat 陣列索引，使用者和 AI 訊息各算一樓）
  log: [{ floor, fp, snapId, pending?, swipe? }],  // 每次寫入的紀錄，用來偵測回覆被換掉
  snapshots: [{ id, ts, reason, data }],  // 上一步用的備份，預設最多 30 份
  redo: [...],          // 下一步用
  pending: null | { floor, sendDate, swipes: { [swipeId]: Entry } },  // 待確認
  conflict: null | { floor, snapId },     // 已寫入的回覆被換掉，等使用者決定退回或保留
  paused: null | { from, ts },            // 這個聊天暫停整理
  injectOff: boolean,                     // 這個聊天不送資料給 AI
}
```

- **Character**：`id, name, aliases[], age, identity, appearance, appearanceNow, status, notes, firstFloor, timeline[{id,time,floor,text}], locks{欄位:true}, isUser?, notUser?`
  - `appearance`＝長期外貌；`appearanceNow`＝暫時狀態（頭髮濕了、受傷），結束時清空。
  - `locks`：使用者手改過的欄位會自動上鎖，AI 不會覆蓋。
  - `isUser`：手動指定的主角；`notUser`：使用者取消過主角，不要再自動認。
- **Link**：`id, from, to, label, floor, history[], locked, manual?`
- **View**：`id, from, to, desc, floor, history[], locked, manual?`
- **pending Entry**：`{ hash, status: 'computing'|'ready'|'error', ops[], start, end, error? }`，`hash` 是整理當時回覆內容的雜湊，用來判斷「內容改過了」。

舊版資料由 `migrate()` 自動轉換（v0.4 以前的 `relations` → `views`；v0.5 不分方向的 `a/b` 關係 → 兩條有方向的）。改資料結構時請一併更新 `migrate()`。

### 全域設定：`extensionSettings.charArchive`

見 `index.js` 開頭的 `DEFAULTS`。重點：`mode`（every / interval / off）、`interval`、`keepRecent`（自動整理時留最近幾則 AI 回覆不整理，0＝不保留）、`apiMode`（custom / main）、`baseUrl`、`apiKey`、`model`、`maxMessages`（每次最多讀幾樓，20）、`maxTokens`（4000）、送給 AI 的欄位 `injFields`、`alwaysLinks`（每輪固定送所有關係，預設開）、`readHidden`、`readEngineViews`、`readSources`、`backfillBatch`。

## 4. 主要流程

### 4.1 整理（AI 抽取）
1. `analyze(base, msgs, start, end)`：在人物檔的**複本**上跑，不動真正資料。
   - `callLLM(buildSystemPrompt(), buildUserPrompt(...))` → `parseJSON` → `mergeUpdate(work, data)`。
   - 有新人物且 `readSources` 開啟時，再用 `prepareBlocks` + `askEnrich` 讀角色卡和世界書補資料。
   - 回覆裡有隱藏引擎的 `VIEWS｜A→B：看法（起因）` 區塊時（`parseEngineViews`），看法**只採用**這個區塊，不讓 AI 另外判斷；寫「無」代表沒有變化。
   - 最後 `diffOps(base, work)` 產生變動清單 `ops`。
2. `applyOps(s, ops)`：真正寫入。每一步都會重新檢查鎖、手動資料、主角規則。

### 4.2 待確認（最新那則 AI 回覆）
- `onMessageReceived` → 依更新頻率呼叫 `computePending(L)`，結果放進 `pending.swipes[swipeId]`。**每個 swipe 各一份**，滑回舊的不會重新呼叫 API。
- `onMessageSent`（使用者送出下一則）→ `commitPending()` 寫入目前顯示的那個 swipe 的變動，並在這一輪送給 AI。還在整理中的話會等它完成。
- 使用者刪掉自己的訊息、讓已寫入的回覆重新變成最新一則時，`verify()` 會把它退回成待確認。
- 回覆編輯過：結果保留，只在標籤和待確認頁提示「內容改過了，可以重新整理」，要不要重整由使用者決定。
- 待確認頁（`renderPending` / `renderOpRows`）每一項都能改內容、改對象（`setOpTarget`）、合併到既有人物（`mergeInto`）、或「不要這項」。
- 最新回覆下方有小標籤 `.ca-chip`（`renderChip`）。

### 4.2.1 留最近幾則回覆不整理（`keepRecent` > 0，v0.7.9）
- 使用者常回頭改最近的對話，最新那則一直重新生成就一直重整理、浪費 API。設了 `keepRecent` 之後，自動整理**不走待確認**，最近 N 則 AI 回覆（連同它們之間的使用者訊息）先不碰。
- `onMessageReceived` → `settledEnd(chat, keep)` 找出被保留的那幾則前面的那則 AI 回覆 → 距離 `lastFloor` 達到更新頻率就 `autoSettle(end)`：讀 `lastFloor+1 ～ end`，算完直接 `commitOps` 寫入（有備份，可上一步）。
- 被保留的回覆 swipe／編輯都不會呼叫 API。代價是送給主聊天 AI 的人物檔會晚 N 則。
- 「立即更新」、小標籤點開、暫停後補整理仍照原本流程（會整理到最新一則、最新一則走待確認）。

### 4.3 其他
- `requestUpdate()`：「立即更新」。最後一則是 AI 回覆就算成待確認，否則直接寫入。
- `backfill()`：舊聊天從頭整理，分批（預設 30 樓一批），可停止，最新一則留給待確認。
- `verify()`：檢查聊天和人物檔是否對得上。**不會自動回溯**：已寫入的回覆被換掉時只設 `conflict`，由使用者在橫幅上選「退回那次更新」或「保留」。前面樓層被刪只是換位置，會自動對齊。
- `refreshInjection()`：用 `setExtensionPrompt` 送資料。最近 `injectScan` 樓提到的人送勾選欄位；`alwaysLinks` 開著時每輪送全部關係，並註明「沒列出的兩人彼此陌生」。
- `enrichOne()` / `applyEnrich()`：人物頁「從角色卡和世界書補資料」，**先預覽再套用**。
- 匯入／匯出（設定分頁）：合併或取代，主角標記不帶過去。
- 上一步／下一步、紀錄分頁可退回任一版本。

## 5. 使用者定下的規則（改功能時不要違反）

**主角（使用者扮演的角色）**
- AI 只記錄主角的客觀事實（年齡、身分、外貌、處境、經歷），**不替主角寫內心想法、性格判斷、備註**。
- **看法**：AI 不寫主角對別人的看法；只記錄別人對主角的看法。手動新增看法時，「誰」不能選主角。
- **關係**：AI 不寫主角對別人的關係；**使用者可以手動新增**主角對別人的關係（`manual: true`，會保留）。
- 主角辨認：手動「設為主角」優先；沒指定時用 Persona 名字比對，「喃」對「喃·波特」這種部分名字也算。`purgeMyViews()` 負責清掉不該有的資料。

**關係 vs 看法**
- 關係＝兩人之間是什麼關係，用簡短的詞；**有方向**，雙方可以不同（A 對 B 友善、B 對 A 冷淡；A 覺得 B 陌生、B 知道 A 是故人之子）。
- **兩邊都陌生就不記錄**，沒記錄的一律視為陌生（`strangerLinks`）。只有一邊陌生時兩個方向都要記。手動或鎖住的不過濾。
- 看法＝**內心評價**，用「覺得、認為、欣賞、提防…」開頭，30 字內，括號附起因。**不能寫動作、表情、目前在做什麼、事件**（規則在 `VIEW_RULE`）。
- **不要好感度或任何數值**。

**欄位更新**
- 身分、外貌、備註是長期資料：要以原文為準做**部分修改**，不能只寫新劇情看到的一小段把原本內容丟掉。
- 長期外貌變化（長高、輪廓變銳利）改 `appearance` 並記一筆經歷；暫時狀態放 `appearanceNow`。
- 欄位沒有字數限制。給 AI 看的摘要如果要截短，用 `〔略〕`（`clipP`），**不要用「…」**，AI 會照抄。`repairClip()` 會嘗試用原文補回。

**其他**
- 每個聊天的資料分開存；可以暫停單一聊天的整理（`togglePause`，恢復時可選擇補整理或跳過），也可以只關掉單一聊天的送出（`injectOff`）。
- 一切寫入前都要留備份，能上一步、下一步。

## 6. 踩過的坑

- **手機面板高度 0**：酒館或主題可能讓外層高度變 0。`#ca-root` 改用 `100vw/100vh/100dvh`，`fitToScreen()` 在被壓扁時把面板移到 `<html>` 底下。不要改回 `inset: 0` 或 `height: 100%`。
- **不要用 `<header>/<nav>/<main>/<section>`**：主題 CSS 可能影響，一律用 `div`。
- **訊息指紋 `fp()`**：`gen_finished` 剛生成是 Date 物件、重新載入後是字串，一律用 `tnorm()` 換成秒再比，否則會誤判回覆變了而回溯。
- **CHAT_CHANGED 時聊天還沒載入**：事件先到、訊息後到。`verify()` 在聊天為空時直接 return，`waitChatReady()` 會等訊息載入；否則會清掉待確認、把 lastFloor 退回 0。
- 整理到一半切走聊天：結果暫存在記憶體 `resultCache`，回來時 `restorePending()` 接上；接不回來就標成 error，不要卡在 computing。
- 酒館的「隱藏」樓層是 `is_system: true` 的一般訊息，要讀；真正的系統訊息和 `/comment` 有 `extra.type`，不讀（`isReadable`）。
- 使用者用手機把檔案拖進主機時檔名可能變成數字，提供 `.tar.gz` 給她用指令解壓比較穩。

## 7. 測試方式

`tests/mock-run.js` 用假的 `SillyTavern.getContext()` 和假的 LLM 回應跑一次「收到回覆 → 待確認 → 送出寫入」：

```bash
node --check index.js
node tests/mock-run.js
node tests/keep-recent.js
```

要測新情境，照同樣方式改 `chat` 陣列和 `generateRaw` 的回傳內容即可。畫面可用 Playwright 開一個載入 `style.css` 和 `index.js` 的測試頁，以 390×844 的手機尺寸截圖檢查。

## 8. 還沒做 / 討論過的方向

- **關係圖**：使用者一開始就想要。資料已經是有方向的 `links`，只差畫圖（點＝人物、箭頭＝關係，點箭頭看內容）。使用者說過**不需要依類型分顏色**。
- **從柏寶書匯入**：還不知道柏寶書把摘要存在哪裡，需要使用者提供柏寶書的程式檔或在主控台查 `chatMetadata` / `extensionSettings` 的 key。（柏寶庫目前停用中。）
- **「整理時一律送完整人物檔」開關**：提議過，使用者說先不用，之後視情況再加。
- **一鍵重整舊看法**：提議過，使用者選擇讓舊看法隨對話慢慢被新的取代。
- 目前看法來源依賴卡片的隱藏引擎 `VIEWS`。使用者之後的卡**不再寫隱藏引擎**，改由她另外規劃的「故事導航」擴充處理劇情追蹤。之後可能要考慮兩個擴充怎麼分工或互相讀資料。
