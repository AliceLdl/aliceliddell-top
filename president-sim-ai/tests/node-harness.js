/* ============================================================================
   tests/node-harness.js — 不依赖浏览器的集成测试
   ----------------------------------------------------------------------------
   用法：node tests/node-harness.js
   它用一个假的引擎（G / UI / 常量 / applyFx / log …）把 ai/ 下的模块跑起来，
   验证：上下文快照、提示词组装、JSON 解析、限幅与预算、结算管线、叙事账本、
   舆论场（单家版面 + 信息流）、离线兜底、HTML 生成、函数覆写、页内自检。

   另一项 tests/contract.js 会去 index.html 里核对「我用到的每个引擎符号
   是否真的存在」，防止改名或拼错导致运行期 ReferenceError。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const AI_DIR = path.join(ROOT, 'ai');

/* ---------------- 假引擎 ---------------- */
const G = {
  y: 2004, w: 14, phase: 'presidency', ap: 6, apMax: 8,
  pres: {
    name: '乔治·W·布什', party: 'R', appr: 52.4, terms: 1, honeymoon: 6,
    isPlayer: true, iss: [-2, -3, 4, 4, 3, 2, 6, 1, 4, 3, 2, 2, 1, 3, -2]
  },
  player: { name: '乔治·W·布什', party: 'R', pc: 30, home: 'TX' },
  econ: { gdp: 2.9, unemp: 5.6, infl: 2.3, sp: 1080, debt: 7.4, def: 3.5,
          conf: 54, fuel: 1.8, fedRate: 1.75 },
  caucus: { h: { D: 205, R: 230 }, s: { D: 48, R: 52 } },
  factions: { D: { prog: 50, labor: 50, est: 50, mod: 50 },
              R: { est: 62, soc: 55, fiscal: 48, pop: 40 } },
  corps: { energy: 61, defense: 66, finance: 58, tech: 46, pharma: 63, agri: 55,
           auto: 50, media: 52, realty: 54, laborU: 44, guns: 60, insur: 58, unionT: 45 },
  world: { CN: -10, RU: -22, GB: 80, FR: 62, DE: 66, JP: 78, KR: 72, KP: -60,
           IR: -72, MX: 46, CA: 82, IL: 78, SA: 60, IN: 52, EU: 64, TW: 44 },
  tension: 34, div: 41, log: [], passed: [], failed: [], drafts: [], pendingEvents: [],
  activeBill: null, platform: { published: true, issues: { econ: 5, health: 5, hawk: 10 } },
  crises: [], shocks: {}, flags: {}, stats: { billsSigned: 2, votesWon: 10 },
  history: [], aiLog: [], terms: {}, se: {
    PA: { mood: 2, gdp: 2.4, unemp: 5.1 }, OH: { mood: -1, gdp: 1.9, unemp: 6.0 }
  },
  general: null, campaign: { funds: 40, energy: 100, momentum: 1, visits: {}, ground: 0 }
};
const UI = { tab: 'main', modal: null, selCrisis: null };
const COUNTRIES = [
  { id: 'CN', cn: '中国', rel0: -10, att: '对手' }, { id: 'RU', cn: '俄罗斯', rel0: -25, att: '对手' },
  { id: 'GB', cn: '英国', rel0: 80, att: '盟友' }, { id: 'IR', cn: '伊朗', rel0: -72, att: '敌国' }
];
const STATES = [
  { id: 'PA', cn: '宾夕法尼亚' }, { id: 'OH', cn: '俄亥俄' }, { id: 'TX', cn: '德克萨斯' }
];
const STATE_BY_ID = {}; STATES.forEach(s => { STATE_BY_ID[s.id] = s; });
const SECTORS = [
  { id: 'energy', cn: '能源与石油' }, { id: 'defense', cn: '军工复合体' },
  { id: 'pharma', cn: '制药与医疗保险' }
];
const ISSUES = [
  { k: 'econ', cn: '经济与税收' }, { k: 'health', cn: '医疗' }, { k: 'hawk', cn: '外交' }
];
const FACTIONS = { D: [{ id: 'prog', cn: '进步派' }], R: [{ id: 'est', cn: '建制派' }, { id: 'pop', cn: '民粹右翼' }] };
const MONTHS_CN = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
const ERA_SHOCKS = { fin2008: { cn: '金融危机' } };

const applied = [];
function applyFx(fx, ctx) {
  applied.push({ fx, ctx });
  if (fx.appr && G.pres) G.pres.appr = Math.max(3, Math.min(95, G.pres.appr + fx.appr));
  if (fx.tension) G.tension = Math.max(0, Math.min(100, G.tension + fx.tension));
  if (fx.rel) for (const k in fx.rel) if (G.world[k] != null) G.world[k] += fx.rel[k];
  if (fx.corp) for (const k in fx.corp) G.corps[k] = (G.corps[k] || 50) + fx.corp[k];
  if (fx.pc && G.player) G.player.pc += fx.pc;
}
const logs = [];
function log(t, c) { logs.push({ t, c }); G.log.push({ y: G.y, w: G.w, t, c: c || '' }); }
let rendered = 0;
function render() { rendered++; }
function ensureCamp() { return G.campaign; }
function campStatAdd(d) {
  const defs = { nameRec: 0, enthusiasm: 0, groundGame: 0, adSpend: 0, endorseScore: 0,
                 debateScore: 0, scandalHeat: 0, oppoStock: 0 };
  for (const k in d) if (k in defs) G.campaign[k] = (G.campaign[k] || 0) + d[k];
}
function campStatGet(k) {
  if (k === 'groundGame') return G.campaign.ground || 0;
  return G.campaign[k] || 0;
}
function stateLift(id, gdp, unemp, mood) {
  const s = G.se[id]; if (!s) return;
  if (mood) s.mood += mood;
}
function makeCustomBill(spec) {
  return { id: 'cb_test', cn: spec.name, i: spec.dir || 0, topic: spec.topics || [],
           d: spec.desc || '', pop: 50, custom: true, weeksLeft: 6 };
}
function playerIsPresident() { return !!(G.pres && G.pres.isPlayer); }
function dateLabel(y, w) { return y + '年三月第2周'; }
function h(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function isCampaignMode() { return G.phase === 'primary' || G.phase === 'general'; }
function showToast() {}
function actionFail() {}
function monthOfWeek(w) { return 2; }
function evTextNow(e) { return (e && e.t) || ''; }
function shockScore() { return 0.4; }
function activeCrisis() { return null; }
function crisisDef() { return null; }
function absWeek() { return G.y * 52 + G.w; }

/* 原版入口的替身（覆写测试用） */
function presActionsPane() { return '<div class="card">原版战情室</div>'; }
function camp2ActionsHTML() { return '<div>原版竞选行动</div>'; }
function pendingEventCard() { return '<div class="card">原版事件卡</div>'; }
function shockEvModalPane() { return '<div class="modal">原版冲击</div>'; }
function crisisPane() { return '<div class="card">原版危机</div>'; }
function modalHTML() { return '<div class="modal">原版弹窗</div>'; }
function gearBtnHTML() { return '<button class="btn sm">⚙</button>'; }
function mainPane() { return '原版主面板'; }
function topbar() {
  return '<div class="topbar"><div class="tabs">' +
    '<div class="tab" onclick="setTab(\'main\')">总览</div>' +
    '<div class="tab advance" onclick="doAdvance()">▶ 进入下一周</div></div></div>';
}
function setTab(t) { UI.tab = t; render(); }
function doAdvance() { G.w++; render(); }
function fireEvent(ev) { log('event:' + (ev && ev.cn), ''); }

/* ---------------- 沙箱 ---------------- */
const sandbox = {
  console,
  UI, COUNTRIES, STATES, STATE_BY_ID, SECTORS, ISSUES, FACTIONS, MONTHS_CN, ERA_SHOCKS,
  applyFx, log, render, ensureCamp, campStatAdd, campStatGet, stateLift,
  makeCustomBill, playerIsPresident, dateLabel, h, isCampaignMode, showToast,
  actionFail, monthOfWeek, evTextNow, shockScore, activeCrisis, crisisDef, absWeek,
  presActionsPane, camp2ActionsHTML, pendingEventCard, shockEvModalPane, crisisPane,
  modalHTML, gearBtnHTML, mainPane, topbar, setTab, doAdvance, fireEvent,
  localStorage: (function () {
    const m = {};
    return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); },
             removeItem: k => { delete m[k]; }, clear: () => { for (const k in m) delete m[k]; } };
  })(),
  document: { readyState: 'complete', head: { appendChild() {} }, body: { appendChild() {} },
              getElementById: () => null, createElement: () => ({ style: {}, textContent: '' }),
              addEventListener() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  AbortController: typeof AbortController !== 'undefined' ? AbortController : undefined,
  fetch: undefined,
  location: { search: '' },
  Promise, Date, Math, JSON, Number, String, Array, Object, Error, RegExp, isFinite
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

/* 让沙箱里的 G / UI / 常量成为全局词法绑定（与原版脚本一致） */
const bootSrc = 'let G = window.__G_STUB__;\nlet UI = window.__UI_STUB__;\n' +
  'const COUNTRIES=window.__C_STUB__, STATES=window.__S_STUB__, STATE_BY_ID=window.__SB_STUB__;' +
  'const SECTORS=window.__SEC_STUB__, ISSUES=window.__ISS_STUB__, FACTIONS=window.__FAC_STUB__;' +
  'const MONTHS_CN=window.__M_STUB__, ERA_SHOCKS=window.__ES_STUB__;';
sandbox.__G_STUB__ = G; sandbox.__UI_STUB__ = UI;
sandbox.__C_STUB__ = COUNTRIES; sandbox.__S_STUB__ = STATES; sandbox.__SB_STUB__ = STATE_BY_ID;
sandbox.__SEC_STUB__ = SECTORS; sandbox.__ISS_STUB__ = ISSUES; sandbox.__FAC_STUB__ = FACTIONS;
sandbox.__M_STUB__ = MONTHS_CN; sandbox.__ES_STUB__ = ERA_SHOCKS;
vm.runInContext(bootSrc, sandbox, { filename: 'engine-stub.js' });

/* ---------------- 加载扩展层 ---------------- */
const FILES = ['ai-glue.js', 'ai-config.js', 'ai-ledger.js', 'ai-press.js', 'ai-prompt.js',
               'ai-context.js', 'ai-client.js', 'ai-adjudicate.js', 'ai-ui.js',
               'ai-press-ui.js', 'ai-hooks.js', 'ai-selftest.js'];
for (const f of FILES) {
  const code = fs.readFileSync(path.join(AI_DIR, f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
}

/* ---------------- 断言工具 ---------------- */
let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r === false) throw new Error('返回 false');
    if (r && r.ok === false) throw new Error(r.info || 'ok=false');
    pass++;
    console.log('  ✓ ' + name + (r && r.info ? '  —  ' + r.info : ''));
  } catch (e) {
    fail++;
    failures.push({ name, err: e && e.message ? e.message : String(e) });
    console.log('  ✗ ' + name + '  —  ' + (e && e.message ? e.message : e));
  }
}
const W = sandbox;
const A = W.AI, PROMPT = W.AIPROMPT, CTX = W.AICTX, CLI = W.AICLIENT,
      ADJ = W.AIADJ, AIUI = W.AIUI, HOOKS = W.AIHOOKS, AIG = W.AIG, LED = W.AILEDGER,
      PRESS = W.AIPRESS, PRESS_UI = W.AIPRESS_UI;

console.log('\n=== 总统模拟器 · AI 版 / Node 集成测试 ===\n');

/* 1. 模块与取数 */
console.log('[1] 模块加载');
t('十二个模块全部挂载', () => {
  const need = ['AI', 'AIPROMPT', 'AICTX', 'AICLIENT', 'AIADJ', 'AIUI', 'AIHOOKS',
                'AISELFTEST', 'AIG', 'AILEDGER', 'AIPRESS', 'AIPRESS_UI'];
  const miss = need.filter(k => !W[k]);
  if (miss.length) throw new Error('缺少 ' + miss.join(','));
  return { info: 'OK' };
});
t('AIG 能取到引擎对象', () => {
  if (AIG.g() !== G) throw new Error('G 取错');
  if (AIG.ui() !== UI) throw new Error('UI 取错');
  if (AIG.countries().length !== 4) throw new Error('国家表取错');
  return { info: 'G/UI/COUNTRIES 全对' };
});
t('配置默认值与持久化', () => {
  if (!W.AICFG) throw new Error('AICFG 未初始化');
  if (W.AICFG.provider !== 'openai') throw new Error('默认 provider 异常');
  A.set({ temperature: 0.5, model: 'x-test' });
  const raw = W.localStorage.getItem('psim.ai.cfg.v1');
  if (!raw || JSON.parse(raw).model !== 'x-test') throw new Error('未写入 localStorage');
  A.set({ temperature: 0.75, model: 'deepseek-chat' });
  return { info: '读写正常' };
});

/* 2. 上下文 */
console.log('\n[2] 局势快照');
t('standard 快照结构完整', () => {
  const o = CTX.snapshot('national', {});
  const keys = Object.keys(o);
  ['时间', '阶段', '你', '经济', '政治'].forEach(k => {
    if (!(k in o)) throw new Error('缺少 ' + k);
  });
  if (!o['政治'].国会 || !o['政治'].国会.house) throw new Error('缺国会');
  if (o['你'].支持率 !== 52.4) throw new Error('支持率取值错误：' + o['你'].支持率);
  return { info: keys.join('/') + ' · ' + JSON.stringify(o).length + ' 字' };
});
t('lite 更短、deep 更长', () => {
  A.set({ contextLevel: 'lite' });
  const lite = CTX.text('national');
  A.set({ contextLevel: 'deep' });
  const deep = CTX.text('national');
  A.set({ contextLevel: 'standard' });
  const std = CTX.text('national');
  if (!(lite.length < std.length && std.length < deep.length)) {
    throw new Error('长度未递增 ' + lite.length + '/' + std.length + '/' + deep.length);
  }
  return { info: lite.length + ' < ' + std.length + ' < ' + deep.length };
});
t('竞选模式带民调与竞选数值', () => {
  G.phase = 'general';
  G.general = { natMargin: 1.8, poll: { PA: -1.2, OH: 2.4 }, myParty: 'R',
                oppParty: 'D', opp: { name: '约翰·克里', momentum: 1 },
                camp: { funds: 40, energy: 90, momentum: 1.1, visits: {} } };
  const o = CTX.snapshot('campaign', {});
  G.phase = 'presidency'; G.general = null;
  if (!o['竞选'] || !o['民调']) throw new Error('缺竞选/民调');
  if (o['民调'].national !== 1.8) throw new Error('民调值错误');
  return { info: JSON.stringify(o['民调']).slice(0, 90) };
});

/* 3. 提示词 */
console.log('\n[3] 提示词');
t('系统提示词覆盖关键规则', () => {
  const s = PROMPT.system();
  const must = ['裁决引擎', '数值字段', 'ok:false', '幅度基准', '只输出一个 JSON 对象', 'relations', 'sectors', '叙事账本'];
  const miss = must.filter(m => s.indexOf(m) < 0);
  if (miss.length) throw new Error('缺少 ' + miss.join(','));
  return { info: s.length + ' 字 ≈ ' + CTX.estimateTokens(s) + ' token' };
});
t('八种任务模板都能组装', () => {
  const modes = ['national', 'campaign', 'event', 'shock', 'crisis', 'maintain', 'press', 'press_outlet'];
  const info = [];
  for (const m of modes) {
    const task = PROMPT.task(m);
    if (!task || task.length < 40) throw new Error(m + ' 模板缺失');
    info.push(m + '=' + task.length);
  }
  return { info: info.join(' ') };
});
t('提示词覆写与恢复默认', () => {
  A.set({ promptOverrides: { system: '自定义系统提示' } });
  if (PROMPT.system().indexOf('自定义系统提示') !== 0) throw new Error('覆写未生效');
  A.set({ promptOverrides: {} });
  if (PROMPT.system().indexOf('裁决引擎') < 0) throw new Error('恢复默认失败');
  return { info: 'OK' };
});

/* 4. JSON 解析 */
console.log('\n[4] 接口客户端');
t('宽松 JSON 解析 7 个用例', () => {
  const cases = [
    '```json\n{"ok":true}\n```',
    '前面废话\n{"ok":true,"a":1}\n后面废话',
    '{"ok":true,}',
    '{"ok":true,"nested":{"x":[1,2,{"y":"}"}]}}',
    '{ "ok" : true , "text" : "含 } 和 { 的字符串" }',
    '{"ok":true, // 模型照着提示词写的注释\n "a":1}',
    '/* 前言 */ {"ok":true}'
  ];
  for (const s of cases) {
    const o = CLI.extractJson(s);
    if (!o || o.ok !== true) throw new Error('失败用例：' + s.slice(0, 24));
  }
  return { info: cases.length + '/7' };
});
t('非法输入抛错', () => {
  let threw = false;
  try { CLI.extractJson('完全不是 JSON'); } catch (e) { threw = true; }
  if (!threw) throw new Error('应当抛错');
  return { info: 'OK' };
});
t('请求体 / 端点按协议生成', () => {
  A.set({ provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: 'k' });
  if (CLI.endpointFor() !== 'https://api.example.com/v1/chat/completions') {
    throw new Error('openai 端点 ' + CLI.endpointFor());
  }
  A.set({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'c1' });
  if (CLI.endpointFor() !== 'https://api.anthropic.com/v1/messages') throw new Error('anthropic 端点错误');
  A.set({ provider: 'gemini', baseUrl: 'https://g.example.com/v1beta', model: 'g1', apiKey: 'k' });
  if (!/models\/g1:generateContent\?key=k$/.test(CLI.endpointFor())) {
    throw new Error('gemini 端点 ' + CLI.endpointFor());
  }
  A.set({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' });
  return { info: 'openai / anthropic / gemini 均正确' };
});

/* 5. 校验与限幅 */
console.log('\n[5] 归一化与限幅');
t('越界值被夹到上限', () => {
  const n = ADJ.normalize({ ok: true, apCost: 99, effects: { approval: 999, gdp: -9, tension: 100 } }, 'national');
  if (n.apCost !== 3) throw new Error('apCost 未限幅：' + n.apCost);
  if (Math.abs(n.fx.appr) > 6) throw new Error('approval 未限幅：' + n.fx.appr);
  if (Math.abs(n.fx.gdp) > 0.3) throw new Error('gdp 未限幅：' + n.fx.gdp);
  if (Math.abs(n.fx.tension) > 12) throw new Error('tension 未限幅：' + n.fx.tension);
  return { info: 'apCost=' + n.apCost + ' appr=' + n.fx.appr + ' gdp=' + n.fx.gdp };
});
t('字符串数字被强制转成 number', () => {
  const n = ADJ.normalize({ ok: true, effects: { gdp: '0.12', approval: '-1.5' } }, 'national');
  if (typeof n.fx.gdp !== 'number' || n.fx.gdp !== 0.12) throw new Error('gdp 未转换');
  if (n.fx.appr !== -1.5) throw new Error('appr 未转换');
  return { info: 'OK' };
});
t('未知国家/行业被丢弃', () => {
  const n = ADJ.normalize({ ok: true, effects: { relations: { ZZ: -5, CN: -4 }, sectors: { nope: 3, energy: 2 } } }, 'national');
  if (n.rel.ZZ !== undefined) throw new Error('未知国家未丢弃');
  if (n.corp.nope !== undefined) throw new Error('未知行业未丢弃');
  if (n.rel.CN !== -4 || n.corp.energy !== 2) throw new Error('已知键被误删');
  return { info: 'rel=' + JSON.stringify(n.rel) + ' corp=' + JSON.stringify(n.corp) };
});
t('非法法案主题回落 + 方向限幅', () => {
  const n = ADJ.normalize({ ok: true, bill: { title: '法案', topic: '胡说', direction: 50 } }, 'national');
  if (!n.bill || n.bill.topic !== '经济税收') throw new Error('主题未回落');
  if (n.bill.dir !== 10) throw new Error('方向未限幅：' + n.bill.dir);
  return { info: n.bill.topic + ' / dir=' + n.bill.dir };
});
t('拒绝时清空所有数值', () => {
  const n = ADJ.normalize({ ok: false, rejectReason: '越权', effects: { approval: 5 }, apCost: 2 }, 'national');
  if (n.ok !== false) throw new Error('ok 应为 false');
  if (Object.keys(n.fx).length || n.apCost !== 0) throw new Error('拒绝后仍带数值');
  return { info: n.rejectReason };
});
t('总量预算会缩放', () => {
  let scaled = 0;
  for (let i = 0; i < 30; i++) {
    const raw = { ok: true, apCost: 1, effects: {
      approval: 6, gdp: 0.3, unemployment: -0.3, inflation: 0.2, confidence: 6,
      stock: 6, tension: 12, division: 5, politicalCapital: 8, deficit: 0.3,
      relations: { CN: -15, RU: -15 }, sectors: { energy: 10, defense: 10 } } };
    const n = ADJ.gate(ADJ.normalize(raw, 'national'));
    if ((n.notes || []).some(x => /缩放/.test(x))) scaled++;
  }
  if (scaled === 0) throw new Error('30 次都没有触发缩放，预算逻辑可能失效');
  return { info: scaled + '/30 次触发（有随机扰动，比例合理）' };
});

/* 6. 结算 */
console.log('\n[6] 结算管线');
t('数值进入引擎并被记录', () => {
  const before = G.pres.appr, apBefore = G.ap;
  applied.length = 0; logs.length = 0;
  const raw = { ok: true, headline: '全国讲话', narrative: '你在椭圆形办公室发表讲话。',
    apCost: 1, difficulty: 0, risk: 'low',
    effects: { approval: 2, gdp: 0.1, tension: 2, division: 1,
               relations: { CN: -4 }, sectors: { energy: 3 } },
    bill: { title: '测试法案', topic: '医疗', direction: -3, summary: '测试' },
    flags: ['speech_done'], followup: '下一步' };
  const n = ADJ.gate(ADJ.normalize(raw, 'national'));
  const s = ADJ.apply(n, 'national', { input: '测试', source: 'ai' });
  if (!s.ok) throw new Error('结算失败');
  if (G.ap !== apBefore - 1) throw new Error('行动点未扣：' + G.ap);
  if (!(G.pres.appr > before)) throw new Error('支持率未上升');
  if (!applied.length) throw new Error('applyFx 未被调用');
  if (!G.drafts.some(d => d.bill.cn === '测试法案')) throw new Error('法案未入起草队列');
  if (!G.flags.ai_speech_done) throw new Error('flag 未写入');
  if (!G.aiLog.length) throw new Error('未写入 aiLog');
  if (!logs.length) throw new Error('未写日志');
  return { info: 'AP ' + apBefore + '→' + G.ap + ' appr ' + before + '→' + G.pres.appr +
    ' 法案《' + s.bill + '》 chips=' + s.chips.length };
});
t('拒绝时不扣 AP、不写数值', () => {
  const apBefore = G.ap;
  const n = ADJ.normalize({ ok: false, rejectReason: '总统无权直接命令美联储' }, 'national');
  const s = ADJ.apply(n, 'national', { input: '命令美联储降息', source: 'ai' });
  if (s.ok) throw new Error('应标记失败');
  if (G.ap !== apBefore) throw new Error('拒绝却扣了行动点');
  return { info: s.rejectReason };
});
t('竞选数值走 applyCampFx 同款口径', () => {
  const raw = { ok: true, apCost: 1, campaign: {
    momentum: 0.1, funds: -12, energy: -8,
    stats: { nameRec: 1.2, enthusiasm: 0.5 }, visits: { PA: 2 }, stateLift: { PA: 1.5 } } };
  const fundsBefore = G.campaign.funds;
  const n = ADJ.gate(ADJ.normalize(raw, 'campaign'));
  ADJ.apply(n, 'campaign', { input: '集会', source: 'ai' });
  if (!(G.campaign.funds < fundsBefore)) throw new Error('资金未扣');
  if (!(G.campaign.visits.PA > 0)) throw new Error('州投入未记录');
  if (!(G.campaign.momentum > 1)) throw new Error('势头未上涨');
  return { info: 'funds→' + G.campaign.funds + ' visits.PA=' + G.campaign.visits.PA };
});
t('离线兜底能识别制裁 → 关系下降', () => {
  const r = ADJ.offline('national', '宣布对中国实施新一轮制裁与出口管制');
  const n = r.norm;
  if (!n.ok || !(n.rel.CN < 0) || !(n.fx.tension > 0)) {
    throw new Error('离线结果不合理 rel=' + JSON.stringify(n.rel) + ' tension=' + n.fx.tension);
  }
  return { info: 'rel.CN=' + n.rel.CN + ' tension=' + n.fx.tension };
});
t('离线兜底覆盖竞选模式', () => {
  const r = ADJ.offline('campaign', '在宾夕法尼亚连跑三场工会集会并投放电视广告');
  if (!r.norm.campaign) throw new Error('未产出竞选数值');
  return { info: 'momentum=' + r.norm.campaign.momentum + ' funds=' + r.norm.campaign.funds };
});

/* 6b. 叙事账本 */
console.log('\n[6b] 叙事账本（双层记忆）');
const LEDGER_FIXTURE = {
  summary: '白宫对伊朗加压',
  actions: [{ t: '宣布对伊朗新一轮制裁', outcome: '伊朗召见美国大使', tags: ['外交'] }],
  external: [{ t: '伊朗试射中程导弹', impact: '油价单日上行' }],
  commitments: [{ t: '两周内向国会提交追加制裁清单', due: '两周后', status: 'pending' }],
  actors: [{ who: '参议院多数党领袖', stance: '从观望转为支持' }],
  risks: ['伊朗可能以封锁海峡回应'],
  dossier: {
    facts: ['制裁清单在公布前已被财政部泄露给媒体'],
    chains: ['封锁海峡 → 油价跳升 → 通胀反弹 → 支持率下滑'],
    agendas: [{ who: '国防部长', goal: '扩大中东驻军', method: '渲染海峡威胁' }],
    ticking: [{ t: '泄密文件将在三周内见报', due: '3周内', effect: '政府公信力受损' }],
    notes: ['这个玩家偏好用军事手段解决外交问题']
  }
};

t('裁决把两层账都写进去', () => {
  LED.reset();
  const raw = { ok: true, headline: '对伊朗加压', narrative: '测试。', apCost: 1,
    effects: { approval: -0.5, tension: 3 }, ledger: LEDGER_FIXTURE };
  const n = ADJ.gate(ADJ.normalize(raw, 'national'));
  const s = ADJ.apply(n, 'national', { input: '制裁伊朗', source: 'ai' });
  const w = G.aiWorld;
  if (!w) throw new Error('G.aiWorld 未创建');
  if (s.ledger.added < 5) throw new Error('落账条数太少：' + s.ledger.added);
  if (w.brief.summary !== LEDGER_FIXTURE.summary) throw new Error('摘要没写进去');
  if (w.brief.actions.length !== 1) throw new Error('行动没写进去');
  if (!/W\d+/.test(w.brief.actions[0].w)) throw new Error('行动缺周次戳：' + w.brief.actions[0].w);
  if (w.brief.external.length !== 1) throw new Error('外部事件没写进去');
  if (w.dossier.facts.length !== 1) throw new Error('隐藏事实没写进去');
  if (!w.dossier.ticking.length) throw new Error('定时后果没写进去');
  if (!/玩家偏好/.test(w.dossier.notes[0].t)) throw new Error('笔记没写进去');
  return { info: '行动 ' + w.brief.actions.length + ' / 外部 ' + w.brief.external.length +
    ' / 事实 ' + w.dossier.facts.length + ' / 定时 ' + w.dossier.ticking.length };
});
t('同一条不重复记账', () => {
  const before = G.aiWorld.brief.actions.length;
  LED.applyDelta(LEDGER_FIXTURE, { mode: 'national' });
  LED.applyDelta(LEDGER_FIXTURE, { mode: 'national' });
  if (G.aiWorld.brief.actions.length !== before) {
    throw new Error('重复写入没有被去重：' + before + ' -> ' + G.aiWorld.brief.actions.length);
  }
  return { info: '仍是 ' + before + ' 条' };
});
t('账本有硬上限', () => {
  for (let i = 0; i < 40; i++) {
    LED.applyDelta({ actions: [{ t: '第 ' + i + ' 号命令：在' + i + '州投放资源' }],
                     external: [{ t: '第 ' + i + ' 号外部事件' }] }, { mode: 'national' });
  }
  const st = LED.stats();
  if (st.actions > LED.CAP.actions) throw new Error('行动超上限：' + st.actions);
  if (st.external > LED.CAP.external) throw new Error('外部事件超上限：' + st.external);
  return { info: '行动 ' + st.actions + '/' + LED.CAP.actions + '，外部 ' + st.external + '/' + LED.CAP.external };
});
t('引擎事件自动入账（不花 token）', () => {
  const before = LED.stats().external;
  LED.noteExternal({ cn: '飓风登陆', t: '四级飓风在路易斯安那登陆，州长请求联邦支援。' });
  const after = LED.stats().external;
  if (after !== Math.min(before + 1, LED.CAP.external) && after !== before) {
    throw new Error('未入账');
  }
  const hit = G.aiWorld.brief.external.some(x => /飓风登陆/.test(x.t));
  if (!hit) throw new Error('事件文本没进简报');
  return { info: '外部事件 ' + after + ' 条' };
});
t('提示词里同时出现简报与内部档案', () => {
  A.set({ ledgerInPrompt: true });
  const p = PROMPT.build('national', CTX.text('national'), '测试指令', {});
  if (p.user.indexOf('【态势简报') < 0) throw new Error('缺简报段');
  if (p.user.indexOf('【内部档案') < 0) throw new Error('缺内部档案段');
  if (p.user.indexOf('已被财政部泄露') < 0) throw new Error('隐藏事实没进提示词');
  A.set({ ledgerInPrompt: false });
  const p2 = PROMPT.build('national', CTX.text('national'), '测试指令', {});
  if (p2.user.indexOf('【内部档案') >= 0) throw new Error('关掉开关后仍在喂账本');
  A.set({ ledgerInPrompt: true });
  return { info: '开=有、关=无' };
});
t('整理：重写两份账并清零计数', () => {
  const before = LED.stats();
  const ok = LED.applyMaintenance({
    brief: { summary: '整理后的摘要', situation: ['局势 A'], actions: [
      { w: '2004·W10', t: '保留的旧行动', outcome: '结果' },
      { w: '2004·W14', t: '最新行动', outcome: '结果' }],
      external: [{ w: '2004·W13', t: '合并后的外部事件', impact: '影响' }],
      commitments: [], actors: [], risks: ['风险 A'] },
    dossier: { facts: [{ w: '2004·W10', t: '一条隐藏事实' }], chains: [], agendas: [],
      ticking: [{ w: '2004·W13', t: '一颗雷', due: '2周内', effect: '爆' }],
      profile: { style: '强硬', weaknesses: ['不耐拖'], base: '保守派' }, notes: [] }
  });
  const after = LED.stats();
  if (!ok) throw new Error('整理未生效');
  if (G.aiWorld.brief.summary !== '整理后的摘要') throw new Error('摘要未替换');
  if (after.actions !== 2) throw new Error('行动条数不对：' + after.actions);
  if (after.sinceMaintain !== 0) throw new Error('整理计数没清零');
  if (G.aiWorld.dossier.profile.style !== '强硬') throw new Error('玩家画像没写入');
  return { info: '整理前 ' + before.actions + ' 条 → 整理后 ' + after.actions + ' 条' };
});
t('整理结果结构不对时不清空账本', () => {
  LED.reset();
  LED.applyDelta({ summary: '保留我', actions: [{ t: '保留行动' }] }, {});
  const before = LED.stats();
  const ok = LED.applyMaintenance({ ok: true, headline: '这其实是一份裁决，不是账本' });
  const after = LED.stats();
  if (ok) throw new Error('错误结构竟然被接受');
  if (after.actions !== before.actions) throw new Error('账本被清空了：' + before.actions + ' -> ' + after.actions);
  return { info: '已拒绝并保留 ' + after.actions + ' 条' };
});
t('本地压缩可去重（离线兜底）', () => {
  LED.reset();
  LED.applyDelta({ actions: [{ t: '同一句话' }] }, {});
  LED.applyDelta({ actions: [{ t: '同一句话' }] }, {});
  LED.applyDelta({ actions: [{ t: '另一句话' }] }, {});
  LED.localCompact();
  const st = LED.stats();
  if (st.actions !== 2) throw new Error('压缩后条数不对：' + st.actions);
  return { info: '3 次写入 → ' + st.actions + ' 条' };
});
t('拒绝只写内部档案、不写简报', () => {
  LED.reset();
  const raw = { ok: false, rejectReason: '总统无权直接命令美联储',
    ledger: { dossier: { facts: ['总统曾试图直接命令美联储降息'] } } };
  const n = ADJ.normalize(raw, 'national');
  ADJ.apply(n, 'national', { input: '命令美联储', source: 'ai' });
  if (G.aiWorld.brief.actions.length !== 0) throw new Error('拒绝却写了公开简报');
  if (!G.aiWorld.dossier.facts.length) throw new Error('拒绝没写内部档案');
  return { info: '公开 0 条 / 内部 ' + G.aiWorld.dossier.facts.length + ' 条' };
});

/* 6c. 舆论场 */
console.log('\n[6c] 舆论场（媒体版面 + 民间信息流）');
t('平台随年代切换：论坛 → Facebook → Twitter → X', () => {
  const seq = [[2002, 'forum'], [2007, 'facebook'], [2015, 'twitter'], [2026, 'x']];
  const got = seq.map(x => PRESS.platformOf(x[0]).id);
  if (JSON.stringify(got) !== JSON.stringify(seq.map(x => x[1]))) {
    throw new Error('平台序列错误：' + got.join(' → '));
  }
  return { info: got.join(' → ') };
});
t('媒体名单随年代增减且带立场', () => {
  const r2004 = PRESS.roster(2004).map(o => o.cn);
  const r2020 = PRESS.roster(2020).map(o => o.cn);
  if (r2004.indexOf('政治报') >= 0) throw new Error('2004 不该有政治报');
  if (r2020.indexOf('政治报') < 0) throw new Error('2020 应有政治报');
  const noSlant = PRESS.roster(2020).filter(o => !o.slant);
  if (noSlant.length) throw new Error('有媒体缺立场');
  return { info: '2004: ' + r2004.length + ' 家 / 2020: ' + r2020.length + ' 家' };
});
t('兼容入口：media 数组写成 outlets，feed 写成信息流', () => {
  PRESS.reset();
  const ok = PRESS.apply({
    summary: '民意分裂',
    media: [
      { outlet: '纽约时报', headline: '白宫的药价豪赌', take: '编辑部认为行政令的法律基础薄弱。', tone: 'criticize', focus: '政策' },
      { outlet: '福克斯新闻', headline: '总统终于对药企动手', take: '主播称这是迟来的胜利。', tone: 'support', focus: '国内' }
    ],
    feed: { platform: 'forum', posts: [
      { name: 'mike_1985', handle: 'mike', loc: 'OH', stance: 'oppose',
        text: '油价又涨了，白宫还在谈药价。', likes: 999999, reposts: 50, replies: 12, views: 99999999, time: '1小时前' },
      { name: 'sarah', handle: '@sarah', loc: 'PA', stance: '支持', text: '至少有人在做实事。', likes: 10 }
    ] }
  });
  const s = G.aiPress;
  if (!ok) throw new Error('apply 返回 false');
  const names = Object.keys(s.outlets);
  if (names.length !== 2) throw new Error('媒体家数不对：' + names.join(','));
  if (!s.outlets['纽约时报'].sections.length) throw new Error('旧条目没有兜底板块');
  if (s.outlets['纽约时报'].sections[0].k !== 'lead') throw new Error('兜底板块不是头条');
  if (s.posts.length !== 2) throw new Error('发言条数不对：' + s.posts.length);
  if (s.platform !== 'forum') throw new Error('平台未按年代落定：' + s.platform);
  if (s.posts[0].likes !== 0) throw new Error('论坛不该有点赞，却被写成 ' + s.posts[0].likes);
  if (s.posts[1].stance !== 'support') throw new Error('中文立场未归一化：' + s.posts[1].stance);
  if (s.posts[1].handle.charAt(0) !== '@') throw new Error('handle 未补 @');
  if (s.mood.oppose !== 1 || s.mood.support !== 1) throw new Error('倾向统计错误：' + JSON.stringify(s.mood));
  if (s.mood.mock !== undefined) throw new Error('嘲讽不该再是独立类别');
  return { info: '媒体 ' + names.length + ' 家 / 发言 ' + s.posts.length + ' 条' };
});
t('单家整版：六个板块按序归一化', () => {
  PRESS.reset();
  const raw = {
    outlet: '纽约时报', tone: 'criticize', focus: '政策', slogan: 'All the News',
    sections: [
      { k: 'opinion', items: [{ h: '社论：代价被藏起来了', p: '账单迟早要有人付。' }] },
      { k: 'lead', items: [{ h: '白宫的药价豪赌', p: '诉讼可能拖上数年。' }, { h: '第二条', p: '补充报道。' }] },
      { k: 'domestic', items: [{ h: '州长们开始抱怨', p: '联邦承诺没有配套资金。' }] },
      { k: 'economy', items: [{ h: '药价上限吓退投资', p: '社论版警告创新外流。' }] },
      { k: 'world', items: [{ h: '盟友在观望', p: '欧洲各国要求说明。' }] },
      { k: 'policy', items: [{ h: '行政令的法律风险', p: '司法部内部评估不乐观。' }] },
      { k: 'bogus', items: [{ h: '不存在的板块', p: '应被丢弃。' }] }
    ]
  };
  if (!PRESS.applyOutlet(raw, '纽约时报', 'ai')) throw new Error('applyOutlet 失败');
  const o = G.aiPress.outlets['纽约时报'];
  const keys = o.sections.map(x => x.k);
  if (keys.join(',') !== 'lead,domestic,economy,world,policy,opinion') {
    throw new Error('板块顺序不对：' + keys.join(','));
  }
  if (keys.indexOf('bogus') >= 0) throw new Error('未知板块没被丢弃');
  if (o.sections[0].items.length !== 2) throw new Error('头条条目数不对');
  if (o.name !== '纽约时报' || o.tone !== 'criticize') throw new Error('抬头字段丢失');
  if (G.aiPress.selected !== '纽约时报') throw new Error('选中媒体没落到这家');
  return { info: '板块 ' + keys.length + ' 个，头条 ' + o.sections[0].items.length + ' 条' };
});
t('嘲讽并入反对（数据与统计）', () => {
  PRESS.reset();
  PRESS.apply({
    feed: { posts: [
      { name: 'a', handle: 'a', loc: 'OH', stance: 'mock', text: '一定是隔壁州的错。' },
      { name: 'b', handle: 'b', loc: 'PA', stance: '嘲讽', text: '又来一个“史上最”。' },
      { name: 'c', handle: 'c', loc: 'TX', stance: 'neutral', text: '我只想知道油价。' }
    ] }
  });
  const s = G.aiPress;
  if (s.posts[0].stance !== 'oppose' || s.posts[1].stance !== 'oppose') {
    throw new Error('嘲讽未并入反对：' + s.posts.map(p => p.stance).join(','));
  }
  if (s.mood.oppose !== 2 || s.mood.mock !== undefined) {
    throw new Error('统计未合并：' + JSON.stringify(s.mood));
  }
  s.mood.mock = 3;
  s.posts.push({ stance: 'mock', text: '旧数据' });
  const s2 = PRESS.ensure();
  if (s2.mood.mock !== undefined || s2.mood.oppose !== 5) {
    throw new Error('旧存档未迁移：' + JSON.stringify(s2.mood));
  }
  if (s2.posts[s2.posts.length - 1].stance !== 'oppose') throw new Error('旧帖子未迁移');
  return { info: '反对 ' + s2.mood.oppose + ' 条，无 mock 字段' };
});
t('旧存档（media 数组）迁移成 outlets', () => {
  G.aiPress = {
    v: 1, week: '2004·W10', abs: 2004 * 52 + 10, updatedAt: 'x', year: 2004,
    platform: 'forum', posts: [], mood: { support: 1, oppose: 0, neutral: 0, mock: 2 },
    media: [{ outlet: '华尔街日报', headline: '旧标题', take: '旧正文', tone: 'support', slant: 'conservative' }],
    source: 'ai', summary: ''
  };
  const s = PRESS.ensure();
  if (s.media !== undefined) throw new Error('旧 media 字段没清掉');
  if (!s.outlets['华尔街日报']) throw new Error('旧条目没迁移');
  if (s.outlets['华尔街日报'].sections[0].items[0].h !== '旧标题') throw new Error('旧标题丢失');
  if (s.mood.mock !== undefined || s.mood.oppose !== 2) throw new Error('旧倾向没迁移');
  return { info: '迁移 1 家，oppose=' + s.mood.oppose };
});
t('离线生成：整周信息流 + 八家整版', () => {
  PRESS.reset();
  const s = PRESS.offline();
  if (!s || !s.posts.length) throw new Error('离线没产出信息流');
  const names = Object.keys(s.outlets);
  if (names.length < 8) throw new Error('离线媒体不足 8 家：' + names.length);
  const o = s.outlets[names[0]];
  if (o.sections.length !== 6) throw new Error('离线版面板块数不对：' + o.sections.length);
  if (o.source !== 'offline') throw new Error('离线版面来源标记错误');
  if (s.posts.some(p => p.stance === 'mock')) throw new Error('离线还在产出 mock');
  const st = new Set(s.posts.map(p => p.stance));
  if (!st.has('support') || !st.has('oppose')) throw new Error('立场不够分散：' + Array.from(st).join(','));
  return { info: '媒体 ' + names.length + ' 家 / 发言 ' + s.posts.length + ' 条 / 板块 ' + o.sections.length };
});
t('舆论面板：一次只显示一家，下拉切换', () => {
  G.y = 2015;
  PRESS.reset();
  PRESS.applyOutlet({
    outlet: '纽约时报', tone: 'neutral', focus: '国内',
    sections: [{ k: 'lead', items: [{ h: 'H1', p: 'T1' }] }]
  }, '纽约时报', 'ai');
  PRESS.applyOutlet({
    outlet: '福克斯新闻', tone: 'support', focus: '国内',
    sections: [{ k: 'lead', items: [{ h: 'H2', p: 'T2' }] }]
  }, '福克斯新闻', 'ai');
  PRESS.applyFeed({ feed: { platform: 'twitter', posts: [{ name: 'Amy', handle: '@amy', loc: 'MI', stance: 'mock', text: '又来了。' }] } }, 'ai');
  const p = G.aiPress;
  p.selected = '纽约时报';
  const html = PRESS_UI.paneHTML();
  if (html.indexOf('aip-feed twitter') < 0) throw new Error('缺 twitter 皮肤');
  if (html.indexOf('aip-paper') < 0) throw new Error('缺报纸版面');
  if (html.indexOf('纽约时报') < 0) throw new Error('缺当前媒体名');
  if (html.indexOf('H2') >= 0) throw new Error('同时渲染了别家的内容');
  if (html.split('<div class="aip-paper">').length !== 2) throw new Error('版面上出现了不止一家');
  if (html.indexOf('<select') < 0) throw new Error('缺媒体下拉栏');
  const html2 = PRESS_UI.paperHTML(p.outlets['福克斯新闻']);
  if (html2.indexOf('福克斯新闻') < 0 || html2.indexOf('H2') < 0) throw new Error('切到另一家后内容不对');
  if (html.indexOf('class="stance"') >= 0) throw new Error('还在给帖子贴立场标签');
  if (html.indexOf('嘲讽') >= 0) throw new Error('还残留嘲讽字样');
  if (html.indexOf('平台特征') >= 0) throw new Error('还残留平台说明');
  if (html.indexOf('AI 虚构') >= 0) throw new Error('还残留免责介绍');
  if (html.indexOf('媒体与网民都是 AI') >= 0) throw new Error('还残留顶部介绍句');
  G.y = 2004;
  return { info: '单家版面 ' + html.length + ' 字符，下拉选项 ' + (html.match(/<option/g) || []).length + ' 个' };
});
t('生成请求：单家版面与信息流分开', () => {
  G.y = 2015;
  LED.reset();
  LED.applyDelta({ actions: [{ t: '签署药价上限行政令', outcome: '药企起诉' }] }, { mode: 'national' });
  PRESS.applyOutlet({
    outlet: '纽约时报', tone: 'criticize', focus: '政策',
    sections: [{ k: 'lead', items: [{ h: '上一期标题', p: '正文' }] }]
  }, '纽约时报', 'ai');
  const req = PRESS.buildOutletRequest('纽约时报');
  if (req.user.indexOf('【本期媒体】纽约时报') < 0) throw new Error('缺媒体身份');
  if (req.user.indexOf('press_outlet') < 0) throw new Error('缺 press_outlet 任务模板');
  if (req.user.indexOf('签署药价上限行政令') < 0) throw new Error('缺最近行动');
  if (req.user.indexOf('上一期已用过的标题') < 0) throw new Error('缺上一期标题去重');
  if (req.user.indexOf('上一期标题') < 0) throw new Error('上一期标题没带进去');
  if (!/编辑室/.test(req.system)) throw new Error('系统提示词缺任务限定');
  const feed = PRESS.buildFeedRequest();
  if (feed.user.indexOf('【民间平台】') < 0) throw new Error('信息流请求缺平台');
  if (feed.user.indexOf('【本期媒体】') >= 0) throw new Error('信息流请求混进了媒体版面');
  G.y = 2004;
  return { info: '版面 ' + req.user.length + ' 字符 / 信息流 ' + feed.user.length + ' 字符' };
});
t('过期判定与自动更新配置', () => {
  G.y = 2015; G.w = 20;
  PRESS.applyOutlet({ outlet: '纽约时报', sections: [{ k: 'lead', items: [{ h: 'x', p: 'y' }] }] }, '纽约时报', 'ai');
  const fresh = PRESS.stale();
  G.w = 30;
  const old = PRESS.stale();
  G.w = 14; G.y = 2004;
  if (fresh) throw new Error('刚生成就判过期');
  if (!old) throw new Error('过了 10 周仍判新鲜');
  if (typeof W.AICFG.pressEvery !== 'number' || typeof W.AICFG.pressPosts !== 'number') {
    throw new Error('缺少舆论配置项');
  }
  return { info: 'pressEvery=' + W.AICFG.pressEvery + ' pressPosts=' + W.AICFG.pressPosts };
});
t('舆论数据可随存档序列化', () => {
  const json = JSON.stringify(G.aiPress);
  const back = JSON.parse(json);
  if (!back.outlets || !back.posts || !back.mood || !back.order) throw new Error('序列化丢字段');
  return { info: json.length + ' 字节' };
});

/* 7. 界面 */
console.log('\n[7] 界面');
t('战情室 HTML 含输入框与提交', () => {
  const html = AIUI.nationalConsoleHTML();
  if (html.indexOf('<textarea') < 0) throw new Error('无输入框');
  if (html.indexOf("AIUI.submit('national')") < 0) throw new Error('无提交按钮');
  if (html.indexOf('行动点') < 0) throw new Error('无行动点提示');
  return { info: html.length + ' 字符' };
});
t('竞选行动台 HTML', () => {
  const html = AIUI.campaignConsoleHTML();
  if (html.indexOf("AIUI.submit('campaign')") < 0) throw new Error('无提交按钮');
  return { info: html.length + ' 字符' };
});
t('事件卡与事件弹窗 HTML', () => {
  G.pendingEvents = [{ ev: { cn: '突发', t: '发生了什么', ch: [{ t: '选项一', fx: { appr: 1 } }] }, txt: '发生了什么' }];
  const card = AIUI.eventCardHTML(G.pendingEvents[0]);
  const modal = AIUI.eventModalHTML(G.pendingEvents[0]);
  G.pendingEvents = [];
  if (card.indexOf("AIUI.submit('decision')") < 0) throw new Error('卡片无提交');
  if (modal.indexOf('BREAKING') < 0) throw new Error('弹窗缺 BREAKING');
  return { info: card.length + ' / ' + modal.length };
});
t('四个设置页均可渲染', () => {
  const sizes = [];
  for (const tab of ['api', 'prompt', 'play', 'status']) {
    AIUI.state.tab = tab;
    const h = AIUI.settingsHTML();
    if (!h || h.length < 300) throw new Error(tab + ' 页过短');
    sizes.push(tab + ':' + h.length);
  }
  AIUI.state.tab = 'api';
  return { info: sizes.join(' ') };
});
t('档案面板可渲染', () => {
  const h = AIUI.historyHTML();
  if (h.indexOf('裁决档案') < 0) throw new Error('缺标题');
  return { info: h.length + ' 字符' };
});

/* 8. 覆写 */
console.log('\n[8] 引擎覆写');
t('install 后入口被替换', () => {
  HOOKS.install();
  const diffs = ['presActionsPane', 'camp2ActionsHTML', 'pendingEventCard',
                 'shockEvModalPane', 'crisisPane', 'modalHTML', 'gearBtnHTML',
                 'mainPane', 'topbar', 'setTab', 'doAdvance', 'fireEvent']
    .filter(k => typeof W[k] === 'function' && W[k] !== W.AIORIG[k]);
  if (diffs.length < 12) throw new Error('只替换了 ' + diffs.length + ' 个：' + diffs.join(','));
  return { info: diffs.length + ' 个：' + diffs.join(',') };
});
t('AI 关闭时回退到原版', () => {
  A.set({ enabled: false });
  G.pendingEvents = [{ ev: { cn: 'x', t: 'y', ch: [] }, txt: 'y' }];
  const h = W.presActionsPane();
  A.set({ enabled: true });
  G.pendingEvents = [];
  if (h !== W.AIORIG.presActionsPane()) throw new Error('未回退到原版');
  return { info: '回退正常' };
});
t('modalHTML 接管 AI 弹窗', () => {
  UI.modal = { type: 'aiset' };
  const h1 = W.modalHTML();
  UI.modal = { type: 'aihist' };
  const h2 = W.modalHTML();
  UI.modal = null;
  if (h1.indexOf('AI 设置') < 0) throw new Error('设置弹窗未接管');
  if (h2.indexOf('裁决档案') < 0) throw new Error('档案弹窗未接管');
  return { info: 'OK' };
});
t('顶栏加出「舆论」标签，主面板可切换', () => {
  UI.tab = 'main';
  const bar = W.topbar();
  if (bar.indexOf("setTab('opinion')") < 0) throw new Error('顶栏没有舆论标签');
  PRESS.offline();
  W.setTab('opinion');
  const pane = W.mainPane();
  if (pane.indexOf('aip-paper') < 0) throw new Error('切到舆论后主面板没换成舆论页');
  UI.tab = 'main';
  if (W.mainPane() !== '原版主面板') throw new Error('离开舆论后没有回退');
  return { info: 'OK' };
});
t('提交入口已挂到 AIUI', () => {
  if (typeof AIUI.submit !== 'function') throw new Error('AIUI.submit 缺失');
  return { info: 'OK' };
});

/* 9. 自检脚本 */
console.log('\n[9] 页内自检脚本');
t('AISELFTEST 可用', () => {
  if (typeof W.AISELFTEST.run !== 'function') throw new Error('未导出 run');
  return { info: 'OK（浏览器里打开 ?selftest=1 可跑）' };
});
t('页内自检全部通过（同一套断言）', () => {
  const r = W.AISELFTEST.run();
  if (!r || !r.total) throw new Error('未返回结果');
  if (r.fail) {
    throw new Error('失败 ' + r.fail + '：' +
      r.results.filter(x => !x.ok).map(x => x.name + '（' + x.info + '）').join('； '));
  }
  return { info: r.pass + '/' + r.total };
});

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  - ' + f.name + '：' + f.err));
  process.exit(1);
}
