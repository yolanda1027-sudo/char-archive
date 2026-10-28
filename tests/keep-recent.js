// 模擬測試：設定「留最近 1 則回覆不整理」時，自動整理只寫入比較舊的樓層
// 用法：在 char-archive 資料夾執行 node tests/keep-recent.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const handlers = {};
const md = {};
const chat = [
    { name: '喃', is_user: true, mes: '你好', send_date: 'd0' },
    { name: '旁白', mes: '海格推開門。', send_date: 'd1', gen_finished: 'g1', swipe_id: 0, swipes: ['x'] },
];
const settings = { charArchive: { apiMode: 'main', mode: 'every', keepRecent: 1, readSources: false } };
const calls = [];

async function generateRaw({ prompt }) {
    calls.push(prompt);
    return JSON.stringify({ characters: [{ name: '海格', first_floor: 1, identity: '鑰匙管理員' }], relations: [], views: [] });
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
            setExtensionPrompt() {},
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
    // 第一則回覆：被保留，不整理
    await handlers.received();
    await sleep(500);
    const s = md.char_archive;
    check(calls.length === 0 && !s.pending && s.lastFloor === -1, '只有一則回覆時不整理');

    // 使用者送出、AI 再回一則：第 1 樓變舊了，整理到第 1 樓為止
    chat.push({ name: '喃', is_user: true, mes: '謝謝你', send_date: 'd2' });
    await handlers.sent();
    chat.push({ name: '旁白', mes: '海格點點頭。', send_date: 'd3', gen_finished: 'g3', swipe_id: 0, swipes: ['y'] });
    await handlers.received();
    await sleep(500);
    check(calls.length === 1, '新回覆進來後整理一次');
    check(s.lastFloor === 1, '只整理到前一則回覆（第 1 樓）');
    check(!s.pending, '最新一則沒有產生待確認');
    check(!/第3樓/.test(calls[0]) && /第1樓/.test(calls[0]), '送給 AI 的內容不含被保留的樓層');
    check(Object.values(s.characters).some((c) => c.name === '海格'), '舊樓層的人物已寫入');

    // 重新生成最新一則（swipe）：不會再呼叫 API
    chat[3] = { ...chat[3], mes: '海格搖搖頭。', swipe_id: 1, swipes: ['y', 'z'], gen_finished: 'g4' };
    await handlers.received();
    await sleep(500);
    check(calls.length === 1, '重新生成最新一則不會重複整理');

    console.log(failed ? `\n${failed} 項沒通過` : '\n全部通過');
    process.exitCode = failed ? 1 : 0;
})();
