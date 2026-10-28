// 不開酒館也能跑的模擬測試：收到 AI 回覆 → 產生待確認 → 使用者送出 → 寫入人物檔
// 用法：在 char-archive 資料夾執行 node tests/mock-run.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const handlers = {};
const md = {};
const chat = [
    { name: '喃', is_user: true, mes: '你好', send_date: 'd0' },
    { name: '旁白', mes: '海格推開門，對喃笑了笑。\nVIEWS｜海格→喃：覺得她很勇敢（她敢一個人走夜路）', send_date: 'd1', gen_finished: new Date(), swipe_id: 0, swipes: ['x'] },
];
let injected = '';
let lastSystemPrompt = '';
const settings = { charArchive: { apiMode: 'main', mode: 'every', readSources: false } };

// 假的 LLM：照需要改這裡的回傳內容來測不同情況
async function generateRaw({ systemPrompt }) {
    lastSystemPrompt = systemPrompt;
    return JSON.stringify({
        characters: [
            { name: '海格', first_floor: 1, identity: '霍格華茲鑰匙管理員', appearanceNow: '鬍子上沾著雨水' },
            { name: '喃·波特', notes: '主角的備註不該被 AI 寫入' },
        ],
        relations: [
            { from: '海格', to: '喃·波特', label: '友善' },
            { from: '喃·波特', to: '海格', label: 'AI 不該寫主角對別人的關係' },
        ],
        views: [],
    });
}

const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
    document: { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    confirm: () => true,
    toastr: { success: (m) => console.log('  [提示]', m), info: (m) => console.log('  [提示]', m), warning: (m) => console.log('  [警告]', m), error: (m) => console.log('  [錯誤]', m) },
    jQuery: (f) => f(),
    SillyTavern: {
        getContext: () => ({
            chat, chatMetadata: md, getCurrentChatId: () => 'test-chat', name1: '喃',
            extensionSettings: settings, saveSettingsDebounced() {}, saveMetadata: async () => {},
            eventSource: { on: (t, f) => { handlers[t] = f; } },
            eventTypes: { MESSAGE_RECEIVED: 'received', MESSAGE_SENT: 'sent', MESSAGE_SWIPED: 'swiped', MESSAGE_DELETED: 'deleted', CHAT_CHANGED: 'changed' },
            setExtensionPrompt: (k, v) => { injected = v; },
            characters: [],
            generateRaw,
        }),
    },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8'), sandbox);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failed++; };

(async () => {
    await handlers.received();
    await sleep(500);
    const s = md.char_archive;
    const ent = s.pending?.swipes?.['0'];
    check(ent?.status === 'ready', '收到回覆後產生待確認');
    check(s.lastFloor === -1, '待確認還沒寫入人物檔');

    chat.push({ name: '喃', is_user: true, mes: '謝謝你', send_date: 'd2' });
    await handlers.sent();
    const name = (id) => s.characters[id]?.name;
    const me = Object.values(s.characters).find((c) => c.isUser);
    check(s.pending === null && s.lastFloor === 1, '送出訊息後寫入人物檔');
    check(me?.name === '喃·波特', '「喃」認得出「喃·波特」是主角');
    check(!me?.notes, 'AI 沒有寫主角的備註');
    check(!s.links.some((l) => l.from === me?.id), 'AI 沒有寫主角對別人的關係');
    check(s.links.some((l) => name(l.from) === '海格' && l.label === '友善'), '別人對主角的關係有記錄');
    check(s.views.some((v) => name(v.from) === '海格' && v.desc.startsWith('覺得她很勇敢')), '看法取自回覆裡的 VIEWS 區塊');
    check(/VIEWS 區塊提供/.test(lastSystemPrompt), '有 VIEWS 時提示詞不讓 AI 另外判斷看法');
    check(injected.includes('海格'), '人物檔有送給主聊天 AI');

    console.log(failed ? `\n${failed} 項沒通過` : '\n全部通過');
    process.exitCode = failed ? 1 : 0;
})();
