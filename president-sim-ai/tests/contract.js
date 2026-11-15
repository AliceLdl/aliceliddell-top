/* ============================================================================
   tests/contract.js — 与原版引擎的「接口契约」静态核对
   ----------------------------------------------------------------------------
   用法：node tests/contract.js
   扩展层大量调用原版引擎的函数与常量。原版是单文件、无模块导出，任何一次
   重构或改名都会让扩展层在运行期才炸。这个脚本把「扩展层依赖的每个符号」
   拿出来，到 index.html 里逐个确认真实存在，并检查关键 G 字段是否在
   newGame() 里初始化过。
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* 扩展层通过 window.* / 裸标识符调用的引擎函数 */
const FUNCS = [
  'applyFx', 'log', 'render', 'ensureCamp', 'campStatAdd', 'campStatGet',
  'stateLift', 'makeCustomBill', 'playerIsPresident', 'dateLabel', 'h',
  'isCampaignMode', 'showToast', 'actionFail', 'monthOfWeek', 'evTextNow',
  'shockScore', 'activeCrisis', 'crisisDef', 'absWeek', '_shockResolve',
  'econPressure', 'cleanHist', 'crisisOnCooldown', 'fxHint', 'chooseEvent',
  'crisisDefer', 'openSettings', 'submitCustomBill', 'applyCampFx',
  'crisisPickNext', 'crisisSetEvent', 'crisisCurrentEvent', 'crisisNodeOf',
  'crisisFollowUpText', 'shockModalFlush', 'render',
  'campaignPane2', 'actionButtons', 'gearBtnHTML', 'pendingEventCard', 'fireEvent',
  'mainPane', 'topbar', 'setTab', 'doAdvance'
];

/* 扩展层读取的顶层 const / let（AIG 胶水层） */
const DATA = [
  ['G', /\blet G = null/],
  ['UI', /const UI = \{/],
  ['COUNTRIES', /const COUNTRIES = \[/],
  ['STATES', /const STATES = \[/],
  ['STATE_BY_ID', /const STATE_BY_ID = \{\}/],
  ['SECTORS', /const SECTORS = \[/],
  ['ISSUES', /const ISSUES = \[/],
  ['FACTIONS', /const FACTIONS = \{/],
  ['MONTHS_CN', /const MONTHS_CN = \[/],
  ['ERA_SHOCKS', /ERA_SHOCKS/]
];

/* 扩展层写入/读取的 G 字段（应出现在 newGame 里） */
const GFIELDS = ['y', 'w', 'phase', 'ap', 'apMax', 'pres', 'player', 'econ', 'caucus',
  'factions', 'corps', 'world', 'tension', 'div', 'log', 'pendingEvents', 'drafts',
  'activeBill', 'crises', 'flags', 'stats', 'history'];
/* 惰性初始化的字段：newGame 里没有，由引擎在用到时创建，读的时候必须判空 */
const LAZY_FIELDS = [['platform', /function ensurePlatform|G\.platform = G\.platform/],
                     ['shocks', /G\.shocks = G\.shocks \|\| \{\}|G\.shocks = \{/]];

let fail = 0;

function hasFunc(name) {
  const patterns = [
    new RegExp('function\\s+' + name.replace('$', '\\$') + '\\s*\\('),
    new RegExp('window\\.' + name + '\\s*=\\s*function'),
    new RegExp('const\\s+' + name + '\\s*=\\s*(function|\\()')
  ];
  return patterns.some(p => p.test(HTML));
}

console.log('\n=== 引擎接口契约核对 ===\n');
console.log('[1] 函数符号');
for (const f of FUNCS) {
  if (hasFunc(f)) {
    console.log('  ✓ ' + f);
  } else {
    console.log('  ✗ ' + f + ' —— 原版里找不到定义');
    fail++;
  }
}

console.log('\n[2] 数据符号');
for (const [name, re] of DATA) {
  if (re.test(HTML)) console.log('  ✓ ' + name);
  else { console.log('  ✗ ' + name + ' —— 找不到'); fail++; }
}

console.log('\n[3] newGame() 字段');
const ng = HTML.match(/function newGame\(\)\{[\s\S]*?\n\}/);
if (!ng) { console.log('  ✗ 找不到 newGame()'); fail++; }
else {
  for (const k of GFIELDS) {
    const re = new RegExp('\\b' + k + '\\s*:');
    if (re.test(ng[0])) console.log('  ✓ ' + k);
    else { console.log('  ✗ ' + k + ' —— newGame 未初始化'); fail++; }
  }
  console.log('\n[3b] 惰性字段（扩展层已按缺失处理）');
  for (const [k, re] of LAZY_FIELDS) {
    if (re.test(HTML)) console.log('  ✓ ' + k + '（引擎在别处创建，扩展层判空）');
    else { console.log('  ✗ ' + k + ' —— 既不在 newGame 也没有创建点'); fail++; }
  }
}

console.log('\n[4] 挂载顺序');
const order = ['ai-glue.js', 'ai-config.js', 'ai-ledger.js', 'ai-press.js', 'ai-prompt.js',
  'ai-context.js', 'ai-client.js', 'ai-adjudicate.js', 'ai-ui.js', 'ai-press-ui.js',
  'ai-hooks.js', 'ai-selftest.js'];
let last = -1, orderOk = true, loaded = 0;
for (const f of order) {
  const i = HTML.indexOf('src="ai/' + f + '"');
  if (i < 0) { console.log('  ✗ 未加载 ' + f); orderOk = false; continue; }
  loaded++;
  if (i < last) { console.log('  ✗ 顺序错误：' + f); orderOk = false; }
  last = i;
}
if (orderOk) console.log('  ✓ ' + loaded + ' 个脚本按依赖顺序挂载');

/* 原版脚本必须在扩展层之前 */
const origEnd = HTML.indexOf('</script>\n\n<!-- ====', HTML.indexOf('<script>/* [00]'));
const firstAi = HTML.indexOf('src="ai/ai-glue.js"');
if (origEnd > 0 && firstAi > origEnd) console.log('  ✓ 扩展层在原版脚本之后加载');
else { console.log('  ✗ 扩展层位置不对（必须在原版 </script> 之后）'); fail++; }

/* 原版 body 里没有残留的 AI 补丁痕迹 */
const bodyStart = HTML.indexOf('<body>');
const headPart = HTML.slice(0, bodyStart);
if (/ai-/.test(HTML.slice(HTML.indexOf('<script>/* [00]'), origEnd))) {
  console.log('  ✗ 原版脚本内部被插入了 AI 代码（应一行不改）');
  fail++;
} else {
  console.log('  ✓ 原版脚本内部一行未改');
}

/* ------------------------------------------------------------------ *
 * [5] 版本号一致性：<title> / 内置 APP_VERSION / README 必须同源
 *     这个字段同时出现在顶栏、开局页页脚，漏改就会出现「标题更新了、
 *     游戏里还是旧版本」的情况。
 * ------------------------------------------------------------------ */
console.log('\n[5] 版本号一致性');
const titleRaw = (HTML.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
const titleV = (titleRaw.match(/v\d+(?:\.\d+)+/) || [])[0] || '';
const appRaw = (HTML.match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
const appV = (appRaw.match(/v\d+(?:\.\d+)+/) || [])[0] || '';
let readmeRaw = '';
try { readmeRaw = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'); } catch (e) {}
const readmeV = (readmeRaw.match(/AI 扩展层[：:]\s*`?(v\d+(?:\.\d+)+)/) || [])[1] || '';

function verCheck(label, a, b) {
  if (!a || !b) { console.log('  ✗ ' + label + '：找不到版本号（' + a + ' / ' + b + '）'); fail++; return; }
  if (a === b) { console.log('  ✓ ' + label + '：' + a); return; }
  console.log('  ✗ ' + label + '：' + a + ' ≠ ' + b); fail++;
}
verCheck('<title> 与内置 APP_VERSION', titleV, appV);
verCheck('内置 APP_VERSION 与 README', appV, readmeV);

console.log('\n=== ' + (fail ? ('失败 ' + fail + ' 项') : '全部通过') + ' ===');
if (fail) process.exit(1);
