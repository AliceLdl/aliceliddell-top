/* ============================================================================
   tests/dom-e2e.js — 真·端到端测试（jsdom 里跑完整游戏 + AI 层）
   ----------------------------------------------------------------------------
   用法（先在 .testdeps 里装 jsdom）：
     cd .testdeps && npm install jsdom --cache ./.npmcache
     cd .. && node tests/dom-e2e.js
   它会：
     1. 用 jsdom 加载真实 index.html（4MB 原版引擎 + ai/ 扩展层）
     2. 跑页内自检 AISELFTEST
     3. 直接 startGame() 开一局（2001 就职，布什），确认战情室已经变成 AI 输入台
     4. 用桩函数替换 AICLIENT.chat，走完「自由行动 → 结算 → 日志/行动点」全链路
     5. 造一个突发决断事件，走完「自由输入 → AI 裁决 → 事件出队」全链路
     6. 模拟接口故障，确认离线兜底接管
     7. 推进一周，确认原版引擎没被破坏
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEPS = path.join(ROOT, '.testdeps', 'node_modules');
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require(path.join(DEPS, 'jsdom')));
} catch (e) {
  console.error('\n找不到 jsdom。先装一下（约 33MB，只在本地跑测试用）：\n' +
    '  cd "' + path.join(ROOT, '.testdeps') + '"\n' +
    '  npm install jsdom --cache ./.npmcache\n' +
    '  cd ..\n' +
    '  node tests/dom-e2e.js\n');
  process.exit(2);
}

const HTML_PATH = path.join(ROOT, 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, info) {
  if (cond) { pass++; console.log('  [OK] ' + name + (info ? '  --  ' + info : '')); }
  else { fail++; failures.push(name + (info ? ':' + info : '')); console.log('  [XX] ' + name + (info ? '  --  ' + info : '')); }
}

function fakeLocalStorage() {
  const m = {};
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; },
    clear: () => { Object.keys(m).forEach(k => delete m[k]); },
    key: i => Object.keys(m)[i] || null,
    get length() { return Object.keys(m).length; }
  };
}

console.log('\n=== 总统模拟器 · AI 版 / DOM 端到端测试 ===\n');
console.log('[0] 加载 index.html（4MB，需要几秒）...');
const t0 = Date.now();

const vc = new VirtualConsole();
const consoleErrors = [];
vc.on('jsdomError', e => consoleErrors.push(String((e && e.message) || e)));
vc.on('error', (...a) => consoleErrors.push(a.join(' ')));

const dom = new JSDOM(html, {
  url: 'file:///' + HTML_PATH.replace(/\\/g, '/'),
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    try { Object.defineProperty(window, 'localStorage', { value: fakeLocalStorage(), configurable: true }); } catch (e) {}
    try { Object.defineProperty(window, 'sessionStorage', { value: fakeLocalStorage(), configurable: true }); } catch (e) {}
    window.matchMedia = window.matchMedia || function () {
      return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
    };
    window.requestAnimationFrame = window.requestAnimationFrame || (cb => setTimeout(() => cb(Date.now()), 16));
    try {
      Object.defineProperty(window, 'fetch', { configurable: true, writable: true,
        value: function () { return Promise.reject(new Error('测试环境不联网')); } });
    } catch (e) { window.fetch = function () { return Promise.reject(new Error('测试环境不联网')); }; }
    window.scrollTo = function () {};
    window.alert = function () {};
    window.confirm = function () { return true; };
  }
});
const W = dom.window;
let REAL_CHAT = null;

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitFor(fn, timeoutMs, stepMs) {
  const start = Date.now();
  while (Date.now() - start < (timeoutMs || 20000)) {
    try { if (fn()) return true; } catch (e) {}
    await wait(stepMs || 50);
  }
  return false;
}

(async function main() {
  const loaded = await new Promise(resolve => {
    if (W.document.readyState === 'complete') return resolve(true);
    W.addEventListener('load', () => resolve(true));
    setTimeout(() => resolve(false), 90000);
  });
  ok('页面 load 完成', loaded, ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const booted = await waitFor(() => {
    return W.AIHOOKS && W.AIUI && W.AIG && W.AIG.g() &&
           W.document.getElementById('app') &&
           W.document.getElementById('app').innerHTML.length > 100;
  }, 30000);
  const appLen = () => (W.document.getElementById('app') ? W.document.getElementById('app').innerHTML.length : 0);
  ok('扩展层已挂载并渲染开局页', booted, 'app HTML ' + appLen() + ' 字符');

  /* 0b. raincandy 像素主题的字体链（缺字兜底） */
  const hasRcVar = /--rc-font:[^;]*"DinkieBitmap"[^;]*"FusionPixel12"/.test(html);
  const hasFace = /font-family:"FusionPixel12"/.test(html);
  const fontFile = path.join(ROOT, 'fonts', 'fusion-pixel-12px-sc.woff2');
  const fontBytes = fs.existsSync(fontFile) ? fs.statSync(fontFile).size : 0;
  ok('raincandy 字体栈：Dinkie 在前、FusionPixel12 兜底', hasRcVar && hasFace,
    '变量=' + hasRcVar + ' / @font-face=' + hasFace);
  ok('补字字体文件在位', fontBytes > 400000,
    fontFile.replace(ROOT, '.') + ' = ' + Math.round(fontBytes / 1024) + ' KB');
  ok('所有 raincandy 字体声明都走统一变量',
    (html.match(/font-family:"DinkieBitmap"/g) || []).length === 1,
    '残留硬编码 ' + ((html.match(/font-family:"DinkieBitmap"/g) || []).length - 1) + ' 处');
  REAL_CHAT = W.AICLIENT ? W.AICLIENT.chat : null;

  /* 1. 页内自检 */
  console.log('\n[1] 页内自检 AISELFTEST');
  let st = null;
  try { st = W.AISELFTEST.run(); } catch (e) { failures.push('AISELFTEST 抛错：' + e.message); }
  ok('自检全部通过', st && st.fail === 0, st ? (st.pass + '/' + st.total) : '未运行');
  if (st && st.fail) st.results.filter(r => !r.ok).forEach(r => console.log('      . ' + r.name + '：' + r.info));

  /* 2. 开一局 */
  console.log('\n[2] 开局并检查战情室');
  let started = false, startErr = '';
  try {
    W.AIG.ui().setup = { year: 2000, stage: 'inauguration', party: 'R', char: '乔治·W·布什',
                         mode: 'library', name: '', home: 'TX', arch: 'rEst', resume: '' };
    W.startGame();
    started = true;
  } catch (e) { startErr = e.stack || e.message; }
  ok('startGame() 成功', started, String(startErr).slice(0, 300));
  if (!started) return finish();

  await wait(200);
  const G = W.AIG.g();
  ok('进入执政期且玩家是总统', G.phase === 'presidency' && G.pres && G.pres.isPlayer,
    'phase=' + G.phase + ' pres=' + (G.pres && G.pres.name) + ' AP=' + G.ap);

  const appHTML = () => W.document.getElementById('app').innerHTML;
  const ver = (String(W.document.title || '').match(/v\d+(?:\.\d+)+/) || [])[0] ||
              (html.match(/<title>[^<]*?(v\d+(?:\.\d+)+)/) || [])[1] || '';
  const appVer = (html.match(/const APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
  ok('顶栏显示内置版本号', !!ver && appHTML().indexOf('21ST CENTURY · ' + ver) >= 0,
    '标题=' + ver + ' APP_VERSION=' + appVer);
  ok('总览页出现 AI 行动台', appHTML().indexOf("AIUI.submit('national')") >= 0,
    '含 textarea=' + (appHTML().indexOf('<textarea') >= 0));
  ok('默认不显示原版行动按钮', W.AICFG.showClassic === false && appHTML().indexOf('发表国情咨文') < 0);
  ok('顶栏出现 AI 设置按钮', appHTML().indexOf('AIUI.open()') >= 0,
    'gearBtnHTML 已覆写=' + (W.gearBtnHTML !== W.AIORIG.gearBtnHTML));
  ok('顶栏出现态势简报按钮', appHTML().indexOf('AIUI.openBrief()') >= 0, '');

  /* 3. 全链路：自由行动 */
  console.log('\n[3] 自由行动全链路（桩接口）');
  const apBefore = G.ap, apprBefore = G.pres.appr, logLen = G.log.length;
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({
        success: 'success', headline: '白宫强推药价上限',
        narrative: '你在椭圆形办公室发表全国电视讲话，宣布以行政令方式对联邦医保覆盖的处方药设定价格上限。制药行业当晚发表声明称将起诉。',
        apCost: 1, risk: 'medium', tone: '强硬',
        effects: { approval: 1.4, tension: 0, division: 0.5,
                   relations: { CN: 0 }, sectors: { pharma: -7 } },
        bill: { title: '处方药价格上限法案', topic: '医疗', direction: -4, summary: '对联邦医保药品设价格上限' },
        flags: ['drug_price'], followup: '制药业已准备诉讼。',
        ledger: {
          summary: '白宫以行政令强推药价上限，法律战开场',
          actions: [{ t: '签署药价上限行政令', outcome: '联邦医保药品即刻适用，制药业起诉', tags: ['医疗', '行政令'] }],
          commitments: [{ t: '两周内向国会提交配套立法', due: '两周后', status: 'pending' }],
          actors: [{ who: '制药业协会', stance: '从合作转为公开对抗' }],
          risks: ['药企已在找律师团队'],
          dossier: {
            facts: ['行政令的法律依据很薄，司法部内部评估胜诉率不足四成'],
            chains: ['药企起诉 → 巡回法院禁令 → 政策在选举前停摆'],
            ticking: [{ t: '药企将在三周内申请禁令', due: '3周内', effect: '政策效果归零' }],
            notes: ['这个玩家偏爱用行政令绕过国会']
          }
        }
      }),
      usage: { input: 1200, output: 260 }, ms: 12, totalMs: 12, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  W.AIUI.setDraft('national', '今晚黄金时段发表全国电视讲话，宣布把处方药价格上限写进行政令。');
  W.AIUI.submit('national');
  const applied = await waitFor(() => G.aiLog && G.aiLog.length > 0, 8000);
  ok('结算完成并写入档案', applied, applied ? G.aiLog[G.aiLog.length - 1].headline : '超时');
  await wait(100);
  ok('行动点被扣除', G.ap === apBefore - 1, apBefore + ' -> ' + G.ap);
  ok('支持率上升', G.pres.appr > apprBefore, apprBefore.toFixed(1) + ' -> ' + G.pres.appr.toFixed(1));
  ok('行业好感被写入', (G.corps.pharma || 50) < 63, 'pharma=' + G.corps.pharma);
  ok('法案进入起草队列', (G.drafts || []).some(d => d.bill && d.bill.cn === '处方药价格上限法案'),
    'drafts=' + (G.drafts || []).length);
  ok('叙事进了新闻日志', G.log.length > logLen, '新增 ' + (G.log.length - logLen) + ' 条');
  ok('结果卡片渲染出来', appHTML().indexOf('白宫强推药价上限') >= 0);
  ok('结果卡片显示执行档位', /ai-grade g3/.test(appHTML()) && appHTML().indexOf('>成功<') >= 0,
    '档位标记=' + ((appHTML().match(/ai-grade g\d/g) || []).join(',')));

  /* 3b. 叙事账本 */
  console.log('\n[3b] 叙事账本（玩家可见简报 / 隐藏内部档案）');
  const LW = () => G.aiWorld;
  ok('双层账本已建立', !!LW() && LW().brief && LW().dossier,
    'brief 键=' + (LW() && LW().brief ? Object.keys(LW().brief).length : 0));
  ok('公开层写入行动与承诺',
    LW().brief.actions.length === 1 && LW().brief.commitments.length === 1,
    '行动=' + LW().brief.actions.length + ' 承诺=' + LW().brief.commitments.length);
  ok('内部层写入隐藏事实与定时后果',
    LW().dossier.facts.length === 1 && LW().dossier.ticking.length === 1,
    '事实=' + LW().dossier.facts.length + ' 定时=' + LW().dossier.ticking.length);
  ok('战情室显示态势摘要', appHTML().indexOf('白宫以行政令强推药价上限') >= 0, '');
  ok('隐藏事实不在页面上', appHTML().indexOf('胜诉率不足四成') < 0, '');
  W.AIUI.openBrief();
  await wait(80);
  ok('简报弹窗打开并列出行动', appHTML().indexOf('签署药价上限行政令') >= 0, '');
  ok('简报弹窗含外部事件与承诺', appHTML().indexOf('承诺与期限') >= 0, '');
  ok('简报弹窗不含内部档案', appHTML().indexOf('胜诉率不足四成') < 0 &&
    appHTML().indexOf('不出现在界面上') >= 0, '');
  W.AIUI.closeModal();
  await wait(60);

  /* 4. 决断事件全链路 */
  console.log('\n[4] 突发事件决断全链路');
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({
        success: 'success', headline: '联邦接管灾区救援',
        narrative: '你当天下午飞抵灾区，宣布联邦应急管理局全面接管现场协调，并要求国会在四十八小时内通过追加拨款。州长公开致谢，反对党质疑你在作秀。',
        apCost: 1, risk: 'low', tone: '强硬',
        effects: { approval: 1.1, confidence: 2, division: -0.5 }, followup: '拨款案还卡在众议院。'
      }),
      usage: { input: 1200, output: 240 }, ms: 10, totalMs: 10, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  W.fireEvent({
    id: 'test_ev_1', cn: '飓风登陆', m: 2,
    t: '四级飓风在路易斯安那登陆，新奥尔良部分地区被淹，州长请求联邦支援。',
    ch: [{ t: '立即前往灾区', d: '总统亲临', fx: { appr: 2 } },
         { t: '留在华盛顿指挥', d: '交给地方', fx: { appr: -1 } }]
  });
  await wait(150);
  ok('事件已进入待决断队列', G.pendingEvents && G.pendingEvents.length > 0,
    'pendingEvents=' + (G.pendingEvents || []).length);
  ok('引擎事件自动进账', (G.aiWorld.brief.external || []).some(x => /飓风登陆/.test(x.t || '')),
    '外部事件=' + (G.aiWorld.brief.external || []).length);
  W.render();
  const evModal = appHTML();
  ok('弹窗里是可写字的输入台而不是固定选项',
    evModal.indexOf("AIUI.submit('decision')") >= 0 && evModal.indexOf('立即前往灾区') < 0);

  const pendBefore = G.pendingEvents.length;
  W.AIUI.setDraft('decision', '我下午就飞过去，联邦接管救援指挥，同时要求国会四十八小时内追加拨款。');
  W.AIUI.submit('decision');
  const eventGone = await waitFor(() => (G.pendingEvents || []).length === pendBefore - 1, 8000);
  ok('裁决后事件出队', eventGone, '剩余 ' + (G.pendingEvents || []).length);
  ok('弹窗已关闭', !W.AIG.ui().modal, JSON.stringify(W.AIG.ui().modal));
  ok('日志里有你的处置', G.log.some(x => /你的处置/.test(x.t || '')), '');

  /* 5. 接口故障 → 直接作废（不回退本地规则） */
  console.log('\n[5] 接口故障 / 返回不合规 -> 直接作废');
  G.ap = 5;                                  /* 上两步把行动点花完了，补一点再测 */
  const apBeforeFail = G.ap;
  const logLenBeforeFail = G.log.length;
  W.AICLIENT.chat = function () { return Promise.reject(new Error('模拟网络故障')); };
  W.AIUI.setDraft('national', '宣布对伊朗实施新一轮制裁');
  W.AIUI.submit('national');
  const failDone = await waitFor(() => !!W.AIUI.state.error, 8000);
  ok('接口失败时不再回退本地规则', failDone && !W.AIUI.state.result,
    'result=' + JSON.stringify(W.AIUI.state.result && W.AIUI.state.result.source));
  ok('接口失败不扣行动点、不写日志', G.ap === apBeforeFail && G.log.length === logLenBeforeFail,
    'AP ' + apBeforeFail + '→' + G.ap + ' / 日志 +' + (G.log.length - logLenBeforeFail));
  ok('界面说明本次未执行', /未执行/.test(W.AIUI.state.error || ''), String(W.AIUI.state.error || '').slice(0, 60));

  /* 5b. 返回了 JSON 但没有合法 success：同样作废 */
  const apBeforeBad = G.ap;
  const logLenBeforeBad = G.log.length;
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({ headline: '没有档位的裁决', narrative: '模型忘了给 success。',
        apCost: 2, effects: { approval: 3 } }),
      usage: { input: 100, output: 30 }, ms: 8, totalMs: 8, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  W.AIUI.setDraft('national', '再做一件事');
  W.AIUI.submit('national');
  const badDone = await waitFor(() => /作废/.test(W.AIUI.state.error || ''), 8000);
  ok('缺少 success 的结果直接作废', badDone,
    String(W.AIUI.state.error || '').slice(0, 70));
  ok('作废时不扣行动点、不落数值', G.ap === apBeforeBad && G.log.length === logLenBeforeBad &&
    !W.AIUI.state.result, 'AP ' + apBeforeBad + '→' + G.ap);

  /* 6. 面板 */
  console.log('\n[6] 面板与交互');
  W.AIUI.open();
  await wait(60);
  ok('设置面板打开并渲染', appHTML().indexOf('AI 设置') >= 0);
  W.AIUI.setTab('prompt');
  await wait(60);
  ok('提示词页可编辑', appHTML().indexOf('textarea') >= 0 && appHTML().indexOf('系统提示词') >= 0);
  /* 上帝模式入口在主设置页（齿轮），不在 AI 设置页 */
  W.AIUI.close();
  W.openSettings();
  await wait(80);
  const setHTML = appHTML();
  ok('主设置页有「AI 裁决 · 上帝模式」', setHTML.indexOf('AI 裁决 · 上帝模式') >= 0 &&
    setHTML.indexOf('AIUI.setGodMode(true)') >= 0, '设置页 HTML ' + setHTML.length + ' 字符');
  W.AIUI.setGodMode(true);
  ok('开启后写入配置', W.AICFG.godMode === true, 'godMode=' + W.AICFG.godMode);
  W.closeSettings();
  W.AIUI.open();
  W.AIUI.setTab('play');
  await wait(60);
  ok('AI 设置页不再有上帝模式开关', appHTML().indexOf('id="ai-gm"') < 0, '玩法页已移除');
  const promptBefore = W.AIPROMPT.system().length;
  W.AIUI.setCfg({ godMode: false });
  const promptAfter = W.AIPROMPT.system().length;
  W.AIUI.setCfg({ godMode: true });
  ok('上帝模式仍会改写系统提示词', promptBefore > promptAfter && /上帝模式/.test(W.AIPROMPT.system()),
    promptAfter + ' → ' + promptBefore + ' 字');
  ok('上帝模式不碰扣点逻辑', W.AIADJ.apply.toString().indexOf('godMode') < 0,
    'apply 源码里无 godMode 分支');
  ok('沙盘声明不进提示词预览', (function () {
    const sand = W.AIPROMPT.SAND || '';
    W.AIUI.setTab('prompt');
    W.AIUI.preview();
    const pv = W.AIUI.state.preview || {};
    return sand.length > 0 && (pv.system || '').indexOf('运行环境声明') < 0 &&
           (pv.user || '').indexOf('架空推演沙盘') < 0;
  })(), '预览里已剥离');
  /* 上帝模式下档位不合规 → 作废 */
  const apBeforeGod = G.ap;
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({ success: 'partial', headline: '半执行', narrative: '只办成一半。',
        apCost: 1, effects: { approval: 1 } }),
      usage: { input: 100, output: 20 }, ms: 8, totalMs: 8, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  W.AIUI.close();
  W.AIUI.setDraft('national', '上帝模式下的一次行动');
  W.AIUI.submit('national');
  const godRejected = await waitFor(() => /作废/.test(W.AIUI.state.error || ''), 8000);
  ok('上帝模式下「部分成功」被作废', godRejected && G.ap === apBeforeGod && !W.AIUI.state.result,
    String(W.AIUI.state.error || '').slice(0, 60) + ' / AP ' + apBeforeGod + '→' + G.ap);
  ok('上帝模式默认开启状态生效于系统提示词', /只接受|只能/.test(W.AIPROMPT.GOD), '字数 ' + W.AIPROMPT.GOD.length);
  W.AIUI.setGodMode(false);

  /* 公开性：密谈不涨民意，结果卡标出「密谈」，舆论不得报道 */
  const apprBeforeVis = G.pres.appr;
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({ success: 'success', visibility: 'secret', headline: '闭门交易',
        narrative: '你在书房与两位议员谈成一笔交换，没有对外公布。',
        apCost: 1, risk: 'low', tone: '交易', effects: { approval: 4, politicalCapital: 2 } }),
      usage: { input: 120, output: 40 }, ms: 8, totalMs: 8, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  W.AIUI.setDraft('national', '闭门谈一笔交易');
  W.AIUI.submit('national');
  const visDone = await waitFor(() => W.AIUI.state.result && W.AIUI.state.result.visibility === 'secret', 8000);
  ok('结果卡标出公开度「密谈」', visDone && appHTML().indexOf('密谈') >= 0,
    'visibility=' + ((W.AIUI.state.result || {}).visibility));
  ok('密谈的民意效果被压到 15%', visDone && (G.pres.appr - apprBeforeVis) < 1.2,
    apprBeforeVis.toFixed(1) + ' → ' + G.pres.appr.toFixed(1) + '（模型给的是 +4）');
  ok('未公开行动进了舆论禁报清单', (function () {
    const req = W.AIPRESS.buildFeedRequest();
    return req.user.indexOf('尚未公开的行动') >= 0 && req.user.indexOf('闭门交易') >= 0;
  })(), '提示词含禁报约束');

  await wait(60);
  W.AIUI.open();
  W.AIUI.openHistory();
  await wait(60);
  ok('裁决档案列出刚才的记录', /白宫强推药价上限|联邦接管灾区救援|制裁/.test(appHTML()));
  W.AIUI.close();
  await wait(60);
  ok('关闭后回到游戏界面', appHTML().indexOf('白宫战情室') >= 0);

  /* 9. 冲击节点：自由处置 */
  console.log('\n[9] 重大冲击节点（自由处置）');
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({
        success: 'success', headline: '财政与联储联合救市',
        narrative: '你要求财政部与联储在周末连夜敲定商业票据融资便利，并向国会提交资产购买授权。市场周一开盘止跌，但两党都要求你到会说明资金去向。',
        apCost: 2, risk: 'high', tone: '强硬',
        effects: { confidence: 4, stock: 2, deficit: 0.2, tension: 0 }, followup: '救助资金需要国会审计。'
      }),
      usage: { input: 1200, output: 250 }, ms: 10, totalMs: 10, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  G.ap = 8;
  G.shocks = G.shocks || {};
  G.shocks.fin2008 = { cn: '金融危机', acted: 0 };
  W.AIG.ui().modal = {
    type: 'shockev', shock: 'fin2008',
    ev: { id: 'f08_01', cn: '雷曼之后', t: '雷曼兄弟破产后一周，商业票据市场停摆。',
          o: [{ id: 's08_a', t: '宣布全面担保', fx: {}, ap: 2 }] }
  };
  W.render();
  await wait(80);
  ok('冲击弹窗换成自由输入台',
    appHTML().indexOf("AIUI.submit('shock')") >= 0 && appHTML().indexOf('宣布全面担保') < 0);
  W.AIUI.setDraft('shock', '立即设立商业票据融资便利，并向国会提交七千亿美元的资产购买授权。');
  W.AIUI.submit('shock');
  const shockDone = await waitFor(() => (G.shocks.fin2008.acted || 0) > 0, 8000);
  ok('冲击状态被推进（acted +1）', shockDone, 'acted=' + (G.shocks.fin2008.acted || 0));
  ok('冲击弹窗关闭', !W.AIG.ui().modal, JSON.stringify(W.AIG.ui().modal));

  /* 10. 国际危机：自由处置 */
  console.log('\n[10] 国际危机（自由处置）');
  const crisisId = (G.crises && G.crises.length) ? G.crises[0].id : null;
  if (!crisisId) {
    ok('危机测试（跳过：本局暂无活跃危机）', true, '');
  } else {
    W.AICLIENT.chat = function () {
      return Promise.resolve({
        text: JSON.stringify({
          success: 'success', headline: '先谈后压',
          narrative: '你先与盟友协调，公开提出停火方案，同时把航母战斗群前移。对方称愿意接触，但要求先解除部分制裁。',
          apCost: 2, risk: 'high', tone: '妥协',
          effects: { tension: 3, approval: 0.4, division: 0.3 }, followup: '国会要求你对军事部署作出说明。'
        }),
        usage: { input: 1200, output: 240 }, ms: 10, totalMs: 10, model: 'stub', endpoint: 'stub', attempts: 1
      });
    };
    W.AIG.ui().selCrisis = crisisId;
    W.AIG.ui().tab = 'crisis';
    W.render();
    await wait(80);
    ok('危机面板有自由输入台', appHTML().indexOf("AIUI.submit('crisis')") >= 0, '');
    const cObj = W.activeCrisis(crisisId);
    const before = { stage: (cObj && cObj.stage) || 0, nextAt: (cObj && cObj.nextAt) || 0 };
    W.AIUI.setDraft('crisis', '先与盟友协调提出停火方案，同时把航母战斗群前移作为筹码。');
    W.AIUI.submit('crisis');
    const crisisDone = await waitFor(() => {
      const c = W.activeCrisis(crisisId);
      return !c || (c.nextAt || 0) > before.nextAt || (c.stage || 0) > before.stage;
    }, 8000);
    ok('危机被推进（阶段或冷却时间变化）', crisisDone, JSON.stringify(before) + ' -> ' +
      JSON.stringify(W.activeCrisis(crisisId) ? {
        stage: W.activeCrisis(crisisId).stage, nextAt: W.activeCrisis(crisisId).nextAt } : 'removed'));
    W.AIG.ui().selCrisis = null;
    W.AIG.ui().tab = 'main';
    W.render();
  }

  /* 7. 推进一周 */
  console.log('\n[7] 推进一周（原版引擎未被破坏）');
  const w0 = G.w, y0 = G.y;
  let advanced = false, advErr = '';
  try { W.doAdvance(); advanced = true; } catch (e) { advErr = e.message; }
  await wait(300);
  ok('doAdvance 未抛错', advanced, advErr);
  ok('周次前进或进入事件弹窗', G.w !== w0 || G.y !== y0 || (G.pendingEvents || []).length > 0,
    y0 + 'w' + w0 + ' -> ' + G.y + 'w' + G.w + '（pendingEvents=' + (G.pendingEvents || []).length + '）');

  /* 8. 关闭 AI */
  console.log('\n[8] 原地关闭 AI 模式');
  W.AI.set({ enabled: false });
  W.render();
  await wait(80);
  ok('战情室回到原版按钮',
    appHTML().indexOf('发表国情咨文') >= 0 || appHTML().indexOf('全国电视讲话') >= 0 ||
    appHTML().indexOf('国会游说') >= 0);
  W.AI.set({ enabled: true });
  W.render();

  /* 12. 真实 HTTP：用本地假服务验证请求体与响应解析 */
  console.log('\n[12] 真实 HTTP 请求（本地假 OpenAI 服务）');
  const http = require('http');
  let captured = null;
  let capturedAdjudge = null;      /* 只保存真正的裁决请求（后台整理请求会覆盖 captured） */
  let modelsHit = null;
  const mock = http.createServer((req, res) => {
    if (req.method === 'GET' && /\/models/.test(req.url || '')) {
      modelsHit = { url: req.url, headers: req.headers };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [
        { id: 'mock-model' }, { id: 'mock-model-2' }, { id: 'text-embedding-3' }
      ] }));
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { captured = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; }
      catch (e) { captured = { url: req.url, headers: req.headers, body: null, err: e.message }; }
      if (captured.body && captured.body.messages && captured.body.messages[1] &&
          /【当前局势】/.test(String(captured.body.messages[1].content))) {
        capturedAdjudge = captured;
      }
      const verdict = {
        success: 'success', headline: '联储换帅风波',
        narrative: '你提名一位偏鸽派的经济学家进入联储理事会，市场当天小幅走高。反对党指责你试图政治化货币政策，参议院银行委员会要求听证。',
        apCost: 1, risk: 'medium', tone: '程序性',
        effects: { approval: 0.6, confidence: 1.5, stock: 1.2, tension: 0 },
        followup: '听证会将成为下一场舆论战。'
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-1', object: 'chat.completion', model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(verdict) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1500, completion_tokens: 220 }
      }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const port = mock.address().port;
  /* jsdom 的 AbortSignal 与 Node fetch 不是同一个 realm，需要转接一次 */
  const bridgeFetch = (u, init) => {
    init = init || {};
    const out = { method: init.method, headers: init.headers, body: init.body };
    if (init.signal) {
      const ac = new AbortController();
      if (init.signal.aborted) ac.abort();
      else init.signal.addEventListener('abort', () => ac.abort());
      out.signal = ac.signal;
    }
    return globalThis.fetch(u, out);
  };
  try {
    Object.defineProperty(W, 'fetch', { configurable: true, writable: true, value: bridgeFetch });
  } catch (e) { console.log('      (fetch 注入失败：' + e.message + ')'); }
  W.AICLIENT.chat = REAL_CHAT;
  W.AI.set({ baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'mock-model',
             apiKey: 'sk-mock', provider: 'openai' });
  G.ap = 6;

  let testRes = null;
  try { testRes = await W.AICLIENT.test(); } catch (e) { testRes = { ok: false, text: e.message }; }
  ok('测试连接成功', !!testRes && testRes.ok === true,
    testRes ? ('耗时 ' + testRes.ms + 'ms，模型 ' + testRes.model + '，返回 ' + String(testRes.text).slice(0, 160)) : '无结果');
  if (!testRes || !testRes.ok) {
    console.log('      诊断：fetch=' + typeof W.fetch + ' endpoint=' +
      (W.AICLIENT.endpointFor ? W.AICLIENT.endpointFor() : '?') +
      ' baseUrl=' + W.AICFG.baseUrl + ' key=' + (W.AICFG.apiKey ? 'set' : 'empty'));
  }
  ok('请求头带 Bearer', captured && /^Bearer sk-mock/.test(captured.headers.authorization || ''),
    captured ? String(captured.headers.authorization) : '无请求');
  ok('请求体是 chat/completions 结构',
    captured && captured.body && Array.isArray(captured.body.messages) &&
    captured.body.messages.length === 2 && captured.body.model === 'mock-model' &&
    captured.body.response_format && captured.body.response_format.type === 'json_object',
    captured && captured.body ? ('字段 ' + Object.keys(captured.body).join(',')) : '无请求');

  const apprBefore2 = G.pres.appr;
  W.AIUI.setDraft('national', '提名一位偏鸽派的经济学家进入美联储理事会。');
  const countBefore2 = W.AI.STAT.count;
  W.AIUI.submit('national');
  await wait(300);
  ok('真实 HTTP 提交已发出', true,
    'draft=' + JSON.stringify((W.AIUI.state.draft || {}).national) + ' busy=' + W.AI.STAT.busy +
    ' err=' + String(W.AIUI.state.error || '').slice(0, 80) + ' count=' + countBefore2 + '→' + W.AI.STAT.count);
  const httpDone = await waitFor(() => W.AIUI.state.result && W.AIUI.state.result.headline === '联储换帅风波', 8000);
  ok('真实 HTTP 结算完成', httpDone,
    httpDone ? ('支持率 ' + apprBefore2.toFixed(1) + ' -> ' + G.pres.appr.toFixed(1) +
                '，chips=' + W.AIUI.state.result.chips.length)
             : ('超时：busy=' + W.AI.STAT.busy + ' err=' + String(W.AIUI.state.error || '').slice(0, 90) +
                ' last=' + JSON.stringify(W.AI.STAT.last && W.AI.STAT.last.status) +
                ' result=' + JSON.stringify(W.AIUI.state.result && W.AIUI.state.result.headline) +
                ' user1=' + String(captured && captured.body && captured.body.messages[1].content || '').slice(0, 120)));
  /* 上面这次 submit 才是真正的裁决请求，用它检查提示词内容 */
  ok('系统提示词进了 messages[0]',
    capturedAdjudge && capturedAdjudge.body && /裁决引擎/.test(capturedAdjudge.body.messages[0].content) &&
    capturedAdjudge.body.messages[0].role === 'system',
    capturedAdjudge ? String(capturedAdjudge.body.messages[0].content).slice(0, 60) : '无请求');
  ok('玩家输入与局势进了 messages[1]',
    capturedAdjudge && /提名一位偏鸽派/.test(capturedAdjudge.body.messages[1].content) &&
    /【当前局势】/.test(capturedAdjudge.body.messages[1].content) &&
    /"经济"/.test(capturedAdjudge.body.messages[1].content),
    capturedAdjudge ? ('长度 ' + capturedAdjudge.body.messages[1].content.length) : '无请求');
  ok('请求里带沙盘声明（不显示给玩家，但会发给模型）',
    capturedAdjudge && /运行环境声明/.test(capturedAdjudge.body.messages[0].content),
    capturedAdjudge ? ('系统提示词 ' + capturedAdjudge.body.messages[0].content.length + ' 字') : '无请求');
  ok('HTTP 响应里的数值被应用', httpDone && G.pres.appr > apprBefore2, '');
  ok('token 用量被累计', W.AI.STAT.tokensIn > 0 && W.AI.STAT.tokensOut > 0,
    'in=' + W.AI.STAT.tokensIn + ' out=' + W.AI.STAT.tokensOut);

  /* 12b. 模型列表自动拉取 */
  console.log('\n[12b] 模型列表自动拉取');
  W.AIUI.close();
  await wait(60);
  W.AIUI.open();                       /* 打开设置：应自动拉一次 */
  const autoPulled = await waitFor(() => W.AI.modelList(), 8000);
  ok('打开设置时自动拉取模型列表', autoPulled,
    autoPulled ? ('缓存 ' + W.AI.modelList().models.length + ' 个') : '超时');
  ok('请求打到了 /v1/models 且带 Bearer',
    modelsHit && /\/v1\/models$/.test(modelsHit.url) &&
    /^Bearer sk-mock/.test(modelsHit.headers.authorization || ''),
    modelsHit ? (modelsHit.url + ' · ' + modelsHit.headers.authorization) : '无请求');
  await wait(80);
  ok('设置面板渲染出候选与芯片',
    appHTML().indexOf('datalist id="ai-model-list"') >= 0 &&
    appHTML().indexOf('<option value="mock-model-2">') >= 0 &&
    appHTML().indexOf('AIUI.setModelByIdx(1)') >= 0 &&
    appHTML().indexOf('已缓存 3 个模型') >= 0, '');
  ok('拉取后模型芯片可一键切换', (function () {
    W.AIUI.setModelByIdx(1);
    return W.AICFG.model === 'mock-model-2';
  })(), '当前模型=' + W.AICFG.model);
  W.AIUI.fetchModels(true);
  const refreshed = await waitFor(() => !W.AIUI.state.modelsLoading, 8000);
  ok('手动「拉取列表」可刷新且不报错', refreshed && !W.AIUI.state.modelsErr,
    '错误=' + (W.AIUI.state.modelsErr || '无'));
  W.AIUI.close();
  await wait(40);

  mock.close();
  W.fetch = function () { return Promise.reject(new Error('测试环境不联网')); };

  /* 14. 账本整理（让模型重写两份账） */
  console.log('\n[14] 账本整理（模型重写）');
  await waitFor(() => !W.AI.STAT.busy, 10000);      /* 等可能触发的自动整理先跑完 */
  W.AICFG.maintainAuto = false;
  const stBefore = W.AILEDGER.stats();
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({
        brief: {
          summary: '整理后的形势：药价战进入司法阶段',
          situation: ['药企已起诉'],
          actions: [{ w: '2004·W2', t: '签署药价上限行政令', outcome: '制药业起诉', tags: ['医疗'] }],
          external: [{ w: '2004·W3', t: '飓风登陆路易斯安那', impact: '联邦救援压力' }],
          commitments: [], actors: [], risks: ['法院禁令可能在三周内下达']
        },
        dossier: {
          facts: [{ w: '2004·W2', t: '司法部内部评估胜诉率不足四成' }],
          chains: [], agendas: [], ticking: [],
          profile: { style: '偏好行政令', weaknesses: ['不耐国会程序'], base: '保守派' },
          notes: []
        }
      }),
      usage: { input: 1800, output: 500 }, ms: 20, totalMs: 20, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  W.AIHOOKS.maintain(true);
  const maintained = await waitFor(() => {
    const s = W.AILEDGER.stats();
    return s.sinceMaintain === 0 && G.aiWorld.brief.summary === '整理后的形势：药价战进入司法阶段';
  }, 8000);
  ok('整理调用完成并替换两份账', maintained,
    '整理前行动 ' + stBefore.actions + ' 条 → 整理后 ' + W.AILEDGER.stats().actions + ' 条');
  ok('整理后保留内部档案与玩家画像',
    W.AILEDGER.stats().facts === 1 && G.aiWorld.dossier.profile.style === '偏好行政令',
    '画像=' + G.aiWorld.dossier.profile.style);
  W.AIUI.openBrief();
  await wait(70);
  ok('简报弹窗里有整理按钮', appHTML().indexOf('AIHOOKS.maintain(true)') >= 0, '');
  W.AIUI.closeModal();
  await wait(50);
  ok('需要整理时会被判定出来', (function () {
    G.aiWorld.sinceMaintain = 99;
    const need = W.AILEDGER.needsMaintenance();
    G.aiWorld.sinceMaintain = 0;
    return need;
  })(), '');

  /* 15. 舆论板块 */
  console.log('\n[15] 舆论板块（媒体版面 + 民间信息流）');
  W.AICFG.pressAuto = false;
  function pressOutletPayload(name) {
    return {
      outlet: name, tone: 'criticize', focus: '政策', slogan: 'All the News That\u2019s Fit to Print',
      sections: [
        { k: 'lead', cn: '头条', items: [{ h: '白宫的药价豪赌', p: '编辑部认为行政令的法律基础薄弱，诉讼可能拖上数年。' }] },
        { k: 'domestic', cn: '国内', items: [{ h: '州长们开始抱怨', p: '联邦承诺没有配套资金，压力全落在州一级。' }] },
        { k: 'economy', cn: '经济', items: [{ h: '药价上限吓退投资', p: '社论版警告创新外流，呼吁国会否决。' }] },
        { k: 'world', cn: '国际', items: [{ h: '盟友在观望', p: '欧洲各国要求华盛顿说明下一步。' }] },
        { k: 'policy', cn: '总统政策观察', items: [{ h: '行政令的法律风险', p: '司法部内部评估胜诉率不足四成。' }] },
        { k: 'opinion', cn: '社论', items: [{ h: '社论：代价被藏起来了', p: '账单迟早要有人付。' }] }
      ]
    };
  }
  W.AICLIENT.chat = function (system, user) {
    if (/【本期媒体】/.test(user)) {
      var m = /【本期媒体】([^（\n]+)/.exec(user);
      var name = m ? m[1].trim() : '纽约时报';
      return Promise.resolve({
        text: JSON.stringify(pressOutletPayload(name)),
        usage: { input: 1500, output: 700 }, ms: 15, totalMs: 15, model: 'stub', endpoint: 'stub', attempts: 1
      });
    }
    return Promise.resolve({
      text: JSON.stringify({
        summary: '民意分裂：药价之争压过一切',
        feed: {
          platform: 'forum',
          posts: [
            { name: 'mike_1985', handle: 'mike', loc: 'OH', stance: 'oppose',
              text: '油价又涨了，白宫还在谈药价。我加满一箱要多掏十二块。', replies: 12, views: 840, time: '1小时前' },
            { name: 'sarah_pa', handle: 'sarah', loc: 'PA', stance: 'support',
              text: '至少有人在做实事。我妈的胰岛素去年涨到三百多。', replies: 4, views: 320, time: '2小时前' },
            { name: 'dan_tx', handle: 'dan', loc: 'TX', stance: 'mock',
              text: '明天股市会告诉我们答案（然后继续跌）。', replies: 2, views: 210, time: '3小时前' }
          ]
        }
      }),
      usage: { input: 1500, output: 700 }, ms: 15, totalMs: 15, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  ok('顶栏出现「舆论」标签', appHTML().indexOf("setTab('opinion')") >= 0, '');
  W.setTab('opinion');
  const pressReady = await waitFor(() => {
    const s = W.AIPRESS.current();
    return s && s.posts.length && s.outlets[s.selected];
  }, 12000);
  const press = W.AIPRESS.current();
  ok('切到舆论页：自动生成信息流与当前媒体版面', pressReady,
    pressReady ? ('发言 ' + press.posts.length + ' 条 / 已生成 ' +
      Object.keys(press.outlets).length + ' 家 / 当前《' + press.selected + '》') : '超时');
  await wait(120);
  ok('媒体区一次只显示一家', (appHTML().match(/<div class="aip-paper">/g) || []).length === 1,
    '版面数=' + (appHTML().match(/<div class="aip-paper">/g) || []).length);
  ok('版头是当前这家', appHTML().indexOf('<div class="aip-mast-xl">' + press.selected + '</div>') >= 0,
    press.selected);
  ok('六个板块齐全',
    ['头条', '国内', '经济', '国际', '总统政策观察', '社论'].every(x => appHTML().indexOf('>' + x + '<') >= 0),
    '');
  ok('有媒体下拉栏', /<select[^>]*onchange="AIPRESS_UI\.selectOutlet/.test(appHTML()), '');
  const pressCards = [...W.document.querySelectorAll('#app .aip-wrap > .card')];
  ok('有标题的舆论卡片把 h3 放在直接首子（rc 皮肤标题条不会盖住内容）',
    pressCards.length >= 2 && pressCards.every(c => {
      const h3 = c.querySelector('h3');
      return !h3 || c.firstElementChild === h3;
    }),
    '卡片数=' + pressCards.length + ' / ' +
    pressCards.map(c => (c.querySelector('h3') ? c.firstElementChild.tagName + '>' + c.querySelector('h3').textContent.trim().slice(0, 4) : '无标题')).join(' , '));
  ok('带标题的卡片没有内联 padding（不与 rc 的 34px 标题区打架）',
    pressCards.every(c => !c.querySelector('h3') || !/padding/.test(c.getAttribute('style') || '')),
    pressCards.map(c => c.getAttribute('style') || '—').join(' | '));
  ok('民间区用论坛皮肤（2001）', appHTML().indexOf('aip-feed forum') >= 0, '');
  ok('发言与互动数渲染', appHTML().indexOf('油价又涨了') >= 0 &&
    appHTML().indexOf('查看') >= 0, '');
  ok('嘲讽并入反对后的三分统计', G.aiPress.mood.support === 1 && G.aiPress.mood.oppose === 2 &&
    G.aiPress.mood.neutral === 0 && G.aiPress.mood.mock === undefined,
    JSON.stringify(G.aiPress.mood));
  ok('帖子不带立场标签', appHTML().indexOf('class="stance"') < 0 &&
    appHTML().indexOf('嘲讽') < 0, '');
  ok('没有多余的介绍句', appHTML().indexOf('媒体与网民都是 AI') < 0 &&
    appHTML().indexOf('平台特征') < 0 && appHTML().indexOf('AI 虚构') < 0, '');
  ok('头部只列三分倾向', appHTML().indexOf('样本倾向') >= 0 &&
    appHTML().indexOf('中立 ') >= 0, '');

  /* 下拉切换到另一家 */
  const names = W.AIPRESS.outletNames(press);
  const target = names.indexOf('福克斯新闻') >= 0 ? '福克斯新闻' : names[names.length - 1];
  W.AIPRESS_UI.selectOutlet(String(names.indexOf(target)));
  const switched = await waitFor(() => G.aiPress.outlets[target], 10000);
  await wait(120);
  ok('下拉切换后只显示另一家', switched &&
    appHTML().indexOf('<div class="aip-mast-xl">' + target + '</div>') >= 0 &&
    (appHTML().match(/<div class="aip-paper">/g) || []).length === 1,
    '切到《' + target + '》');
  ok('切换后仍只有一家版面', (appHTML().match(/<div class="aip-paper">/g) || []).length === 1, '');

  const yKeep = G.y;
  G.y = 2015;
  W.AIPRESS.offline();
  W.render();
  await wait(80);
  ok('2015 年换成 Twitter 皮肤', appHTML().indexOf('aip-feed twitter') >= 0, '');
  G.y = 2025;
  W.AIPRESS.offline();
  W.render();
  await wait(80);
  ok('2025 年换成 X 皮肤并显示查看数',
    appHTML().indexOf('aip-feed x') >= 0 && appHTML().indexOf('查看') >= 0, '');
  G.y = yKeep;
  W.setTab('main');
  await wait(80);
  ok('返回总览页', appHTML().indexOf('白宫战情室') >= 0, '');

  /* 11. 初选阶段的竞选行动（原版这里是内联按钮行） */
  console.log('\n[11] 初选阶段的竞选自由行动');
  W.AICLIENT.chat = function () {
    return Promise.resolve({
      text: JSON.stringify({
        success: 'success', headline: '铁锈带三日行',
        narrative: '你在宾夕法尼亚连跑三场工会集会，顺带投放了一轮针对制造业的电视广告。当地工会主席站台，对手阵营指责你在贸易问题上前后不一。',
        apCost: 1, risk: 'low', tone: '交易',
        campaign: { momentum: 0.12, funds: -12, energy: -9,
                    stats: { nameRec: 1.1, enthusiasm: 0.9, adSpend: 12 },
                    visits: { PA: 2.2 }, stateLift: { PA: 1.2 } },
        followup: '爱荷华的组织还在等你回话。'
      }),
      usage: { input: 1100, output: 220 }, ms: 9, totalMs: 9, model: 'stub', endpoint: 'stub', attempts: 1
    });
  };
  let primaryOk = false, primaryErr = '';
  try {
    W.AIG.ui().setup = { year: 2004, stage: 'primary', party: 'D', char: '约翰·克里',
                         mode: 'library', name: '', home: 'MA', arch: 'dEst', resume: '' };
    W.startGame();
    primaryOk = true;
  } catch (e) { primaryErr = e.stack || e.message; }
  ok('初选开局成功', primaryOk, String(primaryErr).slice(0, 240));
  if (primaryOk) {
    await wait(200);
    const G2 = W.AIG.g();
    ok('进入初选阶段', G2.phase === 'primary', 'phase=' + G2.phase);
    ok('竞选行动台取代原版表态按钮',
      appHTML().indexOf("AIUI.submit('campaign')") >= 0 && appHTML().indexOf('card ai-hide') >= 0,
      '隐藏原卡=' + (appHTML().indexOf('card ai-hide') >= 0));
    const fundsBefore = G2.campaign ? G2.campaign.funds : 40;
    const momBefore = G2.campaign ? G2.campaign.momentum : 1;
    W.AIUI.setDraft('campaign', '在宾夕法尼亚连跑三场工会集会，同时投放一轮针对铁锈带制造业的电视广告。');
    W.AIUI.submit('campaign');
    const campDone = await waitFor(() => {
      const c = G2.campaign || {};
      return c.funds < fundsBefore || (G2.aiLog || []).length > 0;
    }, 8000);
    ok('竞选数值被结算', campDone,
      '资金 ' + fundsBefore + ' -> ' + ((G2.campaign || {}).funds) +
      '，势头 ' + momBefore + ' -> ' + ((G2.campaign || {}).momentum));
    ok('州内投入被记录', ((G2.campaign || {}).visits || {}).PA > 0,
      'visits.PA=' + ((G2.campaign || {}).visits || {}).PA);
  }

  finish();

  function finish() {
    const jsErrors = consoleErrors.filter(e => !/Could not parse CSS|Not implemented|css parsing/i.test(e));
    ok('运行期没有脚本异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
    if (failures.length) {
      console.log('\n失败明细：');
      failures.forEach(f => console.log('  - ' + f));
    }
    try { W.close(); } catch (e) {}
    process.exit(fail ? 1 : 0);
  }
})().catch(e => {
  console.error('harness 异常：', (e && e.stack) || e);
  process.exit(1);
});
