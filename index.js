/* 人物檔案館 v0.7.10 — SillyTavern 前端擴充
 * 追蹤出場人物、年齡與經歷變化、人際關係。資料存在每個聊天自己的 chat metadata。
 */
(() => {
    'use strict';

    const EXT = 'charArchive';          // extension settings 的 key
    const META = 'char_archive';        // chat metadata 的 key
    const PROMPT_KEY = 'char_archive_inject';
    const LOG = '[人物檔案館]';

    const DEFAULTS = {
        mode: 'interval',      // every | interval | off
        interval: 3,
        keepRecent: 0,         // 自動整理時保留最近幾則 AI 回覆不整理（0＝不保留，最新一則走待確認）
        apiMode: 'custom',     // custom | main
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        model: '',
        maxMessages: 20,
        maxTokens: 4000,
        inject: true,
        injectDepth: 4,
        injectScan: 3,
        injectMax: 8,
        // 對話中提到的人物，要送出哪些資料
        injFields: { aliases: true, age: true, identity: true, appearance: true, status: true, notes: true, timeline: true, links: true, views: true },
        // 不管有沒有提到，每輪固定送出
        alwaysLinks: true,
        alwaysViews: false,
        alwaysRoster: false,
        maxSnapshots: 30,
        readHidden: true,
        readEngineViews: true,
        backfillBatch: 30,
        readSources: true,
        refMaxEntries: 5,
        refMaxChars: 4000,
    };

    const FIELDS = [
        ['age', '年齡'],
        ['identity', '身分'],
        ['appearance', '外貌'],
        ['appearanceNow', '外貌現況'],
        ['status', '目前狀態'],
        ['notes', '備註'],
    ];

    let busy = false;
    let progress = null; // 從頭整理時的進度 { done, total, stop }
    let root = null;
    const view = { tab: 'people', charId: null, relMode: 'links' };

    const ctx = () => SillyTavern.getContext();

    /* ---------------- 小工具 ---------------- */
    const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const norm = (s) => String(s ?? '').trim().toLowerCase();
    const clip = (s, n) => {
        const t = String(s ?? '').replace(/\s+/g, ' ').trim();
        return t.length > n ? t.slice(0, n) + '…' : t;
    };
    // 給 AI 看的摘要用〔略〕當截斷記號，避免 AI 把「…」當成原文抄回來
    const CUT = '〔略〕';
    const clipP = (s, n) => {
        const t = String(s ?? '').replace(/\s+/g, ' ').trim();
        return t.length > n ? t.slice(0, n) + CUT : t;
    };
    // AI 抄了截斷的摘要時，盡量用原文補回來；沒辦法補的就把截斷記號拿掉
    function repairClip(val, old) {
        let v = String(val ?? '');
        const o = String(old ?? '');
        for (const mark of [CUT, '…']) {
            let i = v.indexOf(mark);
            while (i >= 0) {
                const prefix = v.slice(0, i);
                const tailStart = Math.max(0, prefix.lastIndexOf('；') + 1, prefix.lastIndexOf('。') + 1);
                const piece = prefix.slice(tailStart);
                const at = piece.length >= 4 ? o.indexOf(piece) : -1;
                if (at >= 0 && !o.slice(at, at + piece.length + 1).endsWith(mark)) {
                    // 原文裡這段後面還有內容：接回原文直到下一個分隔
                    const rest = o.slice(at + piece.length);
                    const stop = rest.search(/[；。]/);
                    const fill = stop >= 0 ? rest.slice(0, stop) : rest;
                    v = v.slice(0, i) + fill + v.slice(i + mark.length);
                } else if (mark === CUT) {
                    v = v.slice(0, i) + v.slice(i + mark.length);
                } else break;
                i = v.indexOf(mark, i + 1);
            }
        }
        return v;
    }
    const hasCut = (v) => /…|〔略〕/.test(String(v ?? ''));
    const toast = (msg, type = 'success') => {
        try { toastr[type](msg, '人物檔案館'); } catch { console.log(LOG, msg); }
    };
    // 訊息指紋：重新生成、滑動換回覆都會改變；編輯文字不會
    // 生成時間剛生成時是 Date 物件、重新載入後是文字，一律換成「秒」再比，避免誤判回覆變了
    const tnorm = (v) => {
        if (v === null || v === undefined || v === '') return '';
        const t = new Date(v).getTime();
        return Number.isFinite(t) ? String(Math.floor(t / 1000)) : String(v);
    };
    const genTime = (m) => m?.gen_finished ?? m?.gen_started;
    const fp = (m) => (m ? `${tnorm(m.send_date)}|${tnorm(genTime(m))}|${m.swipe_id ?? 0}` : '');
    const fpLegacy = (m) => (m ? `${m.send_date ?? ''}|${m.swipe_id ?? 0}` : ''); // v0.1～0.2 的格式
    function fpMatch(m, f) {
        if (!m || !f) return false;
        if (f === fp(m) || f === fpLegacy(m)) return true;
        // v0.3～0.6 存的是原始時間文字
        const i2 = f.lastIndexOf('|');
        const rest = f.slice(0, i2);
        const i1 = rest.lastIndexOf('|');
        if (i1 < 0) return false;
        return tnorm(rest.slice(0, i1)) === tnorm(m.send_date) && f.slice(i2 + 1) === String(m.swipe_id ?? 0)
            && tnorm(rest.slice(i1 + 1)) === tnorm(genTime(m));
    }
    const isAiMsg = (m) => !!m && !m.is_user && !m.is_system && typeof m.mes === 'string';
    const swipeKey = (m) => String(m?.swipe_id ?? 0);
    // 記下整理時的回覆內容；之後編輯或續寫過，結果仍保留，只提示「內容改過了」
    const hashStr = (str) => {
        let h = 2166136261;
        const t = String(str ?? '');
        for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(36);
    };
    const entryFor = (p, m) => (m ? p?.swipes?.[swipeKey(m)] || null : null);
    const isEdited = (e, m) => !!(e && m && e.hash && e.hash !== hashStr(m.mes));
    // 沒隱藏的一般訊息（送進提示詞時用）
    const isStory = (m) => !!m && !m.is_system && typeof m.mes === 'string';
    // 整理人物檔時讀得到的訊息：已隱藏的樓層也算，但系統訊息、註解不算
    const isReadable = (m) => {
        if (!m || typeof m.mes !== 'string') return false;
        if (!m.is_system) return true;
        if (m.extra?.type) return false;
        return !!settings().readHidden;
    };
    const fmtMsg = (m, i) => `[第${i}樓${m.is_system ? '・已隱藏' : ''}] ${m.name}：${cleanText(m.mes)}`;
    const cleanText = (t) => String(t ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const chatId = () => {
        const c = ctx();
        return (typeof c.getCurrentChatId === 'function' ? c.getCurrentChatId() : c.chatId) || null;
    };
    const hasChat = () => !!chatId();
    const userName = () => ctx().name1 || '使用者';
    const lastFloorNow = () => (ctx().chat?.length ?? 0) - 1;

    /* ---------------- 設定 ---------------- */
    function settings() {
        const es = ctx().extensionSettings;
        if (!es[EXT]) es[EXT] = {};
        for (const k of Object.keys(DEFAULTS)) {
            if (es[EXT][k] === undefined) es[EXT][k] = DEFAULTS[k];
        }
        // 舊版預設的回覆長度上限是 2000，容易在人物多時被截斷，調成新預設一次
        if (!es[EXT].tokensBumped) {
            if (Number(es[EXT].maxTokens) === 2000) es[EXT].maxTokens = DEFAULTS.maxTokens;
            es[EXT].tokensBumped = true;
        }
        return es[EXT];
    }
    const saveSettings = () => ctx().saveSettingsDebounced();

    /* ---------------- 每個聊天的資料 ---------------- */
    // links＝A 對 B 的關係（友善、陌生、故人之子…）；views＝A 心裡怎麼看 B。兩種都有方向
    // pending＝最新回覆整理出來、還沒寫入的變動（每個 swipe 各一份）；conflict＝已寫入的回覆被換掉時，等使用者決定
    const emptyStore = () => ({ v: 3, characters: {}, links: [], views: [], lastFloor: -1, log: [], snapshots: [], redo: [], pending: null, conflict: null, paused: null, injectOff: false });
    // v0.4 以前的 relations 其實都是「看法」，搬到 views
    function migrate(o) {
        if (!o) return o;
        if (Array.isArray(o.relations)) {
            o.views = [...(Array.isArray(o.views) ? o.views : []), ...o.relations];
            delete o.relations;
        }
        if (!Array.isArray(o.views)) o.views = [];
        if (!Array.isArray(o.links)) o.links = [];
        // 防呆：資料欄位缺了或型別不對時補回來，避免畫面整個打不開
        if (!o.characters || typeof o.characters !== 'object') o.characters = {};
        for (const [id, c] of Object.entries(o.characters)) {
            if (!c || typeof c !== 'object') { delete o.characters[id]; continue; }
            c.id = c.id || id;
            c.name = String(c.name ?? '（未命名）');
            c.aliases = Array.isArray(c.aliases) ? c.aliases.map(String) : (c.aliases ? [String(c.aliases)] : []);
            for (const k of ['age', 'identity', 'appearance', 'appearanceNow', 'status', 'notes']) c[k] = c[k] == null ? '' : String(c[k]);
            c.timeline = Array.isArray(c.timeline) ? c.timeline.filter((t) => t && typeof t === 'object') : [];
            c.locks = c.locks && typeof c.locks === 'object' ? c.locks : {};
        }
        o.views = o.views.filter((r) => r && typeof r === 'object');
        o.links = o.links.filter((r) => r && typeof r === 'object');
        [...o.views, ...o.links].forEach((r) => { if (!Array.isArray(r.history)) r.history = []; });
        // v0.5 的關係不分方向（a、b），拆成兩條有方向的
        if (o.links.some((l) => l.a !== undefined)) {
            const out = [];
            for (const l of o.links) {
                if (l.a === undefined) { out.push(l); continue; }
                const base = { label: l.label, floor: l.floor, locked: l.locked, manual: l.manual };
                out.push({ ...base, id: uid(), from: l.a, to: l.b, history: [...(l.history || [])] });
                out.push({ ...base, id: uid(), from: l.b, to: l.a, history: [...(l.history || [])] });
            }
            o.links = out;
        }
        return o;
    }

    function store() {
        if (!hasChat()) return null;
        const md = ctx().chatMetadata;
        if (!md) return null;
        if (!md[META]) md[META] = emptyStore();
        const s = migrate(md[META]);
        const base = emptyStore();
        for (const k of Object.keys(base)) if (s[k] === undefined) s[k] = base[k];
        s.v = 3;
        return s;
    }
    async function persist() {
        try { await ctx().saveMetadata(); } catch (e) { console.error(LOG, e); toast('存檔失敗，請看瀏覽器主控台', 'error'); }
    }

    /* ---------------- 快照（回上一步） ---------------- */
    const cloneState = (s) => JSON.parse(JSON.stringify({
        characters: s.characters, links: s.links, views: s.views, lastFloor: s.lastFloor, log: s.log,
    }));
    function applyState(s, data) {
        migrate(data);
        s.characters = data.characters;
        s.links = data.links;
        s.views = data.views;
        s.lastFloor = data.lastFloor;
        s.log = data.log;
        purgeMyViews(s);
    }
    function snapshot(reason) {
        const s = store();
        const snap = { id: uid(), ts: Date.now(), reason, data: cloneState(s) };
        s.snapshots.push(snap);
        const max = Math.max(1, Number(settings().maxSnapshots) || 30);
        if (s.snapshots.length > max) s.snapshots.splice(0, s.snapshots.length - max);
        s.redo = [];
        return snap.id;
    }
    async function undo() {
        const s = store();
        if (!s) return;
        const snap = s.snapshots.pop();
        if (!snap) { toast('沒有可以退回的紀錄了', 'info'); return; }
        s.redo.push({ id: uid(), ts: Date.now(), reason: snap.reason, data: cloneState(s) });
        applyState(s, snap.data);
        s.conflict = null;
        await persist();
        refreshInjection();
        render();
        renderChip();
        toast(`已退回：${snap.reason}`);
    }
    async function redo() {
        const s = store();
        if (!s) return;
        const r = s.redo.pop();
        if (!r) { toast('沒有可以恢復的步驟了', 'info'); return; }
        s.snapshots.push({ id: uid(), ts: Date.now(), reason: r.reason, data: cloneState(s) });
        applyState(s, r.data);
        await persist();
        await verify();
        refreshInjection();
        render();
        renderChip();
        toast(`已恢復：${r.reason}`);
    }
    async function restoreTo(id) {
        const s = store();
        const snap = s?.snapshots.find((x) => x.id === id);
        if (!snap) return;
        const data = JSON.parse(JSON.stringify(snap.data));
        snapshot('還原紀錄之前的狀態');
        applyState(s, data);
        await persist();
        await verify();
        refreshInjection();
        render();
        toast(`已退回到「${snap.reason}」之前`);
    }

    /* ---------------- 人物資料 ---------------- */
    const newChar = (name, floor) => ({
        id: uid(), name: String(name).trim(), aliases: [],
        age: '', identity: '', appearance: '', appearanceNow: '', status: '', notes: '',
        firstFloor: floor, timeline: [], locks: {},
    });
    function findChar(s, name) {
        const n = norm(name);
        if (!n) return null;
        for (const c of Object.values(s.characters)) {
            if (norm(c.name) === n || (c.aliases || []).some((a) => norm(a) === n)) return c;
        }
        return null;
    }
    // 名字對不太上時（例如「德拉科」和「德拉科·馬爾福」），只要能唯一對到一個人，就當作同一人
    const NAME_SPLIT = /[·・•．.\s　]+/;
    function findCharLoose(s, name) {
        const exact = findChar(s, name);
        if (exact) return exact;
        const n = norm(name);
        if (n.length < 2) return null;
        const nParts = n.split(NAME_SPLIT).filter((x) => x.length >= 2);
        const hits = Object.values(s.characters).filter((c) => [c.name, ...(c.aliases || [])].some((full) => {
            const f = norm(full);
            const parts = f.split(NAME_SPLIT).filter(Boolean);
            if (parts.length > 1 && parts.includes(n)) return true; // 簡稱 → 全名
            return nParts.length > 1 && nParts.includes(f); // 全名 → 簡稱
        }));
        return hits.length === 1 ? hits[0] : null;
    }
    // 用別的寫法找到人時，把這個寫法記成別名，下次就對得上
    function noteAlias(c, name) {
        const t = String(name ?? '').trim();
        if (!c || !t || c.locks?.aliases) return;
        if (norm(t) === norm(c.name) || c.aliases.some((a) => norm(a) === norm(t))) return;
        c.aliases.push(t);
    }
    function ensureChar(s, name, floor) {
        let c = findCharLoose(s, name);
        if (c) noteAlias(c, name);
        else { c = newChar(name, floor); s.characters[c.id] = c; }
        return c;
    }
    const charName = (s, id) => s.characters[id]?.name || '（已刪除）';

    // 主角（使用者扮演的角色）
    // 名字對得上使用者 Persona（含「名·姓」這種只對到一部分的情況）
    function nameIsUser(c) {
        const u = norm(userName());
        if (!u) return false;
        const uParts = u.split(NAME_SPLIT).filter(Boolean);
        return [c.name, ...(c.aliases || [])].some((full) => {
            const f = norm(full);
            if (!f) return false;
            if (f === u) return true;
            const parts = f.split(NAME_SPLIT).filter(Boolean);
            if (parts.length > 1 && parts.includes(u)) return true;
            return uParts.length > 1 && uParts.includes(f);
        });
    }
    // 手動指定過主角時，只認那個人；沒指定時才用名字自動判斷
    function isMe(c) {
        if (!c) return false;
        if (c.isUser) return true;
        if (c.notUser) return false;
        const s = hasChat() ? store() : null;
        if (s && Object.values(s.characters).some((x) => x.isUser)) return false;
        return nameIsUser(c);
    }
    function meChar(s) {
        const c = Object.values(s.characters).find(isMe) || null;
        if (c) c.isUser = true;
        return c;
    }
    // 主角：AI 不寫主角對別人的關係和看法；主角對別人的關係可以手動寫
    const badMine = (me) => (r) => r.from === me.id && (r.desc !== undefined || !r.manual);
    // 陌生的關係不記錄：兩個方向都陌生（或沒寫）就整對拿掉，沒寫的一律當作陌生
    const STRANGER_RE = /^(陌生|陌生人|不認識|互不認識|素不相識|互不相識|未曾謀面|無|無關係|沒有關係|沒關係)$/;
    const isStranger = (label) => STRANGER_RE.test(String(label ?? '').replace(/[\s。．.！!、，,（）()]/g, ''));
    const keepAnyway = (l) => l && (l.manual || l.locked);
    function strangerLinks(s) {
        const drop = new Set();
        for (const l of s.links) {
            if (!isStranger(l.label) || keepAnyway(l)) continue;
            const back = s.links.find((x) => x.from === l.to && x.to === l.from);
            if (!back || isStranger(back.label)) drop.add(l.id);
        }
        return drop;
    }
    function purgeMyViews(s) {
        const me = meChar(s);
        const before = s.views.length + s.links.length;
        if (me) {
            const bad = badMine(me);
            s.views = s.views.filter((r) => !bad(r));
            s.links = s.links.filter((l) => !bad(l));
        }
        const drop = strangerLinks(s);
        if (drop.size) s.links = s.links.filter((l) => !drop.has(l.id));
        return before - s.views.length - s.links.length;
    }
    async function cleanMyViews() {
        if (!hasChat()) return;
        const s = store();
        const me = meChar(s);
        const mine = me ? [...s.views, ...s.links].some(badMine(me)) : false;
        if (!mine && !strangerLinks(s).size) return;
        snapshot('整理：移除 AI 寫的主角關係、看法和陌生關係');
        purgeMyViews(s);
        await persist();
    }

    /* ---------------- 給 AI 的提示詞 ---------------- */
    // 告訴 AI 主角在人物檔裡叫什麼，避免它另外建一個同一人
    function meHint() {
        const s = hasChat() ? store() : null;
        const me = s ? meChar(s) : null;
        const u = userName();
        if (!me) return `「${u}」`;
        const names = [...new Set([me.name, ...me.aliases, u].filter(Boolean))];
        return `「${me.name}」（也可能被叫作：${names.filter((n) => n !== me.name).join('、') || '無'}；輸出時一律用「${me.name}」這個名字，不要另外建立新人物）`;
    }
    const VIEW_RULE = `views 是「看法」：from 心裡對 to 這個人的評價或感受，有方向性。
   - 要寫的是內心評價，用「覺得、認為、欣賞、佩服、提防、嫌棄、在意、心疼、看不起」這類詞開頭，30 字內，括號附上起因。例如「覺得她冒失但心地好（她幫忙找回蟾蜍）」「認為他靠不住（他當眾說謊）」。
   - 不要寫動作、表情、目前在做什麼、兩人之間發生的事。錯誤例子：「在長桌後翻看課表，視線不時越過新生」（這是動作）；「送她薄荷糖」（這是事件，應該寫進 timeline）。
   - 只有評價真的改變時才寫；劇情沒有透露內心想法，就不要硬寫。`;
    function buildSystemPrompt(engineViews = false) {
        const viewRule = engineViews
            ? 'views 不用輸出（填空陣列）：這段劇情的看法變化已經由回覆裡的 VIEWS 區塊提供。'
            : VIEW_RULE;
        return `你是長篇角色扮演故事的「人物檔案管理員」。你會拿到目前的人物檔案摘要，以及一段新的劇情。請找出新出現的人物，以及資料有變化的人物與關係。

規則：
1. 只根據劇情裡寫到的內容，不要編造或推測沒寫到的設定。
2. 只列出「新出現」或「資料有變化」的人物與關係，沒有變化的不要列。
3. 欄位沒有新資訊就填空字串 ""，系統會保留舊資料。
   identity、appearance、notes 是長期資料：只有真的有長期改變時才輸出，而且要輸出「修改後的完整版本」——以【目前的人物檔案】裡的原文為準，保留原本所有描述，只改有變化的地方或補上新資訊。絕對不要只寫新劇情看到的一小部分，把原本的內容丟掉。
   appearance 只寫長期外貌（髮色髮型、五官、身形、慣常穿著）。長期變化（長高了、輪廓隨年紀變銳利、剪短頭髮）就在原文上做部分修改，並在 timeline 記一筆。
   appearanceNow 寫暫時的外貌狀態（頭髮濕了、臉上有擦傷、換上禮服、眼睛哭腫），也就是很快會恢復的樣子；狀態結束時填「無」。暫時狀態不要寫進 appearance。
4. age 寫劇情中明確提到或能確定的年齡（例如「十六歲」「三十出頭」），不確定就留空。
5. timeline 只記重要經歷或轉變（例如受傷、升職、成年、搬家、結盟、決裂），每筆一句話；劇情有提到時間就填在 time。
6. relations 是 from 對 to 的「關係」，用簡短的詞描述（例如：友善、冷淡、朋友、敵人、陌生、師徒、主僕、故人之子）。關係有方向，雙方可能不一樣（例如 A 對 B 友善、B 對 A 冷淡；A 覺得 B 陌生、B 卻知道 A 是故人之子），兩個方向要分開各寫一筆。只寫彼此認識或有牽連的；兩人互不認識就不要寫，沒寫的一律視為陌生。如果只有一方認識另一方（例如 A 知道 B 是故人之子，B 卻不認識 A），兩個方向都要寫，不認識的那方寫「陌生」。
7. ${viewRule}
8. 不要用數字、分數或好感度。status 寫目前的處境或狀態（例如受傷、被禁足、剛入學、正在旅行），不要寫一時的動作。
9. 主角${meHint()}是使用者扮演的角色，也要追蹤，但只記錄客觀事實（年齡、身分、外貌、處境、經歷）。不要替主角寫內心想法、感受或性格判斷；relations 和 views 的 from 都不可以是主角，只記錄別人對主角的關係和看法。
10. name 用劇情中的本名；別稱、小名、職稱、稱號放 aliases。
11. 新出現的人物，first_floor 填他第一次出場的樓層數字。
12. 一律使用繁體中文。
13. 只輸出 JSON，不要任何說明文字或 markdown。
14. 人物檔案裡的「〔略〕」表示摘要被截短，不是原文的一部分，絕對不要抄進輸出；也不要在輸出裡用「…」省略內容。

輸出格式：
{"characters":[{"name":"本名","aliases":["別名"],"first_floor":0,"age":"","identity":"","appearance":"","appearanceNow":"","status":"","notes":"","story_time":"","timeline":[{"time":"","event":""}]}],"relations":[{"from":"","to":"","label":""}],"views":[{"from":"","to":"","desc":""}]}`;
    }
    function summarize(s, focusText) {
        const chars = Object.values(s.characters);
        if (!chars.length) return '（目前還沒有人物檔）';
        const ft = String(focusText ?? '').toLowerCase();
        const inText = (c) => ft && [c.name, ...(c.aliases || [])].some((n) => norm(n).length >= 1 && ft.includes(norm(n)));
        return chars.map((c) => {
            if (inText(c)) {
                // 這段有出場的人：給完整原文，修改時才有依據
                const lines = [`- ${c.name}${c.aliases.length ? `（別名：${c.aliases.join('、')}）` : ''}【本段有出場，以下是完整原文】`];
                for (const [k, l] of FIELDS) if (c[k]) lines.push(`  ${l}：${c[k]}`);
                const tl = c.timeline.slice(-3).map((t) => (t.time ? `${t.time} ${t.text}` : t.text));
                if (tl.length) lines.push(`  最近經歷：${tl.join('；')}`);
                return lines.join('\n');
            }
            const alias = c.aliases.length ? `（別名：${c.aliases.join('、')}）` : '';
            return `- ${c.name}${alias}｜年齡：${clipP(c.age, 20) || '不明'}｜身分：${clipP(c.identity, 40) || '不明'}｜外貌：${clipP(c.appearance, 40) || '—'}｜現況：${clipP(c.status, 60) || '—'}`;
        }).join('\n');
    }
    function summarizeRels(s) {
        const links = s.links.length
            ? s.links.map((l) => `- ${charName(s, l.from)} → ${charName(s, l.to)}：${clipP(l.label, 30)}`).join('\n')
            : '（目前還沒有關係紀錄）';
        const views = s.views.length
            ? s.views.map((r) => `- ${charName(s, r.from)} → ${charName(s, r.to)}：${clipP(r.desc, 60)}`).join('\n')
            : '（目前還沒有看法紀錄）';
        return `${links}\n\n【目前的看法】\n${views}`;
    }
    const buildUserPrompt = (s, msgs, start, end) =>
        `【目前的人物檔案】（本段有出場的人物附完整原文；修改長期資料時，以原文為準做部分修改）\n${summarize(s, msgs.join('\n'))}\n\n【目前的關係】\n${summarizeRels(s)}\n\n【新的劇情（第 ${start}～${end} 樓）】\n${msgs.join('\n\n')}\n\n請依規則輸出 JSON。`;

    /* ---------------- 呼叫 AI ---------------- */
    async function callLLM(system, user) {
        const st = settings();
        if (st.apiMode === 'custom') {
            if (!st.baseUrl || !st.model) throw new Error('請先到「設定」分頁填好 API 網址和模型名稱');
            const res = await fetch(st.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(st.apiKey ? { Authorization: `Bearer ${st.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: st.model,
                    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
                    temperature: 0.3,
                    max_tokens: Number(st.maxTokens) || 2000,
                }),
            });
            if (!res.ok) {
                const t = await res.text().catch(() => '');
                throw new Error(`API 回傳 ${res.status}${t ? '：' + t.slice(0, 160) : ''}`);
            }
            const j = await res.json();
            const out = j?.choices?.[0]?.message?.content;
            if (j?.choices?.[0]?.finish_reason === 'length') throw new Error('AI 的回覆超過長度上限被截斷了，請到「設定」把「回覆長度上限」調高');
            if (!out) throw new Error('API 沒有回傳內容');
            return out;
        }
        const c = ctx();
        if (typeof c.generateRaw !== 'function') throw new Error('這個酒館版本找不到 generateRaw，請改用「獨立 API」');
        return await c.generateRaw({ systemPrompt: system, prompt: user, responseLength: Number(st.maxTokens) || 2000 });
    }
    function parseJSON(raw) {
        let t = String(raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
        const a = t.indexOf('{');
        const b = t.lastIndexOf('}');
        if (a < 0 || b < a) throw new Error('AI 回傳的不是 JSON，可以換個模型再試');
        t = t.slice(a, b + 1);
        try { return JSON.parse(t); } catch { throw new Error('AI 回傳的 JSON 格式有誤，可能是回覆被截斷了（可以到「設定」調高回覆長度上限），或再按一次更新'); }
    }

    /* ---------------- 合併 AI 的結果 ---------------- */
    function mergeUpdate(s, data, floor, opts = {}) {
        let n = 0;
        const created = [];
        const tlFloor = opts.timelineFloor !== undefined ? opts.timelineFloor : floor;
        const relFloor = floor ?? Math.max(0, lastFloorNow());
        const chars = Array.isArray(data?.characters) ? data.characters : [];
        for (const u of chars) {
            if (!u || !u.name) continue;
            const aliasesIn = Array.isArray(u.aliases) ? u.aliases : [];
            let c = findCharLoose(s, u.name) || aliasesIn.map((a) => findChar(s, a)).find(Boolean);
            if (c) noteAlias(c, u.name);
            if (opts.onlyIds && (!c || !opts.onlyIds.has(c.id))) continue;
            if (!c) {
                const ff = Number.isInteger(u.first_floor) && u.first_floor >= 0 && u.first_floor <= floor ? u.first_floor : floor;
                c = newChar(u.name, ff);
                s.characters[c.id] = c;
                created.push(c.id);
                n++;
            }
            const mine = isMe(c);
            if (mine) c.isUser = true;
            if (!c.locks.aliases) {
                for (const a of aliasesIn) {
                    const t = String(a ?? '').trim();
                    if (t && norm(t) !== norm(c.name) && !c.aliases.some((x) => norm(x) === norm(t))) { c.aliases.push(t); n++; }
                }
            }
            for (const [k] of FIELDS) {
                let v = typeof u[k] === 'string' ? repairClip(u[k].trim(), c[k]).trim() : '';
                if (k === 'appearanceNow' && /^(無|沒有|恢復|恢復正常|正常|none)[。.]?$/i.test(v)) {
                    if (c.appearanceNow && !c.locks[k]) { c.appearanceNow = ''; n++; }
                    continue;
                }
                if (!v || v === c[k] || c.locks[k]) continue;
                if (mine && k === 'notes') continue; // 主角的備註留給使用者自己寫
                if (k === 'age' && c.age) {
                    c.timeline.push({ id: uid(), time: String(u.story_time ?? '').trim(), floor: tlFloor, text: `年齡：${c.age} → ${v}` });
                }
                c[k] = v;
                n++;
            }
            for (const t of Array.isArray(u.timeline) ? u.timeline : []) {
                const text = String(t?.event ?? '').trim();
                if (!text || c.timeline.some((x) => x.text === text)) continue;
                c.timeline.push({ id: uid(), time: String(t?.time ?? '').trim(), floor: tlFloor, text });
                n++;
            }
        }
        const strict = opts.createFromRelations === false;
        const getChar = (name) => (strict ? findCharLoose(s, name) : ensureChar(s, name, floor));
        const allowed = (A, B) => !opts.onlyIds || opts.onlyIds.has(A.id) || opts.onlyIds.has(B.id);
        const viewsIn = Array.isArray(data?.views) ? [...data.views] : [];
        // 關係
        for (const r of Array.isArray(data?.relations) ? data.relations : []) {
            if (r?.desc && !r?.label) { viewsIn.push(r); continue; } // 模型用了舊格式，當作看法
            const label = String(r?.label ?? '').trim();
            const an = r?.from ?? r?.a;
            const bn = r?.to ?? r?.b;
            if (!an || !bn || !label) continue;
            const A = getChar(an);
            const B = getChar(bn);
            if (!A || !B || A.id === B.id || !allowed(A, B)) continue;
            if (isMe(A)) continue; // 主角對別人的關係不記錄
            const L = s.links.find((x) => x.from === A.id && x.to === B.id);
            if (!L) {
                s.links.push({ id: uid(), from: A.id, to: B.id, label, floor: relFloor, history: [], locked: false });
                n++;
            } else if (!L.locked && L.label !== label) {
                if (L.label) L.history.push({ floor: L.floor, label: L.label });
                L.label = label;
                L.floor = relFloor;
                n++;
            }
        }
        // 看法
        for (const r of viewsIn) {
            const desc = String(r?.desc ?? '').trim();
            if (!r?.from || !r?.to || !desc) continue;
            const A = getChar(r.from);
            const B = getChar(r.to);
            if (!A || !B || A.id === B.id || !allowed(A, B)) continue;
            if (isMe(A)) continue; // 不替主角決定他對別人的看法
            const v = s.views.find((x) => x.from === A.id && x.to === B.id);
            if (!v) {
                s.views.push({ id: uid(), from: A.id, to: B.id, desc, floor: relFloor, history: [], locked: false });
                n++;
            } else if (!v.locked && v.desc !== desc) {
                if (v.desc) v.history.push({ floor: v.floor, desc: v.desc });
                v.desc = desc;
                v.floor = relFloor;
                n++;
            }
        }
        const drop = strangerLinks(s);
        if (drop.size) { s.links = s.links.filter((l) => !drop.has(l.id)); n = Math.max(0, n - drop.size); }
        return { n, created };
    }

    /* ---------------- 讀取角色卡與世界書 ---------------- */
    let wiMod = null;
    async function wiModule() {
        if (wiMod) return wiMod;
        try {
            const base = location.origin + location.pathname.replace(/[^/]*$/, '');
            wiMod = await import(new URL('scripts/world-info.js', base).href);
        } catch (e) {
            console.warn(LOG, '讀不到 world-info 模組，只會讀角色卡和角色綁定的世界書', e);
            wiMod = {};
        }
        return wiMod;
    }

    // 目前聊天用到的角色卡（群聊時是所有成員）
    function activeCards() {
        const c = ctx();
        if (c.groupId) {
            const g = (c.groups || []).find((x) => x.id === c.groupId);
            return (g?.members || []).map((av) => (c.characters || []).find((ch) => ch.avatar === av)).filter(Boolean);
        }
        const ch = c.characters?.[c.characterId];
        return ch ? [ch] : [];
    }

    async function bookNames(cards) {
        const c = ctx();
        const wi = await wiModule();
        const names = new Set();
        for (const ch of cards) {
            const primary = ch?.data?.extensions?.world;
            if (primary) names.add(primary);
            const file = String(ch.avatar || '').replace(/\.[^.]+$/, '');
            const extra = wi.world_info?.charLore?.find((e) => e.name === file || e.name === ch.avatar)?.extraBooks || [];
            extra.forEach((n) => names.add(n));
        }
        const chatBook = c.chatMetadata?.world_info;
        if (chatBook) names.add(chatBook);
        (Array.isArray(wi.selected_world_info) ? wi.selected_world_info : []).forEach((n) => names.add(n));
        return [...names];
    }

    let refCache = { key: null, ts: 0, cards: [], books: [], entries: [] };
    async function loadSources(force = false) {
        const key = chatId();
        if (!force && refCache.key === key && Date.now() - refCache.ts < 60000) return refCache;
        const c = ctx();
        const wi = await wiModule();
        const load = typeof c.loadWorldInfo === 'function' ? c.loadWorldInfo : wi.loadWorldInfo;
        const cards = activeCards();
        const books = await bookNames(cards);
        const entries = [];
        const seen = new Set();
        const push = (book, e) => {
            if (!e || e.disable || e.enabled === false) return;
            const content = String(e.content ?? '').trim();
            if (!content || seen.has(content)) return;
            seen.add(content);
            const keys = [...(e.key || e.keys || []), ...(e.keysecondary || e.secondary_keys || [])]
                .map((k) => String(k).replace(/^\/|\/[a-z]*$/gi, '').trim()).filter(Boolean);
            entries.push({ book, comment: String(e.comment ?? e.name ?? '').trim(), keys, content });
        };
        const loaded = [];
        if (typeof load === 'function') {
            for (const name of books) {
                try {
                    const b = await load(name);
                    if (b?.entries) { Object.values(b.entries).forEach((e) => push(name, e)); loaded.push(name); }
                } catch (e) { console.warn(LOG, '讀不到世界書', name, e); }
            }
        }
        for (const ch of cards) {
            (ch?.data?.character_book?.entries || []).forEach((e) => push(`${ch.name} 的內嵌世界書`, e));
        }
        refCache = { key, ts: Date.now(), cards, books: loaded, entries };
        return refCache;
    }

    const HEADER_RE = /^\s*(【|\[|#|■|◆|●|★|☆|═|─|—{2,}|-{3,}|<\w)/;

    // 從一段長文字裡，找出提到這個人物的段落
    function snippetsFrom(text, names) {
        const out = [];
        const paras = String(text ?? '').split(/\n\s*\n/);
        for (const p of paras) {
            const lp = p.toLowerCase();
            if (!names.some((n) => lp.includes(n))) continue;
            if (p.length <= 1500) { out.push(p.trim()); continue; }
            const lines = p.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!names.some((n) => lines[i].toLowerCase().includes(n))) continue;
                let a = i;
                for (let k = i; k >= Math.max(0, i - 3); k--) { if (HEADER_RE.test(lines[k])) { a = k; break; } }
                let b = i + 1;
                while (b < lines.length && !HEADER_RE.test(lines[b]) && lines.slice(a, b + 1).join('\n').length < 1200) b++;
                out.push(lines.slice(a, b).join('\n').trim());
                i = b - 1;
            }
        }
        return out;
    }

    function findRefs(c, src) {
        const st = settings();
        const maxChars = Math.max(500, Number(st.refMaxChars) || 4000);
        const maxEntries = Math.max(1, Number(st.refMaxEntries) || 5);
        const names = [c.name, ...(c.aliases || [])].map(norm).filter((n, i) => n && (i === 0 || n.length >= 2));
        const refs = [];
        // 1. 角色卡本人
        for (const ch of src.cards) {
            if (names.includes(norm(ch.name))) {
                const t = [ch.description || ch.data?.description, ch.personality || ch.data?.personality].filter(Boolean).join('\n\n');
                if (t) refs.push({ label: `角色卡《${ch.name}》本人設定`, text: t });
            }
        }
        // 2. 使用者 Persona
        if (isMe(c)) {
            const p = ctx().powerUserSettings?.persona_description;
            if (p) refs.push({ label: '使用者 Persona 設定', text: p });
        }
        // 3. 世界書條目：關鍵字或標題對得上
        const scored = [];
        for (const e of src.entries) {
            let score = 0;
            for (const k of [...e.keys, e.comment].map(norm).filter((k) => k.length >= 2)) {
                for (const n of names) {
                    if (k === n) score = Math.max(score, 3);
                    else if (k.includes(n)) score = Math.max(score, 2);
                    else if (n.length >= 2 && n.includes(k)) score = Math.max(score, 1);
                }
            }
            if (score) scored.push({ score, e });
        }
        scored.sort((a, b) => b.score - a.score).slice(0, maxEntries).forEach(({ e }) => {
            refs.push({ label: `世界書《${e.book}》${e.comment ? '：' + e.comment : ''}`, text: e.content });
        });
        // 4. 角色卡（描述、個性、情境）裡提到他的段落
        for (const ch of src.cards) {
            if (names.includes(norm(ch.name))) continue;
            const t = [ch.description || ch.data?.description, ch.personality || ch.data?.personality, ch.scenario || ch.data?.scenario].filter(Boolean).join('\n\n');
            snippetsFrom(t, names).slice(0, 3).forEach((sn) => refs.push({ label: `角色卡《${ch.name}》`, text: sn }));
        }
        // 控制總字數
        let used = 0;
        const out = [];
        for (const r of refs) {
            if (used >= maxChars) break;
            const text = r.text.length > maxChars - used ? r.text.slice(0, maxChars - used) + '…' : r.text;
            out.push({ label: r.label, text });
            used += text.length;
        }
        return out;
    }

    function buildEnrichSystem() {
        return `你是長篇角色扮演故事的「人物檔案管理員」。以下有幾位人物，請根據「設定資料」（角色卡、世界書）和「最近劇情」補完他們的檔案。

規則：
1. 設定資料是背景，劇情是正在發生的事；兩者衝突時以劇情為準（例如劇情裡已經長大、換了身分或受傷）。
2. 只寫資料裡有的內容，不要自己編。
2.5 「目前檔案」已有的內容要保留：輸出的欄位要是「目前內容＋設定資料補充」整合後的完整版本，不要刪掉目前檔案裡的資訊；沒有新東西可補的欄位就留空。
3. age 寫劇情當下的年齡；只有設定裡寫了年齡、劇情沒提到時，就用設定的。
4. identity 寫身分、職位、所屬；appearance 寫外貌與穿著重點；status 寫目前在劇情中的狀況；notes 精簡寫性格核心、能力、說話方式等其他重要設定。
5. timeline 放設定中提到的重要過去經歷（每人最多 5 筆），time 寫時間點。
6. relations 只寫這些人物和下方「現有人物」之間的「關係」：from 對 to 是什麼關係，用簡短的詞（例如：友善、冷淡、朋友、敵人、陌生、師徒、故人之子），有方向，兩個方向要分開各寫一筆；互不認識就不要寫（沒寫的視為陌生），只有一方認識時，不認識的那方寫「陌生」。不要用數字、分數或好感度。
   ${VIEW_RULE}
7. 主角${meHint()}是使用者扮演的角色：只記錄客觀事實，不要寫他的內心想法、感受或性格判斷；relations 和 views 的 from 都不可以是主角。
8. 名字必須和下方提供的人物名稱一致。「〔略〕」表示摘要被截短，不要抄進輸出；也不要用「…」省略內容。
9. 一律使用繁體中文，只輸出 JSON，不要任何說明文字或 markdown。

輸出格式：
{"characters":[{"name":"","aliases":[],"age":"","identity":"","appearance":"","status":"","notes":"","timeline":[{"time":"","event":""}]}],"relations":[{"from":"","to":"","label":""}],"views":[{"from":"","to":"","desc":""}]}`;
    }
    function buildEnrichUser(s, blocks, msgs) {
        const people = blocks.map(({ c, refs }) => {
            const cur = FIELDS.map(([k, l]) => (c[k] ? `${l}：${clipP(c[k], 400)}` : '')).filter(Boolean).join('｜') || '（目前只有名字）';
            return `【人物：${c.name}${c.aliases.length ? `（別名：${c.aliases.join('、')}）` : ''}】\n目前檔案：${cur}\n設定資料：\n${refs.map((r) => `〈${r.label}〉\n${r.text}`).join('\n\n')}`;
        }).join('\n\n========\n\n');
        let story = msgs.join('\n\n');
        if (story.length > 6000) story = '…' + story.slice(-6000);
        const others = Object.values(s.characters).map((x) => x.name).join('、');
        return `${people}\n\n【現有人物】\n${others}\n\n【最近劇情】\n${story || '（無）'}\n\n請依規則輸出 JSON。`;
    }

    async function prepareBlocks(s, ids) {
        const src = await loadSources();
        const blocks = [];
        for (const id of ids) {
            const c = s.characters[id];
            if (!c) continue;
            const refs = findRefs(c, src);
            if (refs.length) blocks.push({ c, refs });
        }
        return blocks;
    }
    async function askEnrich(s, blocks, msgs) {
        const raw = await callLLM(buildEnrichSystem(), buildEnrichUser(s, blocks, msgs));
        return parseJSON(raw);
    }
    const enrichOpts = (blocks) => ({ onlyIds: new Set(blocks.map((b) => b.c.id)), createFromRelations: false, timelineFloor: null });

    function recentMsgs(n) {
        const chat = ctx().chat || [];
        const out = [];
        for (let i = Math.max(0, chat.length - n); i < chat.length; i++) {
            if (isReadable(chat[i])) out.push(fmtMsg(chat[i], i));
        }
        return out;
    }

    async function enrichOne(id) {
        if (busy) return;
        const s = store();
        const c = s?.characters[id];
        if (!c) return;
        if (root?.dataset.dirty === '1' && !confirm('目前的修改還沒儲存，繼續的話這些修改會不見。要繼續嗎？')) return;
        const idAt = chatId();
        setBusy(true);
        try {
            const blocks = await prepareBlocks(s, [id]);
            if (!blocks.length) { toast(`角色卡和世界書裡找不到「${c.name}」的資料`, 'info'); return; }
            const data = await askEnrich(s, blocks, recentMsgs(10));
            if (chatId() !== idAt) return;
            // 先算出會怎麼改，給使用者看過、改過再套用
            const s2 = store();
            const snapBase = migrate(deep({ characters: s2.characters, links: s2.links, views: s2.views }));
            const work = deep(snapBase);
            mergeUpdate(work, data, null, enrichOpts(blocks));
            purgeMyViews(work);
            const ops = diffOps(snapBase, work);
            if (!ops.length) { toast('沒有找到可以補的新資料', 'info'); return; }
            view.enrich = { charId: id, ops };
            view.tab = 'people';
            view.charId = id;
            render();
            toast(`找到 ${ops.length} 項可以補的資料，確認後按「套用」`, 'info');
        } catch (e) {
            console.error(LOG, e);
            toast(`補資料失敗：${e.message}`, 'error');
        } finally {
            setBusy(false);
        }
    }

    async function applyEnrich() {
        const s = store();
        const e = view.enrich;
        if (!s || !e) return;
        const name = s.characters[e.charId]?.name || '';
        snapshot(`從角色卡／世界書補資料：${name}`);
        const n = applyOps(s, e.ops);
        view.enrich = null;
        await persist();
        refreshInjection();
        view.keepScroll = true;
        render();
        toast(n ? `已套用 ${n} 項資料` : '沒有實際變動');
    }

    async function checkSources() {
        if (!hasChat()) return;
        const src = await loadSources(true);
        const cards = src.cards.map((c) => c.name).join('、') || '（沒有）';
        const books = src.books.join('、') || '（沒有）';
        toast(`角色卡：${esc(cards)}<br>世界書：${esc(books)}<br>共 ${src.entries.length} 條可用條目`, 'info');
    }

    /* ---------------- 整理：先算出「會怎麼改」，再決定什麼時候寫入 ---------------- */
    const deep = (o) => JSON.parse(JSON.stringify(o));

    // 把兩份資料的差異整理成一條條變動，方便預覽、編輯、之後再套用
    function diffOps(base, next) {
        const ops = [];
        for (const [id, c] of Object.entries(next.characters)) {
            const b = base.characters[id];
            if (!b) { ops.push({ op: 'add-char', id, char: deep(c) }); continue; }
            for (const [k] of FIELDS) {
                if ((c[k] || '') !== (b[k] || '')) ops.push({ op: 'field', id, key: k, old: b[k] || '', value: c[k] || '' });
            }
            for (const a of c.aliases) if (!b.aliases.includes(a)) ops.push({ op: 'alias', id, value: a });
            const had = new Set(b.timeline.map((t) => t.id));
            for (const t of c.timeline) if (!had.has(t.id)) ops.push({ op: 'timeline', id, entry: deep(t) });
        }
        for (const [kind, key] of [['link', 'label'], ['view', 'desc']]) {
            const list = kind === 'link' ? 'links' : 'views';
            const before = new Map(base[list].map((x) => [x.id, x]));
            const after = new Set(next[list].map((x) => x.id));
            for (const x of next[list]) {
                const b = before.get(x.id);
                if (!b) ops.push({ op: `${kind}-add`, item: deep(x) });
                else if (b[key] !== x[key]) ops.push({ op: `${kind}-set`, itemId: x.id, from: x.from, to: x.to, old: b[key], value: x[key] });
            }
            for (const b of base[list]) if (!after.has(b.id)) ops.push({ op: `${kind}-del`, item: deep(b) });
        }
        return ops;
    }

    // 把變動套用到人物檔（寫入時才呼叫）。寫入前人物檔可能被手動改過，所以每一步都會再檢查
    function applyOps(s, ops) {
        let n = 0;
        const idMap = {};
        const cid = (id) => idMap[id] || id;
        for (const o of ops) {
            if (o.op !== 'add-char') continue;
            if (s.characters[o.id]) continue;
            const same = (o.mergeInto && s.characters[o.mergeInto]) || findChar(s, o.char.name);
            if (same) {
                idMap[o.id] = same.id;
                for (const [k] of FIELDS) if (!same[k] && o.char[k] && !same.locks[k]) same[k] = o.char[k];
                for (const a of o.char.aliases || []) if (!same.aliases.includes(a)) same.aliases.push(a);
                noteAlias(same, o.char.name);
            } else {
                const c = deep(o.char);
                delete c.isUser;
                s.characters[o.id] = c;
            }
            n++;
        }
        for (const o of ops) {
            const c = o.id ? s.characters[cid(o.id)] : null;
            if (o.op === 'field') {
                if (c && !c.locks[o.key] && c[o.key] !== o.value) { c[o.key] = o.value; n++; }
            } else if (o.op === 'alias') {
                if (c && !c.locks.aliases && o.value && !c.aliases.some((a) => norm(a) === norm(o.value))) { c.aliases.push(o.value); n++; }
            } else if (o.op === 'timeline') {
                if (c && o.entry?.text && !c.timeline.some((t) => t.text === o.entry.text)) { c.timeline.push(deep(o.entry)); n++; }
            } else if (o.op === 'link-add' || o.op === 'view-add') {
                const isLink = o.op === 'link-add';
                const list = isLink ? s.links : s.views;
                const key = isLink ? 'label' : 'desc';
                const A = cid(o.item.from);
                const B = cid(o.item.to);
                if (!s.characters[A] || !s.characters[B] || !o.item[key]) continue;
                const ex = list.find((x) => x.from === A && x.to === B);
                if (ex) {
                    if (!ex.locked && ex[key] !== o.item[key]) { if (ex[key]) ex.history.push({ floor: ex.floor, [key]: ex[key] }); ex[key] = o.item[key]; ex.floor = o.item.floor; n++; }
                } else { list.push({ ...deep(o.item), from: A, to: B }); n++; }
            } else if (o.op === 'link-set' || o.op === 'view-set') {
                const isLink = o.op === 'link-set';
                const list = isLink ? s.links : s.views;
                const key = isLink ? 'label' : 'desc';
                const ex = list.find((x) => x.id === o.itemId) || list.find((x) => x.from === cid(o.from) && x.to === cid(o.to));
                if (ex && !ex.locked && o.value && ex[key] !== o.value) {
                    if (ex[key]) ex.history.push({ floor: ex.floor, [key]: ex[key] });
                    ex[key] = o.value;
                    ex.floor = Math.max(0, lastFloorNow());
                    n++;
                }
            } else if (o.op === 'link-del' || o.op === 'view-del') {
                const isLink = o.op === 'link-del';
                const list = isLink ? s.links : s.views;
                const i = list.findIndex((x) => x.id === o.item.id && !x.manual && !x.locked);
                if (i >= 0) { list.splice(i, 1); n++; }
            }
        }
        purgeMyViews(s);
        return n;
    }

    function readRange(start, end) {
        const chat = ctx().chat;
        const msgs = [];
        for (let i = start; i <= end; i++) if (isReadable(chat[i])) msgs.push(fmtMsg(chat[i], i));
        return msgs;
    }

    // 讀取回覆裡隱藏引擎的 VIEWS 區塊，例如：
    //   VIEWS｜德拉科→小曦：覺得她不好惹（被她當眾頂回去）
    //   VIEWS｜無
    const ENGINE_KEY_RE = /^\s*[A-Z][A-Z_]{2,}\s*[｜|:：]/;
    function parseEngineViews(text) {
        const lines = String(text ?? '')
            .replace(/<!--|-->/g, '\n')
            .replace(/<\/?[a-zA-Z][^>]*>/g, '\n')
            .split('\n');
        const items = [];
        let found = false;
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*VIEWS\s*[｜|:：]\s*(.*)$/);
            if (!m) continue;
            found = true;
            const block = [m[1]];
            for (let j = i + 1; j < lines.length; j++) {
                if (!lines[j].trim()) { if (block.length > 1) break; continue; }
                if (ENGINE_KEY_RE.test(lines[j])) break;
                block.push(lines[j]);
            }
            for (const raw of block.join('\n').split(/[\n；;]/)) {
                const line = raw.replace(/^[\s\-•*・]+/, '').trim();
                if (!line || /^(無|没有|沒有|none)$/i.test(line)) continue;
                const mm = line.match(/^(.+?)\s*(?:→|->|⇒|=>|＞)\s*(.+?)\s*[：:]\s*(.+)$/);
                if (mm) items.push({ from: mm[1].trim(), to: mm[2].trim(), desc: mm[3].trim() });
            }
        }
        return { found, items };
    }
    function collectEngineViews(start, end) {
        const chat = ctx().chat;
        let found = false;
        const items = [];
        for (let i = start; i <= end; i++) {
            const m = chat[i];
            if (!m || m.is_user || !isReadable(m)) continue;
            const r = parseEngineViews(m.mes);
            if (r.found) { found = true; items.push(...r.items); }
        }
        return { found, items };
    }

    // 呼叫 AI，在複本上試著改一遍，算出變動清單（不動到真正的人物檔）
    async function analyze(base, msgs, start, end) {
        const st = settings();
        const engine = st.readEngineViews ? collectEngineViews(start, end) : { found: false, items: [] };
        // 開始時先拍一份底稿；整理途中使用者手動改了什麼，都不會被這次的結果蓋掉
        const snapBase = migrate(deep({ characters: base.characters, links: base.links, views: base.views }));
        const work = deep(snapBase);
        const data = parseJSON(await callLLM(buildSystemPrompt(engine.found), buildUserPrompt(work, msgs, start, end)));
        if (engine.found) data.views = []; // 看法只採用 VIEWS 區塊
        const res = mergeUpdate(work, data, end);
        if (engine.items.length) {
            const r2 = mergeUpdate(work, { characters: [], relations: [], views: engine.items }, end);
            res.created.push(...r2.created);
        }
        if (st.readSources && res.created.length) {
            try {
                const blocks = await prepareBlocks(work, res.created);
                if (blocks.length) mergeUpdate(work, await askEnrich(work, blocks, msgs), end, enrichOpts(blocks));
            } catch (e) {
                console.warn(LOG, e);
                toast(`讀取角色卡／世界書補資料失敗：${e.message}`, 'warning');
            }
        }
        purgeMyViews(work);
        return diffOps(snapBase, work);
    }

    // 直接寫入（最後一則不是 AI 回覆、或整理舊樓層時用）
    function commitOps(s, ops, end, endFp, reason) {
        const snapId = snapshot(reason);
        const n = applyOps(s, ops);
        s.lastFloor = Math.max(s.lastFloor, end);
        s.log.forEach((x) => { delete x.pending; });
        s.log.push({ floor: end, fp: endFp, snapId });
        return n;
    }

    let analyzing = null; // { chat, floor, key, promise }
    // 整理結果的暫存：整理途中離開聊天，回來時還能接上，不用重跑
    const resultCache = new Map();
    const cacheKey = (cid, floor, key, hash) => `${cid}|${floor}|${key}|${hash}`;

    // 替最新那則 AI 回覆（目前這個 swipe）算出待確認的變動
    async function computePending(floor, source) {
        if (!hasChat()) return;
        const st = settings();
        let s = store();
        const chat = ctx().chat;
        const m = chat[floor];
        if (!isAiMsg(m)) return;
        // 前一則待確認還沒寫入，但後面又多了新的 AI 回覆：前一則已經定案，先寫入
        if (s.pending && s.pending.floor < floor) await commitPending('auto');
        s = store();
        if (s.pending && s.pending.floor !== floor) s.pending = null;
        const key = swipeKey(m);
        const h = hashStr(m.mes);
        const old = entryFor(s.pending, m);
        if (source === 'auto' && old && old.status === 'ready') { renderChip(); return; }
        if (analyzing && analyzing.floor === floor && analyzing.key === key) return analyzing.promise;
        if (busy) { if (source === 'manual') toast('正在整理中，請稍等', 'info'); return; }

        const start = Math.max(s.lastFloor + 1, floor - (Number(st.maxMessages) || 20) + 1, 0);
        const msgs = readRange(start, floor);
        if (!msgs.length) return;
        if (!s.pending) s.pending = { floor, sendDate: m.send_date, swipes: {} };
        s.pending.swipes[key] = { hash: h, status: 'computing', ops: [], start, end: floor, ts: Date.now() };
        const idAt = chatId();
        const run = (async () => {
            setBusy(true);
            renderChip();
            softRender();
            try {
                const ops = await analyze(s, msgs, start, floor);
                resultCache.set(cacheKey(idAt, floor, key, h), { ops, start, end: floor });
                if (chatId() !== idAt) return;
                const s2 = store();
                const ent = s2.pending?.swipes?.[key];
                if (!ent || s2.pending.floor !== floor) return;
                const now = ctx().chat[floor];
                // 回覆被刪掉才丟掉結果；整理途中滑到別則或編輯過，結果都留給原本那則
                if (!isAiMsg(now) || (swipeKey(now) !== key && (now.swipes?.length ?? 1) <= Number(key))) { delete s2.pending.swipes[key]; return; }
                Object.assign(ent, { status: 'ready', ops, error: '' });
                await persist();
                if (s2.pending.commitOnReady) await commitPending('send');
                else if (source === 'manual') toast(ops.length ? `整理好了：${ops.length} 項變動，送出下一則訊息時寫入` : '這則回覆沒有人物變動', 'info');
            } catch (e) {
                console.error(LOG, e);
                const ent = store()?.pending?.swipes?.[key];
                if (ent) Object.assign(ent, { status: 'error', error: e.message });
                toast(`整理失敗：${e.message}`, 'error');
            } finally {
                setBusy(false);
                analyzing = null;
                renderChip();
                softRender();
            }
        })();
        analyzing = { chat: idAt, floor, key, promise: run };
        return run;
    }

    // 把待確認的變動寫入人物檔（送出下一則訊息時，或手動按「現在就寫入」）
    async function commitPending(source) {
        const s = store();
        const p = s?.pending;
        if (!p) return 0;
        const chat = ctx().chat;
        const m = chat[p.floor];
        if (!isAiMsg(m)) { s.pending = null; await persist(); renderChip(); return 0; }
        const key = swipeKey(m);
        const ent = entryFor(p, m);
        if (!ent) { s.pending = null; await persist(); renderChip(); return 0; } // 這個 swipe 沒整理過，之後再一起整理
        if (ent.status === 'computing') { p.commitOnReady = true; return 0; }
        if (ent.status !== 'ready') { s.pending = null; await persist(); renderChip(); return 0; }
        const saved = deep(p);
        delete saved.commitOnReady;
        const n = commitOps(s, ent.ops, ent.end, fp(m), `寫入第 ${p.floor} 樓的更新（第 ${Number(key) + 1} 則回覆）`);
        s.log[s.log.length - 1].pending = saved; // 之後如果這則又變回最新一則，可以退回成待確認
        s.log[s.log.length - 1].swipe = key;
        s.pending = null;
        await persist();
        refreshInjection();
        renderChip();
        softRender();
        if (source === 'manual') toast(n ? `已寫入 ${n} 項變動` : '已寫入（沒有實際變動）');
        return n;
    }

    // 「立即更新」：最後一則是 AI 回覆就算成待確認；否則直接寫入
    async function requestUpdate() {
        if (!hasChat() || busy) return;
        await verify();
        const chat = ctx().chat;
        const end = chat.length - 1;
        if (end < 0) return;
        if (isAiMsg(chat[end])) { await computePending(end, 'manual'); return; }
        const s = store();
        const st = settings();
        const start = Math.max(s.lastFloor + 1, end - (Number(st.maxMessages) || 20) + 1, 0);
        const msgs = start <= end ? readRange(start, end) : [];
        if (!msgs.length) { toast('目前沒有新的劇情需要整理', 'info'); return; }
        const endFp = fp(chat[end]);
        const idAt = chatId();
        setBusy(true);
        try {
            const ops = await analyze(s, msgs, start, end);
            if (chatId() !== idAt || !fpMatch(ctx().chat[end], endFp)) { toast('整理途中聊天有變動，這次結果先不套用', 'warning'); return; }
            const n = commitOps(store(), ops, end, endFp, `手動更新（整理到第 ${end} 樓）`);
            await persist();
            refreshInjection();
            softRender();
            toast(n ? `人物檔已更新（${n} 處變動）` : '這段劇情沒有需要更新的人物資料', n ? 'success' : 'info');
        } catch (e) {
            console.error(LOG, e);
            toast(`更新失敗：${e.message}`, 'error');
        } finally {
            setBusy(false);
        }
    }

    const keepCount = (st) => (st.mode === 'off' ? 0 : Math.max(0, Math.floor(Number(st.keepRecent) || 0)));
    const needFloors = (st) => (st.mode === 'every' ? 1 : Math.max(1, Number(st.interval) || 1));
    // 保留最近 keep 則 AI 回覆不整理時，自動整理可以整理到哪一樓（-1＝還沒有）
    // 停在被保留的那幾則前面的那則 AI 回覆，後面的使用者訊息也一起留著
    function settledEnd(chat, keep) {
        let n = 0;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!isAiMsg(chat[i])) continue;
            if (n++ === keep) return i;
        }
        return -1;
    }

    // 有設定保留最近幾則回覆時：已經定下來、還沒整理的樓層累積夠了就整理
    // 收到新回覆、或改了更新頻率／保留則數時檢查
    function settleCheck() {
        const st = settings();
        const keep = keepCount(st);
        if (!keep || !hasChat() || store().paused) return;
        const end = settledEnd(ctx().chat, keep);
        if (end >= 0 && end - store().lastFloor >= needFloors(st)) setTimeout(() => autoSettle(end), 300);
        else renderChip();
    }

    // 自動整理比較早、已經定下來的樓層，直接寫入（有設定保留最近幾則回覆時用）
    async function autoSettle(end) {
        if (busy || !hasChat()) return;
        const s = store();
        if (end <= s.lastFloor) return;
        const chat = ctx().chat;
        const start = Math.max(s.lastFloor + 1, end - (Number(settings().maxMessages) || 20) + 1, 0);
        const msgs = readRange(start, end);
        if (!msgs.length) { s.lastFloor = end; await persist(); updateBar(); renderChip(); return; }
        const endFp = fp(chat[end]);
        const idAt = chatId();
        setBusy(true);
        try {
            const ops = await analyze(s, msgs, start, end);
            if (chatId() !== idAt || !fpMatch(ctx().chat[end], endFp)) return; // 途中聊天有變動，下次再整理
            const n = commitOps(store(), ops, end, endFp, `自動整理（第 ${start}～${end} 樓）`);
            await persist();
            refreshInjection();
            if (n) toast(`人物檔已更新：第 ${start}～${end} 樓，${n} 處變動`, 'info');
        } catch (e) {
            console.error(LOG, e);
            toast(`自動整理失敗：${e.message}`, 'error');
        } finally {
            setBusy(false);
            renderChip();
            softRender();
        }
    }

    /* ---------------- 整理所有還沒整理的樓層（舊聊天用） ---------------- */
    async function backfill() {
        if (busy || !hasChat()) return;
        await verify();
        const st = settings();
        const s = store();
        const chat = ctx().chat;
        const latest = chat.length - 1;
        // 最新一則如果是 AI 回覆，留給「待確認」處理，可以 swipe
        const end = isAiMsg(chat[latest]) ? latest - 1 : latest;
        const from = s.lastFloor + 1;
        if (from > end) {
            if (isAiMsg(chat[latest])) await computePending(latest, 'manual');
            else toast('所有樓層都已經整理過了', 'info');
            return;
        }
        const size = Math.max(5, Number(st.backfillBatch) || 30);
        const batches = [];
        for (let a = from; a <= end; a += size) batches.push([a, Math.min(end, a + size - 1)]);
        const extra = st.readSources ? '，有新人物時每批會再多一次' : '';
        if (!confirm(`要整理第 ${from}～${end} 樓，分成 ${batches.length} 批，大約呼叫 API ${batches.length} 次${extra}。\n途中可以按「停止」，已整理好的部分會保留。要開始嗎？`)) return;

        const idAt = chatId();
        busy = true;
        progress = { done: 0, total: batches.length, stop: false };
        updateBar();
        let changes = 0;
        let created = 0;
        try {
            for (const [a, b] of batches) {
                if (progress.stop) break;
                const c = ctx().chat;
                if (chatId() !== idAt) { toast('聊天已切換，整理先停下來', 'warning'); break; }
                const msgs = [];
                for (let i = a; i <= b; i++) if (isReadable(c[i])) msgs.push(fmtMsg(c[i], i));
                const endFp = fp(c[b]);
                const s1 = store();
                if (msgs.length) {
                    const ops = await analyze(s1, msgs, a, b);
                    if (chatId() !== idAt || !fpMatch(ctx().chat[b], endFp)) { toast('整理途中聊天有變動，先停下來', 'warning'); break; }
                    created += ops.filter((o) => o.op === 'add-char').length;
                    changes += commitOps(store(), ops, b, endFp, `整理舊樓層（第 ${a}～${b} 樓）`);
                } else {
                    s1.lastFloor = b;
                }
                await persist();
                progress.done++;
                updateBar();
                softRender();
            }
            const stopped = progress.done < progress.total;
            toast(`${stopped ? '已停止' : '整理完成'}：處理 ${progress.done}/${progress.total} 批，新人物 ${created} 位，${changes} 處變動`, stopped ? 'info' : 'success');
            if (!stopped && isAiMsg(ctx().chat[latest]) && chatId() === idAt) {
                busy = false;
                progress = null;
                await computePending(latest, 'manual');
            }
        } catch (e) {
            console.error(LOG, e);
            toast(`整理到一半失敗：${e.message}。已完成的 ${progress.done} 批會保留，可以再按一次繼續`, 'error');
        } finally {
            busy = false;
            progress = null;
            refreshInjection();
            updateBar();
            softRender();
        }
    }

    // 檢查聊天和人物檔是否對得上：
    // - 待確認那則被刪掉：丟掉待確認
    // - 已寫入的那則又變成最新一則（例如刪掉了自己的訊息）：退回成待確認，可以重新 swipe
    // - 已寫入的回覆被換掉或刪掉：不自動退回，先問使用者
    async function verify() {
        if (!hasChat()) return;
        const s = store();
        const chat = ctx().chat || [];
        // 聊天還沒載入完（剛切換聊天時）不要檢查，不然會誤以為訊息都不見了
        if (!chat.length) return;
        let changed = false;
        if (s.pending) {
            const m = chat[s.pending.floor];
            if (!isAiMsg(m)) { s.pending = null; changed = true; }
        }
        while (s.log.length) {
            const last = s.log[s.log.length - 1];
            const L = chat.length - 1;
            // 已寫入的那則又變成最新一則 → 退回成待確認
            if (last.pending && last.floor === L && isAiMsg(chat[L]) && !s.pending
                && s.snapshots.length && s.snapshots[s.snapshots.length - 1].id === last.snapId) {
                const snap = s.snapshots.pop();
                const pend = last.pending;
                applyState(s, snap.data);
                s.pending = { ...pend, floor: L, commitOnReady: false };
                changed = true;
                continue;
            }
            if (fpMatch(chat[last.floor], last.fp)) break;
            // 前面有樓層被刪掉時，那則回覆只是換了位置，不算變動
            const j = chat.findIndex((x) => fpMatch(x, last.fp));
            if (j >= 0) {
                const delta = last.floor - j;
                if (s.lastFloor >= last.floor) s.lastFloor -= delta;
                last.floor = j;
                changed = true;
                continue;
            }
            if (!s.conflict || s.conflict.snapId !== last.snapId) {
                s.conflict = { floor: last.floor, snapId: last.snapId };
                changed = true;
                toast(`第 ${last.floor} 樓的回覆被換掉或刪除了。人物檔沒有自動退回，打開人物檔案館可以決定要不要退回。`, 'warning');
            }
            break;
        }
        if (s.conflict && !s.log.some((x) => x.snapId === s.conflict.snapId)) { s.conflict = null; changed = true; }
        if (s.lastFloor > chat.length - 1) { s.lastFloor = chat.length - 1; changed = true; }
        if (changed) {
            await persist();
            refreshInjection();
            softRender();
        }
        renderChip();
    }

    // 等聊天內容真的載入完
    async function waitChatReady() {
        const id = chatId();
        for (let i = 0; i < 40; i++) {
            if (chatId() !== id) return false;
            if ((ctx().chat || []).length) return true;
            await new Promise((r) => setTimeout(r, 100));
        }
        return false;
    }
    // 回到聊天時：整理到一半的結果從暫存接回來；接不回來的標成「沒完成」，不會一直卡在整理中
    async function restorePending() {
        const s = store();
        if (!s) return;
        const cid = chatId();
        const chat = ctx().chat || [];
        const L = chat.length - 1;
        if (!s.pending && isAiMsg(chat[L]) && L > s.lastFloor) {
            const hit = resultCache.get(cacheKey(cid, L, swipeKey(chat[L]), hashStr(chat[L].mes)));
            if (hit) s.pending = { floor: L, sendDate: chat[L].send_date, swipes: {} };
        }
        const p = s.pending;
        if (!p) return;
        const m = chat[p.floor];
        let changed = false;
        for (const [key, ent] of Object.entries(p.swipes || {})) {
            if (ent.status !== 'computing') continue;
            if (analyzing && analyzing.chat === cid && analyzing.floor === p.floor && analyzing.key === key) continue;
            const hit = resultCache.get(cacheKey(cid, p.floor, key, ent.hash));
            if (hit) Object.assign(ent, { status: 'ready', ops: hit.ops, error: '' });
            else Object.assign(ent, { status: 'error', error: '上次整理沒有完成（中途離開了聊天），點一下重新整理' });
            changed = true;
        }
        // 這則還沒有結果，但暫存裡有（整理途中離開、之後才整理完）
        if (m && isAiMsg(m)) {
            const key = swipeKey(m);
            if (!p.swipes[key]) {
                const hit = resultCache.get(cacheKey(cid, p.floor, key, hashStr(m.mes)));
                if (hit) { p.swipes[key] = { hash: hashStr(m.mes), status: 'ready', ops: hit.ops, start: hit.start, end: hit.end, ts: Date.now() }; changed = true; }
            }
        }
        if (changed) await persist();
    }

    // 暫停／恢復這個聊天的整理
    async function togglePause() {
        const s = store();
        if (!s) return;
        const L = lastFloorNow();
        if (!s.paused) {
            s.paused = { from: L + 1, ts: Date.now() };
            await persist();
            updateBar();
            renderChip();
            toast('這個聊天暫停整理了。之後的劇情不會自動整理，也不會寫入待確認的變動。', 'info');
            return;
        }
        const from = s.paused.from;
        s.paused = null;
        const missed = L - Math.max(s.lastFloor, from - 1);
        if (missed > 0) {
            const catchUp = confirm(`暫停期間有 ${missed} 樓沒有整理。

按「確定」：把這幾樓補整理進人物檔。
按「取消」：跳過這幾樓，不記錄進人物檔。`);
            if (!catchUp) {
                s.lastFloor = Math.max(s.lastFloor, L);
                s.pending = null;
                await persist();
                updateBar();
                renderChip();
                softRender();
                toast(`已恢復整理，暫停期間的 ${missed} 樓不記錄`, 'info');
                return;
            }
            await persist();
            updateBar();
            toast('已恢復整理，開始補整理暫停期間的劇情', 'info');
            if (L - s.lastFloor > (Number(settings().maxMessages) || 20)) await backfill();
            else await requestUpdate();
            return;
        }
        await persist();
        updateBar();
        renderChip();
        toast('已恢復整理', 'info');
    }

    async function resolveConflict(revert) {
        const s = store();
        const cf = s?.conflict;
        if (!cf) return;
        const i = s.log.findIndex((x) => x.snapId === cf.snapId);
        if (revert) {
            const k = s.snapshots.findIndex((x) => x.id === cf.snapId);
            if (k < 0) { toast('找不到那次更新之前的備份，沒辦法退回', 'warning'); }
            else {
                const snap = s.snapshots[k];
                s.snapshots.splice(k);
                applyState(s, snap.data);
                s.pending = null;
                toast('已退回那次更新');
            }
        } else if (i >= 0) {
            s.log.splice(i, 1); // 保留內容，不再追蹤那則回覆
            toast('已保留，不會再提醒這一則');
        }
        s.conflict = null;
        await persist();
        await verify();
        refreshInjection();
        render();
    }

    async function onMessageReceived() {
        if (!hasChat()) return;
        await verify();
        const st = settings();
        const chat = ctx().chat;
        const L = chat.length - 1;
        const m = chat[L];
        if (!isAiMsg(m)) return;
        const s = store();
        if (s.paused) { renderChip(); return; } // 這個聊天暫停整理：不算、不寫
        if (s.pending && s.pending.floor < L) await commitPending('auto');
        if (st.mode === 'off') { renderChip(); return; }
        // 最近幾則回覆先不整理，使用者回頭改最近的對話時才不會一直重新整理
        if (keepCount(st)) { settleCheck(); return; }
        if (L - store().lastFloor >= needFloors(st)) setTimeout(() => computePending(L, 'auto'), 300);
        else renderChip();
    }

    // 使用者送出訊息＝選定了上一則回覆：把它的待確認變動寫入，這一輪就一起送給 AI
    async function onMessageSent() {
        if (!hasChat()) return;
        const s = store();
        if (s.paused) { refreshInjection(); return; }
        if (s.pending) {
            const ent = entryFor(s.pending, ctx().chat[s.pending.floor]);
            if (ent?.status === 'computing' && analyzing?.promise) {
                s.pending.commitOnReady = true;
                await Promise.race([analyzing.promise, new Promise((r) => setTimeout(r, 30000))]);
            }
            if (store().pending) await commitPending('send');
        }
        refreshInjection();
    }

    /* ---------------- 訊息下方的小提示 ---------------- */
    function renderChip() {
        try {
            document.querySelectorAll('.ca-chip').forEach((e) => e.remove());
            if (!hasChat()) return;
            const s = store();
            const chat = ctx().chat || [];
            const L = chat.length - 1;
            if (!isAiMsg(chat[L])) return;
            const p = s.pending && s.pending.floor === L ? s.pending : null;
            const ent = entryFor(p, chat[L]);
            const st = settings();
            let text;
            let act = 'open';
            if (s.paused) {
                text = '人物檔：這個聊天暫停整理中';
            } else if (!ent) {
                if (st.mode === 'off' && !p) return;
                if (L <= s.lastFloor) return;
                const keep = keepCount(st);
                if (keep) text = `人物檔：最近 ${keep} 則回覆先不整理`;
                else { text = '人物檔：這則還沒整理，點我整理'; act = 'compute'; }
            } else if (ent.status === 'computing') text = '人物檔：整理中…';
            else if (ent.status === 'error') { text = '人物檔：整理失敗，點我重試'; act = 'compute'; }
            else {
                text = ent.ops.length ? `人物檔：${ent.ops.length} 項變動待確認` : '人物檔：沒有變動';
                if (isEdited(ent, chat[L])) text += '（內容改過了，可以重新整理）';
            }
            const host = document.querySelector(`#chat .mes[mesid="${L}"] .mes_block`);
            if (!host) return;
            const chip = document.createElement('div');
            chip.className = 'ca-chip';
            chip.textContent = text;
            chip.addEventListener('click', () => {
                if (act === 'compute') computePending(L, 'manual');
                else { view.tab = 'pending'; view.charId = null; openPanel(); }
            });
            host.appendChild(chip);
        } catch (e) { console.warn(LOG, e); }
    }
    const renderChipLater = () => setTimeout(renderChip, 120);

    /* ---------------- 匯入／匯出 ---------------- */
    function exportArchive() {
        const s = store();
        if (!s) return;
        const payload = { format: 'char-archive', version: 1, exportedAt: new Date().toISOString(), characters: s.characters, links: s.links, views: s.views };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const name = `人物檔案館_${String(ctx().name2 || '聊天').replace(/[\\/:*?"<>|]/g, '')}_${stamp}.json`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
        toast(`已匯出：${Object.keys(s.characters).length} 位人物、${s.links.length} 條關係、${s.views.length} 則看法`);
    }

    let importMode = 'merge';
    function pickImport(mode) {
        importMode = mode;
        const input = root?.querySelector('#ca-import-file');
        if (input) { input.value = ''; input.click(); }
    }
    async function importArchive(file) {
        const s = store();
        if (!s || !file) return;
        let data;
        try { data = JSON.parse(await file.text()); } catch { toast('這個檔案不是正確的 JSON', 'error'); return; }
        if (!data || typeof data.characters !== 'object') { toast('這個檔案不是人物檔案館匯出的格式', 'error'); return; }
        migrate(data);
        if (importMode === 'replace' && !confirm('匯入（取代）會把這個聊天目前的人物、關係和看法全部換掉。會先備份，可以從「紀錄」還原。要繼續嗎？')) return;
        snapshot(importMode === 'replace' ? '匯入（取代）' : '匯入（合併）');
        if (importMode === 'replace') { s.characters = {}; s.links = []; s.views = []; }
        const map = {};
        let added = 0;
        let merged = 0;
        for (const c of Object.values(data.characters)) {
            const ex = findChar(s, c.name) || (c.aliases || []).map((a) => findChar(s, a)).find(Boolean);
            if (ex) {
                map[c.id] = ex.id;
                for (const [k] of FIELDS) if (!ex[k] && c[k]) ex[k] = c[k];
                for (const a of c.aliases || []) if (!ex.aliases.includes(a)) ex.aliases.push(a);
                for (const t of c.timeline || []) if (!ex.timeline.some((x) => x.text === t.text)) ex.timeline.push({ ...t, id: uid() });
                merged++;
            } else {
                const nc = { ...deep(c), id: uid() };
                delete nc.isUser;
                s.characters[nc.id] = nc;
                map[c.id] = nc.id;
                added++;
            }
        }
        let rels = 0;
        for (const [list, src] of [[s.links, data.links], [s.views, data.views]]) {
            for (const r of src || []) {
                const A = map[r.from];
                const B = map[r.to];
                if (!A || !B || list.some((x) => x.from === A && x.to === B)) continue;
                list.push({ ...deep(r), id: uid(), from: A, to: B });
                rels++;
            }
        }
        rels = Math.max(0, rels - purgeMyViews(s));
        await persist();
        refreshInjection();
        render();
        toast(`匯入完成：新增 ${added} 位、合併 ${merged} 位人物，${rels} 條關係和看法`);
    }

    /* ---------------- 送進提示詞 ---------------- */
    function refreshInjection() {
        const c = ctx();
        if (typeof c.setExtensionPrompt !== 'function') return;
        const st = settings();
        const f = { ...DEFAULTS.injFields, ...(st.injFields || {}) };
        const set = (v) => c.setExtensionPrompt(PROMPT_KEY, v, 1, Number(st.injectDepth) || 4, false, 0);
        if (!st.inject || !hasChat() || store()?.injectOff) { set(''); return; }
        const s = store();
        const chars = Object.values(s.characters);
        if (!chars.length) { set(''); return; }
        const me = meChar(s);
        const blocks = [];

        // 1. 最近對話中提到的人物：送出勾選的資料
        const recent = (c.chat || []).slice(-Math.max(1, Number(st.injectScan) || 3))
            .filter(isStory).map((m) => m.mes).join('\n').toLowerCase();
        const present = chars
            .filter((ch) => [ch.name, ...(ch.aliases || [])].some((n) => norm(n) && recent.includes(norm(n))))
            .slice(0, Math.max(1, Number(st.injectMax) || 8));
        if (present.length) {
            const lines = present.map((ch) => {
                const out = [`◆ ${ch.name}${ch === me ? '（主角）' : ''}`];
                if (f.aliases && ch.aliases.length) out.push(`  別名：${ch.aliases.join('、')}`);
                if (f.age && ch.age) out.push(`  年齡：${ch.age}`);
                if (f.identity && ch.identity) out.push(`  身分：${ch.identity}`);
                if (f.appearance && ch.appearance) out.push(`  外貌：${ch.appearance}`);
                if (f.appearance && ch.appearanceNow) out.push(`  外貌現況：${ch.appearanceNow}`);
                if (f.status && ch.status) out.push(`  現況：${ch.status}`);
                if (f.notes && ch.notes) out.push(`  備註：${ch.notes}`);
                if (f.timeline && ch.timeline.length) out.push(`  經歷：${ch.timeline.map((t) => (t.time ? `${t.time} ${t.text}` : t.text)).join('；')}`);
                if (f.links && !st.alwaysLinks) {
                    const ls = s.links.filter((l) => l.from === ch.id);
                    if (ls.length) out.push(`  關係：${ls.map((l) => `對${charName(s, l.to)}：${l.label}`).join('；')}`);
                }
                if (f.views && !st.alwaysViews) {
                    const vs = s.views.filter((r) => r.from === ch.id);
                    if (vs.length) out.push(`  看法：${vs.map((r) => `對${charName(s, r.to)}：${r.desc}`).join('；')}`);
                }
                return out.length > 1 ? out.join('\n') : '';
            }).filter(Boolean);
            if (lines.length) blocks.push(`【本段提到的人物】\n${lines.join('\n')}`);
        }

        // 2. 每輪固定送出
        if (st.alwaysRoster) {
            blocks.push(`【人物名單】\n${chars.map((ch) => `${ch.name}${ch === me ? '（主角）' : ''}${ch.identity ? `：${clip(ch.identity, 30)}` : ''}`).join('\n')}`);
        }
        if (st.alwaysLinks && s.links.length) {
            blocks.push(`【人物關係】（沒列出的兩人彼此陌生）\n${s.links.map((l) => `${charName(s, l.from)} → ${charName(s, l.to)}：${l.label}`).join('\n')}`);
        }
        if (st.alwaysViews && s.views.length) {
            blocks.push(`【人物看法】\n${s.views.map((r) => `${charName(s, r.from)} → ${charName(s, r.to)}：${r.desc}`).join('\n')}`);
        }

        if (!blocks.length) { set(''); return; }
        set(`[人物檔案：敘事時請和以下資料保持一致；沒有記錄關係的人物彼此陌生]\n${blocks.join('\n\n')}`);
    }

    /* ---------------- 介面 ---------------- */
    const opt = (v, label, cur) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${label}</option>`;

    function barHTML() {
        const st = settings();
        const s = hasChat() ? store() : null;
        const now = lastFloorNow();
        let status = !s ? '' : s.lastFloor < 0
            ? `還沒整理過，目前到第 ${now} 樓`
            : `已整理到第 ${s.lastFloor} 樓，目前到第 ${now} 樓`;
        if (s?.paused) status = `這個聊天從第 ${s.paused.from} 樓起暫停整理。${status}`;
        const toggles = s ? `<div class="ca-toggles">
                <button class="ca-toggle${s.paused ? '' : ' is-on'}" data-act="toggle-pause" aria-pressed="${!s.paused}"><span class="ca-dot"></span>這個聊天整理：${s.paused ? '暫停中' : '開啟'}</button>
                <button class="ca-toggle${s.injectOff ? '' : ' is-on'}" data-act="toggle-inject" aria-pressed="${!s.injectOff}"><span class="ca-dot"></span>送資料給 AI：${s.injectOff ? '關閉' : '開啟'}</button>
            </div>` : '';
        return `${toggles}<div class="ca-bar">
            <select class="ca-input ca-mode" data-set="mode" aria-label="自動更新頻率">
                ${opt('every', '每次回覆都更新', st.mode)}
                ${opt('interval', '每隔幾樓更新', st.mode)}
                ${opt('off', '不自動整理（只手動）', st.mode)}
            </select>
            ${st.mode === 'interval' ? `<label class="ca-n">每 <input class="ca-input" type="number" min="1" max="50" data-set="interval" value="${esc(st.interval)}"> 樓</label>` : ''}
            ${st.mode !== 'off' ? `<label class="ca-n">留最近 <input class="ca-input" type="number" min="0" max="20" data-set="keepRecent" value="${esc(st.keepRecent)}"> 則不整理</label>` : ''}
            ${progress
                ? `<button class="ca-btn ca-primary" disabled>整理中 ${progress.done}/${progress.total}</button><button class="ca-btn" data-act="stop" ${progress.stop ? 'disabled' : ''}>${progress.stop ? '停止中…' : '停止'}</button>`
                : `<button class="ca-btn ca-primary" data-act="update" ${busy || !s ? 'disabled' : ''}>${busy ? '整理中…' : '立即更新'}</button>`}
            <button class="ca-btn" data-act="undo" ${s && s.snapshots.length && !busy ? '' : 'disabled'}>↶ 上一步</button>
            <button class="ca-btn" data-act="redo" ${s && s.redo.length && !busy ? '' : 'disabled'}>↷ 下一步</button>
        </div>
        <div class="ca-status">${esc(status)}${st.mode === 'interval' && !s?.paused ? '（使用者和 AI 的訊息各算一樓）' : ''}${s && !s.paused ? keepNote(st, s) : ''}
            ${s && !s.paused && !busy && now - s.lastFloor > (Number(st.maxMessages) || 20) ? `<button class="ca-link" data-act="backfill">還有 ${now - s.lastFloor} 樓沒整理，全部整理</button>` : ''}
        </div>`;
    }

    // 狀態列：保留最近幾則回覆時，說明還差多少樓才會自動整理
    function keepNote(st, s) {
        const keep = keepCount(st);
        if (!keep) return '';
        const head = `最近 ${keep} 則 AI 回覆先不整理`;
        if (st.mode !== 'interval') return `（${head}，等它們變舊才寫入）`;
        const end = settledEnd(ctx().chat || [], keep);
        const ready = Math.max(0, end - s.lastFloor);
        const need = needFloors(st);
        return `（${head}；在那之前還沒整理的有 ${ready} 樓，${ready >= need ? '下一則回覆進來就整理' : `滿 ${need} 樓自動整理`}）`;
    }

    function shell(body) {
        const s = hasChat() ? store() : null;
        const pend = s?.pending ? (entryFor(s.pending, ctx().chat[s.pending.floor])?.ops?.length || 0) : 0;
        const tabs = [['pending', `待確認${pend ? `<span class="ca-badge">${pend}</span>` : ''}`], ['people', '人物'], ['relations', '關係'], ['history', '紀錄'], ['settings', '設定']];
        const banner = s?.conflict ? `<div class="ca-banner">
                <div>第 ${s.conflict.floor} 樓的回覆被換掉或刪除了，但依據它寫入的更新還在人物檔裡。</div>
                <div class="ca-bannerbtns"><button class="ca-btn ca-primary" data-act="conflict-revert">退回那次更新</button><button class="ca-btn" data-act="conflict-keep">保留</button></div>
            </div>` : '';
        return `<div class="ca-panel" role="dialog" aria-modal="true" aria-label="人物檔案館">
            <div class="ca-head">
                <div class="ca-title">人物檔案館 <span class="ca-ver">v0.7.10</span></div>
                <button class="ca-icon" data-act="close" aria-label="關閉">✕</button>
            </div>
            <div class="ca-barwrap">${barHTML()}</div>
            <div class="ca-tabs">${tabs.map(([k, l]) => `<button class="ca-tab${view.tab === k ? ' is-on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</div>
            <div class="ca-body">${banner}${body}</div>
        </div>`;
    }

    function renderList(s) {
        const chars = Object.values(s.characters).sort((a, b) => (a.firstFloor ?? 0) - (b.firstFloor ?? 0));
        if (!chars.length) {
            return `<div class="ca-empty">
                <p>這個聊天還沒有人物檔。</p>
                <p>按上面的「立即更新」，讓 AI 從最近的劇情整理出場人物；也可以自己新增。</p>
                <p>已經聊了一陣子的話，可以從第 0 樓開始全部整理（已隱藏的樓層也會讀）。</p>
                <div class="ca-emptybtns">
                    <button class="ca-btn ca-primary" data-act="backfill">從頭整理整個聊天</button>
                    <button class="ca-btn" data-act="add-char">＋ 新增人物</button>
                </div>
            </div>`;
        }
        const me = meChar(s);
        const others = chars.filter((c) => c !== me);
        const card = (c) => `
                <button class="ca-card${c === me ? ' is-me' : ''}" data-act="open-char" data-id="${c.id}" data-search="${esc([c.name, ...c.aliases, c.identity].join(' ').toLowerCase())}">
                    <span class="ca-cardtab">${c === me ? '主角' : `第 ${c.firstFloor ?? '?'} 樓登場`}</span>
                    <span class="ca-cardname">${esc(c.name)}</span>
                    ${c.aliases.length ? `<span class="ca-cardalias">${esc(c.aliases.join('、'))}</span>` : ''}
                    <span class="ca-cardmeta">${esc([c.age, c.identity].filter(Boolean).join('｜') || '資料待補')}</span>
                    ${c.status ? `<span class="ca-cardstatus">${esc(clip(c.status, 60))}</span>` : ''}
                    ${c === me ? `<span class="ca-cardstatus">${s.links.filter((l) => l.from === me.id || l.to === me.id).length} 條關係，${s.views.filter((r) => r.to === me.id).length} 人對主角有看法</span>` : ''}
                </button>`;
        return `<div class="ca-listtools">
                <input class="ca-input" type="search" data-filter placeholder="搜尋名字、別名、身分" aria-label="搜尋人物">
                <button class="ca-btn" data-act="add-char">＋ 新增人物</button>
            </div>
            ${me ? `<div class="ca-grid ca-megrid">${card(me)}</div>` : '<p class="ca-muted ca-nome">還沒認出主角。打開主角的人物頁，按最下面的「設為主角」就可以指定。</p>'}
            <h3 class="ca-h3 ca-listhead">其他人物（${others.length}）</h3>
            <div class="ca-grid">${others.map(card).join('')}</div>`;
    }

    const lockBtn = (k, locked) => `<button type="button" class="ca-lock" data-act="lock" data-k="${k}" data-locked="${locked ? 1 : 0}" title="鎖定後，AI 更新時不會改這一欄">${locked ? '🔒 已鎖定' : '🔓 AI 可更新'}</button>`;

    const tlItem = (t) => `<li class="ca-tl" data-tid="${esc(t.id)}" data-floor="${t.floor ?? ''}">
        <div class="ca-tlhead">
            <input class="ca-input ca-tltime" data-tf="time" value="${esc(t.time)}" placeholder="劇情時間（可留空）" aria-label="劇情時間">
            <span class="ca-muted">${t.floor !== null && t.floor !== undefined && t.floor !== '' ? `第 ${t.floor} 樓` : ''}</span>
            <button class="ca-link ca-danger-text" data-act="del-tl">刪除</button>
        </div>
        <textarea class="ca-input" data-tf="text" rows="2" aria-label="經歷內容">${esc(t.text)}</textarea>
    </li>`;

    function renderDetail(s, c) {
        const field = (k, label, val, rows) => `<div class="ca-field">
            <div class="ca-flabel"><label for="ca-f-${k}">${label}</label>${lockBtn(k, c.locks[k])}</div>
            <textarea id="ca-f-${k}" class="ca-input" data-f="${k}" rows="${rows}">${esc(val)}</textarea>
        </div>`;
        const mine = isMe(c);
        const linksOut = s.links.filter((l) => l.from === c.id);
        const linksIn = s.links.filter((l) => l.to === c.id);
        const viewsOut = s.views.filter((r) => r.from === c.id);
        const viewsIn = s.views.filter((r) => r.to === c.id);
        return `<div class="ca-detail" data-id="${c.id}">
            <div class="ca-detailtop">
                <button class="ca-link" data-act="back">返回人物列表</button>
                <button class="ca-btn" data-act="enrich" ${busy ? 'disabled' : ''}>${busy ? '處理中…' : '從角色卡和世界書補資料'}</button>
            </div>
            ${view.enrich && view.enrich.charId === c.id ? `<div class="ca-enrich">
                <div class="ca-banner"><div><b>補資料的結果（還沒套用）</b></div>
                <div>刪除線是目前的內容，下面是補完後的版本，可以直接修改；不要的按「不要這項」。按「套用」才會寫入，鎖住的欄位不會被改。</div></div>
                ${renderOpRows(s, view.enrich.ops, 'enrich')}
                <div class="ca-actions"><button class="ca-btn ca-primary" data-act="enrich-apply">套用</button><button class="ca-btn" data-act="enrich-cancel">取消</button></div>
            </div>` : ''}
            <div class="ca-field">
                <div class="ca-flabel"><label for="ca-f-name">名字</label><span class="ca-muted">第 ${c.firstFloor ?? '?'} 樓登場</span></div>
                <input id="ca-f-name" class="ca-input ca-nameinput" data-f="name" value="${esc(c.name)}">
            </div>
            <div class="ca-field">
                <div class="ca-flabel"><label for="ca-f-aliases">別名（用「、」分隔）</label>${lockBtn('aliases', c.locks.aliases)}</div>
                <input id="ca-f-aliases" class="ca-input" data-f="aliases" value="${esc(c.aliases.join('、'))}">
            </div>
            ${FIELDS.map(([k, l]) => field(k, l, c[k], k === 'age' ? 1 : 3)).join('')}
            <div class="ca-section">
                <h3 class="ca-h3">經歷時間軸</h3>
                <ol class="ca-timeline">${c.timeline.map(tlItem).join('')}</ol>
                <button class="ca-btn" data-act="add-tl">＋ 新增一筆經歷</button>
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">關係</h3>
                ${mine ? '<p class="ca-muted">AI 只記錄別人對主角的關係和看法。主角對別人的關係可以在「關係」分頁手動新增；主角的看法由你在劇情裡決定。</p>' : ''}
                ${linksOut.length ? `<p class="ca-sub">${esc(c.name)}對別人</p><ul class="ca-rellist">${linksOut.map((l) => `<li>對 <b>${esc(charName(s, l.to))}</b>：${esc(l.label)}</li>`).join('')}</ul>` : ''}
                ${linksIn.length ? `<p class="ca-sub">別人對${esc(c.name)}</p><ul class="ca-rellist">${linksIn.map((l) => `<li><b>${esc(charName(s, l.from))}</b>：${esc(l.label)}</li>`).join('')}</ul>` : ''}
                ${!linksOut.length && !linksIn.length ? '<p class="ca-muted">還沒有關係紀錄。</p>' : ''}
                <button class="ca-link" data-act="goto-rel" data-mode="links">到「關係」分頁編輯</button>
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">看法</h3>
                ${viewsOut.length ? `<p class="ca-sub">${esc(c.name)}怎麼看別人</p><ul class="ca-rellist">${viewsOut.map((r) => `<li>對 <b>${esc(charName(s, r.to))}</b>：${esc(r.desc)}</li>`).join('')}</ul>` : ''}
                ${viewsIn.length ? `<p class="ca-sub">別人怎麼看${esc(c.name)}</p><ul class="ca-rellist">${viewsIn.map((r) => `<li><b>${esc(charName(s, r.from))}</b>：${esc(r.desc)}</li>`).join('')}</ul>` : ''}
                ${!viewsOut.length && !viewsIn.length ? '<p class="ca-muted">還沒有看法紀錄。</p>' : ''}
                <button class="ca-link" data-act="goto-rel" data-mode="views">到「看法」編輯</button>
            </div>
            <div class="ca-actions">
                <button class="ca-btn ca-primary" data-act="save-char">儲存修改</button>
                <button class="ca-btn" data-act="toggle-me">${mine ? '取消主角' : '設為主角'}</button>
                <button class="ca-btn ca-danger" data-act="del-char">刪除這個人物</button>
            </div>
        </div>`;
    }

    function relItem(s, r, kind) {
        const isLink = kind === 'link';
        const A = charName(s, r.from);
        const B = charName(s, r.to);
        const val = isLink ? r.label : r.desc;
        return `<div class="ca-rel" data-kind="${kind}" data-rid="${r.id}" data-search="${esc((A + ' ' + B).toLowerCase())}">
            <div class="ca-relhead">
                <span class="ca-relnames">${esc(A)} → ${esc(B)}</span>
                ${lockBtn('rel', r.locked)}
            </div>
            ${isLink
                ? `<input class="ca-input" data-rf="val" value="${esc(val)}" aria-label="關係">`
                : `<textarea class="ca-input" data-rf="val" rows="2" aria-label="看法">${esc(val)}</textarea>`}
            ${r.history.length ? `<details class="ca-relhist"><summary>過去的變化（${r.history.length}）</summary><ol>${r.history.map((h) => `<li><span class="ca-muted">第 ${h.floor ?? '?'} 樓</span> ${esc(h.label ?? h.desc)}</li>`).join('')}</ol></details>` : ''}
            <div class="ca-relfoot">
                <span class="ca-muted">第 ${r.floor ?? '?'} 樓更新</span>
                <span class="ca-relbtns">
                    <button class="ca-link" data-act="save-rel">儲存</button>
                    <button class="ca-link ca-danger-text" data-act="del-rel">刪除</button>
                </span>
            </div>
        </div>`;
    }

    function renderRelations(s) {
        const chars = Object.values(s.characters).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
        const me = meChar(s);
        const mode = view.relMode === 'views' ? 'views' : 'links';
        const options = chars.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
        const fromOptions = chars.filter((c) => c !== me).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
        const seg = `<div class="ca-seg" role="tablist">
                <button class="ca-segbtn${mode === 'links' ? ' is-on' : ''}" data-act="relmode" data-mode="links">關係（${s.links.length}）</button>
                <button class="ca-segbtn${mode === 'views' ? ' is-on' : ''}" data-act="relmode" data-mode="views">看法（${s.views.length}）</button>
            </div>
            <p class="ca-muted">${mode === 'links' ? 'A 對 B 是什麼關係，例如友善、冷淡、故人之子。有方向，雙方可以不一樣。沒列出的兩人彼此陌生。' : '某個人心裡怎麼看另一個人，有方向性。'}</p>`;
        const empty = '<p class="ca-muted">還沒有。</p>';
        const filter = '<input class="ca-input ca-relfilter" type="search" data-filter placeholder="搜尋人物" aria-label="搜尋">';

        if (mode === 'links') {
            const add = chars.length >= 2 ? `<details class="ca-addrel">
                    <summary>＋ 新增一條關係</summary>
                    <div class="ca-addrow">
                        <select class="ca-input" data-new="from" aria-label="誰">${options}</select>
                        <span>→</span>
                        <select class="ca-input" data-new="to" aria-label="對誰">${options}</select>
                    </div>
                    <input class="ca-input" data-new="label" placeholder="例如：友善、冷淡、陌生、故人之子">
                    <button class="ca-btn ca-primary" data-act="add-rel" data-kind="link">新增</button>
                </details>` : '';
            const links = [...s.links].sort((a, b) => charName(s, a.from).localeCompare(charName(s, b.from), 'zh-Hant'));
            const toMe = me ? links.filter((l) => l.to === me.id) : [];
            const fromMe = me ? links.filter((l) => l.from === me.id) : [];
            const others = links.filter((l) => !me || (l.from !== me.id && l.to !== me.id));
            return `${seg}${add}${filter}
                ${me ? `<h3 class="ca-h3 ca-listhead">別人對主角（${toMe.length}）</h3>
                <div class="ca-rels">${toMe.map((l) => relItem(s, l, 'link')).join('') || empty}</div>
                <h3 class="ca-h3 ca-listhead">主角對別人（${fromMe.length}）</h3>
                <p class="ca-muted">AI 不會寫這一區，只有你手動新增的會出現在這裡。</p>
                <div class="ca-rels">${fromMe.map((l) => relItem(s, l, 'link')).join('')}</div>` : ''}
                <h3 class="ca-h3 ca-listhead">其他人之間（${others.length}）</h3>
                <div class="ca-rels">${others.map((l) => relItem(s, l, 'link')).join('') || empty}</div>`;
        }

        const add = chars.length >= 2 ? `<details class="ca-addrel">
                <summary>＋ 新增一則看法</summary>
                <div class="ca-addrow">
                    <select class="ca-input" data-new="from" aria-label="誰">${fromOptions}</select>
                    <span>→</span>
                    <select class="ca-input" data-new="to" aria-label="對誰">${options}</select>
                </div>
                <textarea class="ca-input" data-new="desc" rows="2" placeholder="例如：表面恭敬，暗中提防"></textarea>
                <button class="ca-btn ca-primary" data-act="add-rel" data-kind="view">新增</button>
            </details>` : '';
        const views = [...s.views].sort((a, b) => charName(s, a.from).localeCompare(charName(s, b.from), 'zh-Hant'));
        const toMe = me ? views.filter((r) => r.to === me.id) : [];
        const between = views.filter((r) => !me || (r.to !== me.id && r.from !== me.id));
        return `${seg}${add}${filter}
            ${me ? `<h3 class="ca-h3 ca-listhead">大家怎麼看主角（${toMe.length}）</h3>
            <div class="ca-rels">${toMe.map((r) => relItem(s, r, 'view')).join('') || empty}</div>` : ''}
            <h3 class="ca-h3 ca-listhead">其他人之間（${between.length}）</h3>
            <div class="ca-rels">${between.map((r) => relItem(s, r, 'view')).join('') || empty}</div>`;
    }

    const OP_LABEL = { 'link-add': '新關係', 'link-set': '關係改變', 'link-del': '移除關係', 'view-add': '新看法', 'view-set': '看法改變', 'view-del': '移除看法' };
    function renderPending(s) {
        const chat = ctx().chat;
        const p = s.pending;
        const intro = '<p class="ca-muted">最新那則 AI 回覆整理出來的變動會先放在這裡。每則 swipe 各有一份，左右滑動回覆時會跟著切換；送出下一則訊息時，才把目前這則的變動寫入人物檔，並在這一輪送給 AI。</p>';
        const L = chat.length - 1;
        if (!p || p.floor !== L) {
            const can = isAiMsg(chat[L]) && L > s.lastFloor;
            return `${intro}<div class="ca-empty"><p>目前沒有待確認的變動。</p>${can ? '<button class="ca-btn ca-primary" data-act="compute">整理最新這則回覆</button>' : ''}</div>`;
        }
        const m = chat[p.floor];
        const key = swipeKey(m);
        const total = Array.isArray(m?.swipes) ? m.swipes.length : 1;
        const done = Object.keys(p.swipes || {}).map((k) => Number(k) + 1).sort((a, b) => a - b);
        const ent = entryFor(p, m);
        const head = `<div class="ca-pendhead">
                <div><b>第 ${p.floor} 樓，第 ${Number(key) + 1}／${total} 則回覆</b></div>
                <div class="ca-muted">已整理過的回覆：${done.length ? done.map((n) => `第 ${n} 則`).join('、') : '還沒有'}</div>
            </div>`;
        if (!ent) return `${intro}${head}<div class="ca-empty"><p>這則回覆還沒整理。</p><button class="ca-btn ca-primary" data-act="compute">整理這則回覆</button></div>`;
        if (ent.status === 'computing') return `${intro}${head}<div class="ca-empty"><p>整理中…</p></div>`;
        if (ent.status === 'error') return `${intro}${head}<div class="ca-empty"><p>整理失敗：${esc(ent.error)}</p><button class="ca-btn ca-primary" data-act="compute">重試</button></div>`;
        const editedNote = isEdited(ent, m) ? `<div class="ca-banner">
                <div>這則回覆的內容在整理之後改過了，下面是依照修改前的內容整理的結果。要不要重新整理由你決定，不重整的話，送出下一則訊息時會照下面的內容寫入。</div>
                <div class="ca-bannerbtns"><button class="ca-btn ca-primary" data-act="compute">重新整理這則</button></div>
            </div>` : '';
        const rows = renderOpRows(s, ent.ops, 'pending');
        return `${intro}${head}${editedNote}
            ${ent.ops.length ? rows : '<div class="ca-empty"><p>這則回覆沒有人物變動。</p></div>'}
            <div class="ca-actions">
                <button class="ca-btn ca-primary" data-act="commit-now" ${ent.ops.length ? '' : 'disabled'}>現在就寫入</button>
                <button class="ca-btn" data-act="compute">重新整理這則</button>
                <button class="ca-btn ca-danger" data-act="discard">捨棄這則的變動</button>
            </div>`;
    }

    // 變動清單（待確認、補資料預覽共用）：每一項都能改內容、改對象，或不要
    function renderOpRows(s, ops, src) {
        const added = ops.filter((o) => o.op === 'add-char');
        const nameOf = (id) => {
            if (s.characters[id]) return s.characters[id].name;
            const a = added.find((o) => o.id === id);
            if (!a) return '（未知）';
            return a.mergeInto && s.characters[a.mergeInto] ? s.characters[a.mergeInto].name : `${a.char.name}（新）`;
        };
        const existing = Object.values(s.characters).sort((x, y) => x.name.localeCompare(y.name, 'zh-Hant'));
        const pick = (i, field, cur, label) => `<select class="ca-input ca-opsel" data-src="${src}" data-op="${i}" data-field="${field}" aria-label="${label}">
                ${existing.map((c) => `<option value="${c.id}"${c.id === cur ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
                ${added.filter((o) => !o.mergeInto).map((o) => `<option value="${o.id}"${o.id === cur ? ' selected' : ''}>${esc(o.char.name)}（新）</option>`).join('')}
            </select>`;
        const pair = (i, fFrom, fTo, from, to) => `<div class="ca-oppair">${pick(i, fFrom, from, '誰')}<span>→</span>${pick(i, fTo, to, '對誰')}</div>`;
        const who = (i, id) => `<div class="ca-opwho"><span class="ca-muted">對象</span>${pick(i, 'id', id, '對象')}</div>`;
        const text = (i, path, val, rows = 2) => `<textarea class="ca-input" rows="${rows}" data-src="${src}" data-op="${i}" data-path="${path}">${esc(val)}</textarea>`;
        const fieldLabel = Object.fromEntries(FIELDS);
        return ops.map((o, i) => {
            let body = '';
            if (o.op === 'add-char') {
                const c = o.char;
                const info = [c.age, c.identity, c.status].filter(Boolean).join('｜');
                body = `<div class="ca-optitle">新人物</div>
                    <input class="ca-input" data-src="${src}" data-op="${i}" data-path="char.name" value="${esc(c.name)}" aria-label="名字">
                    ${info ? `<div class="ca-muted">${esc(info)}</div>` : ''}
                    <div class="ca-opwho"><span class="ca-muted">其實是</span><select class="ca-input ca-opsel" data-src="${src}" data-op="${i}" data-field="mergeInto" aria-label="合併到既有人物">
                        <option value="">（真的是新人物）</option>
                        ${existing.map((x) => `<option value="${x.id}"${x.id === o.mergeInto ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}
                    </select></div>`;
            } else if (o.op === 'field') {
                const shrunk = ['identity', 'appearance', 'notes'].includes(o.key) && o.old && o.value.length < o.old.length * 0.6;
                body = `<div class="ca-optitle">${fieldLabel[o.key]}</div>${who(i, o.id)}${o.old ? `<div class="ca-old">${esc(clip(o.old, 300))}</div>` : ''}${shrunk ? '<div class="ca-warn">⚠ 新的內容比原本短很多，可能刪掉了原本的描述，請確認</div>' : ''}${hasCut(o.value) ? '<div class="ca-warn">⚠ 內容裡有「…」，可能是被截斷的文字，請確認後補完</div>' : ''}${text(i, 'value', o.value, o.key === 'age' ? 1 : 3)}`;
            } else if (o.op === 'alias') {
                body = `<div class="ca-optitle">新別名</div>${who(i, o.id)}<input class="ca-input" data-src="${src}" data-op="${i}" data-path="value" value="${esc(o.value)}">`;
            } else if (o.op === 'timeline') {
                body = `<div class="ca-optitle">新經歷</div>${who(i, o.id)}<input class="ca-input ca-tltime" data-src="${src}" data-op="${i}" data-path="entry.time" value="${esc(o.entry.time)}" placeholder="劇情時間（可留空）">${text(i, 'entry.text', o.entry.text)}`;
            } else if (o.op.endsWith('-add')) {
                const k = o.op === 'link-add' ? 'label' : 'desc';
                body = `<div class="ca-optitle">${OP_LABEL[o.op]}</div>${pair(i, 'item.from', 'item.to', o.item.from, o.item.to)}${text(i, `item.${k}`, o.item[k], k === 'label' ? 1 : 2)}`;
            } else if (o.op.endsWith('-set')) {
                body = `<div class="ca-optitle">${OP_LABEL[o.op]}</div>${pair(i, 'from', 'to', o.from, o.to)}<div class="ca-old">${esc(o.old)}</div>${text(i, 'value', o.value, o.op === 'link-set' ? 1 : 2)}`;
            } else if (o.op.endsWith('-del')) {
                const k = o.op === 'link-del' ? 'label' : 'desc';
                body = `<div class="ca-optitle">${OP_LABEL[o.op]}｜${esc(nameOf(o.item.from))} → ${esc(nameOf(o.item.to))}</div><div class="ca-old">${esc(o.item[k])}</div>`;
            }
            return `<div class="ca-op">${body}<div class="ca-opfoot"><button class="ca-link ca-danger-text" data-act="op-del" data-src="${src}" data-i="${i}">不要這項</button></div></div>`;
        }).join('');
    }
    function opsFor(src) {
        return src === 'enrich' ? view.enrich?.ops : currentEntry()?.ops;
    }
    // 改了「誰 → 對誰」：原本是修改某一條，就變成新增一條
    function setOpTarget(o, field, value) {
        if (field === 'mergeInto') { o.mergeInto = value || undefined; return; }
        if (field === 'id') { o.id = value; return; }
        if (field === 'item.from' || field === 'item.to') { setPath(o, field, value); return; }
        if ((field === 'from' || field === 'to') && o.op.endsWith('-set')) {
            const isLink = o.op === 'link-set';
            const key = isLink ? 'label' : 'desc';
            const from = field === 'from' ? value : o.from;
            const to = field === 'to' ? value : o.to;
            o.op = isLink ? 'link-add' : 'view-add';
            o.item = { id: uid(), from, to, [key]: o.value, floor: Math.max(0, lastFloorNow()), history: [], locked: false };
            delete o.itemId; delete o.from; delete o.to; delete o.old; delete o.value;
        }
    }

    function setPath(obj, path, val) {
        const parts = path.split('.');
        let o = obj;
        for (let i = 0; i < parts.length - 1; i++) o = o?.[parts[i]];
        if (o) o[parts[parts.length - 1]] = val;
    }
    function currentEntry() {
        const s = store();
        const p = s?.pending;
        if (!p) return null;
        return entryFor(p, ctx().chat[p.floor]);
    }

    function renderHistory(s) {
        if (!s.snapshots.length) {
            return '<div class="ca-empty"><p>還沒有任何紀錄。</p><p>每次更新或手動修改之前，這裡都會先留一份備份。</p></div>';
        }
        return `<p class="ca-muted">每一筆都是「那個動作之前」的樣子。還原時，現在的內容也會先備份起來。</p>
            <ol class="ca-hist">${[...s.snapshots].reverse().map((x) => `<li>
                <div><div>${esc(x.reason)}</div><div class="ca-muted">${new Date(x.ts).toLocaleString('zh-TW')}</div></div>
                <button class="ca-btn" data-act="restore" data-sid="${x.id}">退回到這之前</button>
            </li>`).join('')}</ol>`;
    }

    /* ---------------- 模型列表 ---------------- */
    const modelsCache = { key: '', list: [], loading: false };
    function modelOptions(q, cur) {
        const qq = norm(q);
        const list = modelsCache.list.filter((m) => !qq || norm(m.id).includes(qq) || norm(m.name).includes(qq)).slice(0, 300);
        const head = `<option value="">${list.length ? `── 選擇模型（${list.length}${list.length === 300 ? '+' : ''}）──` : '── 沒有符合的模型 ──'}</option>`;
        return head + list.map((m) => `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}>${esc(m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id)}</option>`).join('');
    }
    async function loadModels(quiet = false) {
        const st = settings();
        if (!st.baseUrl) { if (!quiet) toast('請先填 API 網址', 'warning'); return; }
        const key = `${st.baseUrl}|${st.apiKey}`;
        modelsCache.loading = true;
        if (view.tab === 'settings') softRender();
        try {
            const res = await fetch(st.baseUrl.replace(/\/+$/, '') + '/models', {
                headers: st.apiKey ? { Authorization: `Bearer ${st.apiKey}` } : {},
            });
            if (!res.ok) throw new Error(`API 回傳 ${res.status}`);
            const j = await res.json();
            const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
            const list = arr.map((m) => ({ id: String(m.id ?? ''), name: String(m.name ?? '') })).filter((m) => m.id);
            list.sort((a, b) => a.id.localeCompare(b.id));
            modelsCache.key = key;
            modelsCache.list = list;
            if (!quiet) toast(list.length ? `讀到 ${list.length} 個模型` : '這個 API 沒有回傳模型列表，請直接填模型 ID', list.length ? 'success' : 'info');
        } catch (e) {
            console.warn(LOG, e);
            if (!quiet) toast(`讀不到模型列表：${e.message}。可以直接填模型 ID`, 'warning');
        } finally {
            modelsCache.loading = false;
            if (view.tab === 'settings') softRender();
        }
    }
    function autoLoadModels() {
        const st = settings();
        if (st.apiMode !== 'custom' || !st.baseUrl || !st.apiKey || modelsCache.loading) return;
        if (modelsCache.key === `${st.baseUrl}|${st.apiKey}` && modelsCache.list.length) return;
        loadModels(true);
    }

    const INJ_FIELDS = [
        ['aliases', '別名'], ['age', '年齡'], ['identity', '身分'], ['appearance', '外貌（含外貌現況）'], ['status', '目前狀態'],
        ['notes', '備註'], ['timeline', '經歷時間軸'], ['links', '關係'], ['views', '看法'],
    ];
    function renderSettings(st) {
        const injf = { ...DEFAULTS.injFields, ...(st.injFields || {}) };
        const num = (k, label, min, max, hint = '') => `<label class="ca-set">
            <span>${label}</span>
            <input class="ca-input" type="number" min="${min}" max="${max}" data-set="${k}" value="${esc(st[k])}">
            ${hint ? `<small class="ca-muted">${hint}</small>` : ''}
        </label>`;
        return `<div class="ca-section">
                <h3 class="ca-h3">整理人物檔用的 AI</h3>
                <label class="ca-set"><span>使用哪個 API</span>
                    <select class="ca-input" data-set="apiMode">
                        ${opt('custom', '獨立 API（OpenRouter 等 OpenAI 相容端點）', st.apiMode)}
                        ${opt('main', '跟聊天用同一個 API', st.apiMode)}
                    </select>
                </label>
                ${st.apiMode === 'custom' ? `
                <label class="ca-set"><span>API 網址</span><input class="ca-input" data-set="baseUrl" value="${esc(st.baseUrl)}"></label>
                <label class="ca-set"><span>API Key</span><input class="ca-input" type="password" data-set="apiKey" value="${esc(st.apiKey)}" autocomplete="off"></label>
                <div class="ca-set"><span>模型</span>
                    <div class="ca-modelrow">
                        <input class="ca-input" data-set="model" value="${esc(st.model)}" placeholder="選下面的列表，或直接填模型 ID" aria-label="模型 ID">
                        <button class="ca-btn" data-act="load-models">${modelsCache.loading ? '讀取中…' : '讀取模型列表'}</button>
                    </div>
                    ${modelsCache.list.length ? `
                    <input class="ca-input" type="search" data-model-filter placeholder="搜尋模型（共 ${modelsCache.list.length} 個）" aria-label="搜尋模型" style="margin-top:6px">
                    <select class="ca-input ca-modelsel" data-model-pick aria-label="模型列表">${modelOptions('', st.model)}</select>` : ''}
                </div>`
                : '<p class="ca-muted">會用酒館目前連線的 API 和模型，每次整理都會多呼叫一次。</p>'}
                ${num('maxMessages', '每次最多讀幾樓', 1, 100, '第一次整理或累積很多樓時，只讀最近這麼多樓。')}
                ${num('maxTokens', '回覆長度上限（tokens）', 300, 8000)}
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">舊聊天與隱藏樓層</h3>
                <label class="ca-check"><input type="checkbox" data-set="readHidden" ${st.readHidden ? 'checked' : ''}> 整理時也讀取已隱藏的樓層</label>
                <p class="ca-muted">隱藏只是不送給主聊天 AI，內容還在聊天紀錄裡。系統訊息和註解不會讀。</p>
                ${num('backfillBatch', '整理舊樓層時，每批讀幾樓', 5, 100, '每批是一次 API 呼叫。模型上下文小的話可以調低。')}
                <button class="ca-btn" data-act="backfill">整理所有還沒整理的樓層</button>
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">看法來源</h3>
                <label class="ca-check"><input type="checkbox" data-set="readEngineViews" ${st.readEngineViews ? 'checked' : ''}> 優先使用回覆裡的 VIEWS 區塊</label>
                <p class="ca-muted">角色卡的隱藏引擎有「VIEWS｜A→B：看法（起因）」這種區塊時，看法只照它更新，不另外讓 AI 判斷；寫「無」就代表這段沒有看法變化。回覆裡沒有 VIEWS 區塊時，才由 AI 從劇情判斷。</p>
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">新人物初次建檔</h3>
                <label class="ca-check"><input type="checkbox" data-set="readSources" ${st.readSources ? 'checked' : ''}> 第一次建檔時，也讀取角色卡和世界書</label>
                <p class="ca-muted">會讀目前角色卡（群聊時是所有成員）、角色綁定的世界書、聊天世界書和全域世界書。有新人物時會多呼叫一次 API。</p>
                ${num('refMaxEntries', '每人最多參考幾條世界書', 1, 20)}
                ${num('refMaxChars', '每人參考資料字數上限', 500, 20000, '角色卡很長時，只取提到這個人的段落。')}
                <button class="ca-btn" data-act="check-sources">檢查會讀到哪些來源</button>
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">每輪送給主聊天 AI 的資料</h3>
                <label class="ca-check"><input type="checkbox" data-set="inject" ${st.inject ? 'checked' : ''}> 啟用（所有聊天的總開關）</label>
                <p class="ca-muted">只想關掉某一個聊天的話，用檔案館最上方的「送資料給 AI」切換就好。</p>
                <p class="ca-sub">對話中提到的人物，送出這些資料</p>
                <div class="ca-checkgrid">${INJ_FIELDS.map(([k, l]) => `<label class="ca-check"><input type="checkbox" data-injf="${k}" ${injf[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
                ${num('injectScan', '看最近幾樓判斷提到誰', 1, 20)}
                ${num('injectMax', '最多帶幾個人', 1, 30)}
                <p class="ca-sub">不管有沒有提到，每輪都送出</p>
                <label class="ca-check"><input type="checkbox" data-set="alwaysLinks" ${st.alwaysLinks ? 'checked' : ''}> 所有人物之間的關係</label>
                <label class="ca-check"><input type="checkbox" data-set="alwaysViews" ${st.alwaysViews ? 'checked' : ''}> 所有人物的看法</label>
                <label class="ca-check"><input type="checkbox" data-set="alwaysRoster" ${st.alwaysRoster ? 'checked' : ''}> 人物名單（名字和身分）</label>
                <p class="ca-muted">人物很多時，每輪固定送出的內容會吃比較多 token。</p>
                ${num('injectDepth', '插入深度', 0, 50, '數字越小越靠近最新訊息。')}
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">備份</h3>
                ${num('maxSnapshots', '保留幾份紀錄', 5, 200, '保留越多，聊天檔越大。')}
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">檢查被截斷的內容</h3>
                <p class="ca-muted">舊版曾經讓 AI 看到截短的摘要，有些欄位可能被存成中間帶「…」的半截文字。這裡可以找出來，打開後手動補完，或用「從角色卡和世界書補資料」補回。</p>
                <button class="ca-btn" data-act="scan-cut">找出帶「…」的欄位</button>
                ${view.cutList ? (view.cutList.length
                    ? `<ul class="ca-cutlist">${view.cutList.map((x) => `<li><button class="ca-link" data-act="open-char" data-id="${x.id}">${esc(x.name)}｜${esc(x.field)}</button><div class="ca-muted">${esc(clip(x.text, 80))}</div></li>`).join('')}</ul>`
                    : '<p class="ca-muted">沒有找到帶「…」的欄位。</p>') : ''}
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">匯入／匯出</h3>
                <p class="ca-muted">匯出這個聊天的人物、關係和看法，可以匯入到別的聊天。「合併」會保留目前的資料，同名人物只補空白的欄位；「取代」會整份換掉。匯入前都會先備份。</p>
                <div class="ca-btnrow">
                    <button class="ca-btn" data-act="export">匯出</button>
                    <button class="ca-btn" data-act="import-merge">匯入（合併）</button>
                    <button class="ca-btn" data-act="import-replace">匯入（取代）</button>
                </div>
                <input type="file" id="ca-import-file" accept=".json,application/json" hidden>
            </div>
            <div class="ca-section">
                <h3 class="ca-h3">清空</h3>
                <p class="ca-muted">會先留一份備份，之後可以從「紀錄」分頁還原。</p>
                <button class="ca-btn ca-danger" data-act="clear-all">清空這個聊天的人物檔</button>
            </div>`;
    }

    function showError(where, e) {
        console.error(LOG, where, e);
        if (!root) return;
        root.innerHTML = `<div class="ca-panel"><div class="ca-head"><div class="ca-title">人物檔案館</div><button class="ca-icon" data-act="close" aria-label="關閉">✕</button></div>
            <div class="ca-body"><p><b>畫面載入時出錯了（${esc(where)}）</b></p><p>${esc(e?.message || e)}</p><pre class="ca-err">${esc(String(e?.stack || '').slice(0, 1200))}</pre><p class="ca-muted">把這個畫面截圖給墨墨看就好。</p></div></div>`;
    }
    function render() {
        try { renderInner(); } catch (e) { showError('render', e); }
    }
    function renderInner() {
        if (!root || !root.classList.contains('open')) return;
        root.dataset.dirty = '';
        let body;
        if (view.tab === 'settings') body = renderSettings(settings());
        else if (!hasChat()) body = '<div class="ca-empty"><p>先打開一個聊天。</p><p>人物檔是跟著每個聊天分開存的。</p></div>';
        else {
            const s = store();
            if (view.tab === 'pending') body = renderPending(s);
            else if (view.tab === 'relations') body = renderRelations(s);
            else if (view.tab === 'history') body = renderHistory(s);
            else body = view.charId && s.characters[view.charId] ? renderDetail(s, s.characters[view.charId]) : renderList(s);
        }
        const scroll = root.querySelector('.ca-body')?.scrollTop ?? 0;
        root.innerHTML = shell(body);
        const b = root.querySelector('.ca-body');
        if (b && view.keepScroll) b.scrollTop = scroll;
        view.keepScroll = false;
    }
    function updateBar() {
        const w = root?.querySelector('.ca-barwrap');
        if (w) w.innerHTML = barHTML();
    }
    // 正在編輯時不重畫，避免打到一半的字被洗掉
    function softRender() {
        if (!root || !root.classList.contains('open')) return;
        if (root.dataset.dirty === '1') { updateBar(); return; }
        view.keepScroll = true;
        render();
    }
    function setBusy(v) {
        busy = v;
        if (root?.classList.contains('open')) updateBar();
    }

    /* ---------------- 介面動作 ---------------- */
    function toggleLock(btn) {
        const on = btn.dataset.locked !== '1';
        btn.dataset.locked = on ? '1' : '0';
        btn.dataset.touched = '1';
        btn.textContent = on ? '🔒 已鎖定' : '🔓 AI 可更新';
        root.dataset.dirty = '1';
    }
    // 手動改過的欄位自動上鎖；如果這次有手動切換鎖頭，就照鎖頭的狀態
    function finalLock(btn, changed, old) {
        if (!btn) return old;
        if (btn.dataset.touched === '1') return btn.dataset.locked === '1';
        return changed ? true : !!old;
    }

    async function saveChar() {
        const s = store();
        const box = root.querySelector('.ca-detail');
        const c = s?.characters[box?.dataset.id];
        if (!c) return;
        snapshot(`手動編輯：${c.name}`);
        const get = (k) => box.querySelector(`[data-f="${k}"]`)?.value.trim() ?? '';
        const lockOf = (k) => box.querySelector(`.ca-lock[data-k="${k}"]`);
        const name = get('name');
        if (name) c.name = name;
        const aliases = get('aliases').split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean);
        const aChanged = aliases.join('、') !== c.aliases.join('、');
        c.aliases = aliases;
        c.locks.aliases = finalLock(lockOf('aliases'), aChanged, c.locks.aliases);
        for (const [k] of FIELDS) {
            const v = get(k);
            const changed = v !== (c[k] || '');
            c[k] = v;
            c.locks[k] = finalLock(lockOf(k), changed, c.locks[k]);
        }
        c.timeline = [...box.querySelectorAll('.ca-tl')].map((li) => ({
            id: li.dataset.tid,
            floor: li.dataset.floor === '' ? null : Number(li.dataset.floor),
            time: li.querySelector('[data-tf="time"]').value.trim(),
            text: li.querySelector('[data-tf="text"]').value.trim(),
        })).filter((t) => t.text);
        await persist();
        refreshInjection();
        view.keepScroll = true;
        render();
        toast('已儲存');
    }

    async function addChar() {
        const s = store();
        if (!s) return;
        snapshot('新增人物');
        const c = newChar('新人物', Math.max(0, lastFloorNow()));
        s.characters[c.id] = c;
        view.tab = 'people';
        view.charId = c.id;
        await persist();
        render();
        const input = root.querySelector('[data-f="name"]');
        input?.focus();
        input?.select();
    }

    async function setMe(id) {
        const s = store();
        const c = s?.characters[id];
        if (!c) return;
        if (root?.dataset.dirty === '1' && !confirm('目前的修改還沒儲存，繼續的話這些修改會不見。要繼續嗎？')) return;
        if (isMe(c)) {
            snapshot(`取消主角：${c.name}`);
            delete c.isUser;
            c.notUser = true;
            await persist();
            refreshInjection();
            view.keepScroll = true;
            render();
            toast(`「${c.name}」不再是主角`, 'info');
            return;
        }
        const lose = [...s.views, ...s.links].filter((r) => r.from === c.id && (r.desc !== undefined || !r.manual)).length;
        if (lose && !confirm(`設為主角後，AI 不會再記錄「${c.name}」對別人的看法和關係；目前已經有的 ${lose} 條會移除（會先備份，可以從「紀錄」還原）。要繼續嗎？`)) return;
        snapshot(`設為主角：${c.name}`);
        for (const x of Object.values(s.characters)) delete x.isUser;
        delete c.notUser;
        c.isUser = true;
        noteAlias(c, userName()); // 之後 AI 用 Persona 名字稱呼時也對得上
        purgeMyViews(s);
        await persist();
        refreshInjection();
        view.keepScroll = true;
        render();
        renderChip();
        toast(`已把「${c.name}」設為主角`);
    }

    async function delChar() {
        const s = store();
        const c = s?.characters[view.charId];
        if (!c) return;
        if (!confirm(`確定刪除「${c.name}」嗎？跟他有關的關係和看法也會一起刪掉。（之後可以從「紀錄」還原）`)) return;
        snapshot(`刪除人物：${c.name}`);
        const id = c.id;
        delete s.characters[id];
        s.views = s.views.filter((r) => r.from !== id && r.to !== id);
        s.links = s.links.filter((l) => l.from !== id && l.to !== id);
        view.charId = null;
        await persist();
        refreshInjection();
        render();
        toast('已刪除');
    }

    const relTitle = (s, r) => `${charName(s, r.from)} → ${charName(s, r.to)}`;
    const relList = (s, kind) => (kind === 'link' ? s.links : s.views);

    async function saveRel(el) {
        const s = store();
        const kind = el?.dataset.kind;
        const field = kind === 'link' ? 'label' : 'desc';
        const r = s && relList(s, kind).find((x) => x.id === el.dataset.rid);
        if (!r) return;
        const val = el.querySelector('[data-rf="val"]').value.trim();
        if (!val) { toast('內容不能是空的；不要這條的話請按刪除', 'warning'); return; }
        snapshot(`手動編輯${kind === 'link' ? '關係' : '看法'}：${relTitle(s, r, kind)}`);
        const changed = val !== r[field];
        if (changed) {
            if (r[field]) r.history.push({ floor: r.floor, [field]: r[field] });
            r[field] = val;
            r.floor = Math.max(0, lastFloorNow());
        }
        r.locked = finalLock(el.querySelector('.ca-lock'), changed, r.locked);
        r.manual = true;
        await persist();
        refreshInjection();
        view.keepScroll = true;
        render();
        toast('已儲存');
    }

    async function delRel(el) {
        const s = store();
        const kind = el?.dataset.kind;
        const r = s && relList(s, kind).find((x) => x.id === el.dataset.rid);
        if (!r) return;
        const what = kind === 'link' ? '關係' : '看法';
        if (!confirm(`確定刪除「${relTitle(s, r, kind)}」這則${what}嗎？`)) return;
        snapshot(`刪除${what}：${relTitle(s, r, kind)}`);
        if (kind === 'link') s.links = s.links.filter((x) => x.id !== r.id);
        else s.views = s.views.filter((x) => x.id !== r.id);
        await persist();
        refreshInjection();
        view.keepScroll = true;
        render();
        toast('已刪除');
    }

    async function addRel(kind) {
        const s = store();
        const get = (k) => root.querySelector(`[data-new="${k}"]`)?.value.trim();
        const isLink = kind === 'link';
        const x = get('from');
        const y = get('to');
        const val = get(isLink ? 'label' : 'desc');
        const field = isLink ? 'label' : 'desc';
        if (!x || !y || x === y) { toast('請選兩個不同的人物', 'warning'); return; }
        if (!isLink && isMe(s.characters[x])) { toast('主角的看法不記錄，由你在劇情裡決定', 'warning'); return; }
        if (!val) { toast(isLink ? '請寫一下他們是什麼關係' : '請寫一下這個看法', 'warning'); return; }
        const title = `${charName(s, x)} → ${charName(s, y)}`;
        snapshot(`新增${isLink ? '關係' : '看法'}：${title}`);
        const floor = Math.max(0, lastFloorNow());
        const exist = isLink
            ? s.links.find((l) => l.from === x && l.to === y)
            : s.views.find((r) => r.from === x && r.to === y);
        if (exist) {
            if (exist[field]) exist.history.push({ floor: exist.floor, [field]: exist[field] });
            exist[field] = val;
            exist.floor = floor;
            exist.locked = true;
            exist.manual = true;
        } else if (isLink) {
            s.links.push({ id: uid(), from: x, to: y, label: val, floor, history: [], locked: true, manual: true });
        } else {
            s.views.push({ id: uid(), from: x, to: y, desc: val, floor, history: [], locked: true, manual: true });
        }
        await persist();
        refreshInjection();
        render();
        toast('已新增');
    }

    async function clearAll() {
        const s = store();
        if (!s) return;
        if (!confirm('確定清空這個聊天的人物檔嗎？（會先備份，可以從「紀錄」還原）')) return;
        snapshot('清空人物檔');
        applyState(s, { characters: {}, links: [], views: [], lastFloor: -1, log: [] });
        view.charId = null;
        await persist();
        refreshInjection();
        render();
        toast('已清空');
    }

    function onClick(e) {
        if (e.target === root) { closePanel(); return; }
        const b = e.target.closest('[data-act]');
        if (!b || !root.contains(b)) return;
        const act = b.dataset.act;
        switch (act) {
            case 'close': closePanel(); break;
            case 'tab': view.tab = b.dataset.tab; view.charId = null; render(); if (view.tab === 'settings') autoLoadModels(); break;
            case 'update': requestUpdate(); break;
            case 'undo': undo(); break;
            case 'redo': redo(); break;
            case 'compute': computePending(lastFloorNow(), 'manual'); break;
            case 'commit-now': commitPending('manual'); break;
            case 'discard': {
                const st0 = store();
                const p = st0?.pending;
                if (p) { delete p.swipes[swipeKey(ctx().chat[p.floor])]; if (!Object.keys(p.swipes).length) st0.pending = null; persist(); renderChip(); render(); toast('已捨棄這則回覆的變動'); }
                break;
            }
            case 'op-del': {
                const ops = opsFor(b.dataset.src);
                if (ops) {
                    ops.splice(Number(b.dataset.i), 1);
                    if (b.dataset.src !== 'enrich') { persist(); renderChip(); }
                    view.keepScroll = true;
                    render();
                }
                break;
            }
            case 'enrich-apply': applyEnrich(); break;
            case 'enrich-cancel': view.enrich = null; view.keepScroll = true; render(); break;
            case 'conflict-revert': resolveConflict(true); break;
            case 'conflict-keep': resolveConflict(false); break;
            case 'export': exportArchive(); break;
            case 'toggle-pause': togglePause(); break;
            case 'toggle-inject': {
                const s0 = store();
                if (!s0) break;
                s0.injectOff = !s0.injectOff;
                persist();
                refreshInjection();
                updateBar();
                toast(s0.injectOff ? '這個聊天先不送人物檔給 AI' : '這個聊天恢復送人物檔給 AI', 'info');
                break;
            }
            case 'scan-cut': {
                const st0 = store();
                const list = [];
                const labels = Object.fromEntries(FIELDS);
                for (const c of Object.values(st0?.characters || {})) {
                    for (const [k] of FIELDS) if (hasCut(c[k])) list.push({ id: c.id, name: c.name, field: labels[k], text: c[k] });
                    for (const t of c.timeline) if (hasCut(t.text)) list.push({ id: c.id, name: c.name, field: '經歷', text: t.text });
                }
                view.cutList = list;
                view.keepScroll = true;
                render();
                break;
            }
            case 'import-merge': pickImport('merge'); break;
            case 'import-replace': pickImport('replace'); break;
            case 'open-char': view.tab = 'people'; view.charId = b.dataset.id; render(); root.querySelector('.ca-body')?.scrollTo?.(0, 0); break;
            case 'back': view.charId = null; render(); break;
            case 'add-char': addChar(); break;
            case 'save-char': saveChar(); break;
            case 'del-char': delChar(); break;
            case 'toggle-me': setMe(root.querySelector('.ca-detail')?.dataset.id); break;
            case 'lock': toggleLock(b); break;
            case 'add-tl': {
                const ol = root.querySelector('.ca-timeline');
                ol?.insertAdjacentHTML('beforeend', tlItem({ id: uid(), time: '', text: '', floor: Math.max(0, lastFloorNow()) }));
                ol?.lastElementChild?.querySelector('[data-tf="text"]')?.focus();
                root.dataset.dirty = '1';
                break;
            }
            case 'del-tl': b.closest('.ca-tl')?.remove(); root.dataset.dirty = '1'; break;
            case 'save-rel': saveRel(b.closest('.ca-rel')); break;
            case 'del-rel': delRel(b.closest('.ca-rel')); break;
            case 'add-rel': addRel(b.dataset.kind); break;
            case 'relmode': view.relMode = b.dataset.mode; render(); break;
            case 'goto-rel': view.tab = 'relations'; view.relMode = b.dataset.mode; view.charId = null; render(); break;
            case 'restore': restoreTo(b.dataset.sid); break;
            case 'clear-all': clearAll(); break;
            case 'enrich': enrichOne(root.querySelector('.ca-detail')?.dataset.id); break;
            case 'check-sources': checkSources(); break;
            case 'backfill': backfill(); break;
            case 'load-models': loadModels(); break;
            case 'stop': if (progress) { progress.stop = true; updateBar(); } break;
        }
    }

    function onChange(e) {
        const t = e.target;
        if (t.id === 'ca-import-file') { importArchive(t.files?.[0]); return; }
        if (t.dataset?.op !== undefined && (t.dataset?.path || t.dataset?.field)) {
            const src = t.dataset.src || 'pending';
            const o = opsFor(src)?.[Number(t.dataset.op)];
            if (!o) return;
            if (t.dataset.field) {
                setOpTarget(o, t.dataset.field, t.value);
                view.keepScroll = true;
                render();
            } else setPath(o, t.dataset.path, t.value.trim());
            if (src !== 'enrich') { persist(); renderChip(); }
            return;
        }
        if (t.matches?.('[data-model-pick]')) {
            if (!t.value) return;
            const st = settings();
            st.model = t.value;
            saveSettings();
            const input = root.querySelector('[data-set="model"]');
            if (input) input.value = t.value;
            toast(`已選擇模型：${t.value}`);
            return;
        }
        if (t.dataset?.injf) {
            const st = settings();
            st.injFields = { ...DEFAULTS.injFields, ...(st.injFields || {}), [t.dataset.injf]: t.checked };
            saveSettings();
            refreshInjection();
            return;
        }
        const k = t.dataset?.set;
        if (!k) return;
        const st = settings();
        let v;
        if (t.type === 'checkbox') v = t.checked;
        else if (t.type === 'number') { v = Number(t.value); if (!Number.isFinite(v)) return; }
        else v = t.value.trim();
        st[k] = v;
        saveSettings();
        if (k === 'mode' || k === 'interval' || k === 'keepRecent') { updateBar(); settleCheck(); renderChip(); }
        if (k === 'apiMode') { render(); autoLoadModels(); }
        if (k === 'baseUrl' || k === 'apiKey') autoLoadModels();
        if (k.startsWith('inject') || k.startsWith('always')) refreshInjection();
    }

    function onInput(e) {
        const t = e.target;
        if (t.matches('[data-model-filter]')) {
            const sel = root.querySelector('[data-model-pick]');
            if (sel) sel.innerHTML = modelOptions(t.value, settings().model);
            return;
        }
        if (t.matches('[data-filter]')) {
            const q = norm(t.value);
            root.querySelectorAll('.ca-body [data-search]').forEach((el) => {
                el.hidden = !!q && !el.dataset.search.includes(q);
            });
            return;
        }
        if (t.closest('.ca-detail, .ca-rel, .ca-addrel, .ca-op')) root.dataset.dirty = '1';
    }

    function onKey(e) {
        if (e.key === 'Escape' && root?.classList.contains('open')) closePanel();
    }

    function openPanel() {
        try { openPanelInner(); } catch (e) {
            toast(`打不開檔案館：${e.message}`, 'error');
            showError('open', e);
        }
    }
    function openPanelInner() {
        if (!root) {
            root = document.createElement('div');
            root.id = 'ca-root';
            document.body.appendChild(root);
            root.addEventListener('click', onClick);
            root.addEventListener('change', onChange);
            root.addEventListener('input', onInput);
            document.addEventListener('keydown', onKey);
        }
        root.classList.add('open');
        root.innerHTML = '<div class="ca-panel"><div class="ca-body"><p class="ca-muted">載入中…</p></div></div>';
        fitToScreen();
        render();
        cleanMyViews().catch((e) => console.warn(LOG, e)).finally(render);
    }
    // 直接用視窗大小撐滿；如果還是被父層壓扁，就改掛到 <html> 底下
    function fitToScreen() {
        if (!root || !root.classList.contains('open')) return;
        const w = window.innerWidth || document.documentElement.clientWidth;
        const h = window.innerHeight || document.documentElement.clientHeight;
        root.style.setProperty('width', `${w}px`, 'important');
        root.style.setProperty('height', `${h}px`, 'important');
        const r = root.getBoundingClientRect();
        if ((r.height < h * 0.5 || r.top < -5 || r.top > 5) && root.parentNode !== document.documentElement) {
            console.warn(LOG, '面板被壓扁，改掛到 html 底下', r);
            document.documentElement.appendChild(root);
        }
    }

    function closePanel() {
        root?.classList.remove('open');
    }

    function addMenuButton() {
        const menu = document.getElementById('extensionsMenu');
        if (!menu || document.getElementById('ca_menu_btn')) return;
        const el = document.createElement('div');
        el.id = 'ca_menu_btn';
        el.className = 'list-group-item flex-container flexGap5';
        el.innerHTML = '<div class="fa-solid fa-address-book extensionsMenuExtensionButton"></div><span>人物檔案館</span>';
        el.addEventListener('click', openPanel);
        menu.appendChild(el);
    }
    function addSettingsDrawer() {
        const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!host || document.getElementById('ca_settings_drawer')) return;
        const el = document.createElement('div');
        el.id = 'ca_settings_drawer';
        el.innerHTML = `<div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>人物檔案館</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="menu_button" id="ca_open_btn">開啟人物檔案館</div>
                <small>API、更新頻率等設定都在檔案館裡的「設定」分頁。</small>
            </div>
        </div>`;
        host.appendChild(el);
        el.querySelector('#ca_open_btn').addEventListener('click', openPanel);
    }

    /* ---------------- 啟動 ---------------- */
    function init() {
        const c = ctx();
        const es = c.eventSource;
        const et = c.eventTypes || c.event_types;
        settings();
        const on = (name, fn) => { if (et[name]) es.on(et[name], fn); };
        on('MESSAGE_RECEIVED', onMessageReceived);
        on('MESSAGE_SENT', onMessageSent);
        on('MESSAGE_SWIPED', async () => { await verify(); softRender(); renderChipLater(); });
        on('MESSAGE_DELETED', async () => { await verify(); softRender(); renderChipLater(); });
        on('MESSAGE_EDITED', () => { renderChipLater(); softRender(); });
        on('MESSAGE_UPDATED', renderChipLater);
        on('CHARACTER_MESSAGE_RENDERED', renderChipLater);
        on('MORE_MESSAGES_LOADED', renderChipLater);
        on('CHAT_CHANGED', async () => {
            view.charId = null;
            view.enrich = null;
            render();
            if (!(await waitChatReady())) return;
            await restorePending();
            await verify();
            await cleanMyViews();
            refreshInjection();
            render();
            setTimeout(renderChip, 400);
        });
        window.addEventListener('resize', fitToScreen);
        window.visualViewport?.addEventListener('resize', fitToScreen);
        addMenuButton();
        addSettingsDrawer();
        refreshInjection();
        setTimeout(renderChip, 500);
        console.log(LOG, 'v0.7.10 loaded');
    }

    jQuery(() => {
        try { init(); } catch (e) { console.error(LOG, '啟動失敗', e); toast(`人物檔案館啟動失敗：${e.message}`, 'error'); }
    });
})();
