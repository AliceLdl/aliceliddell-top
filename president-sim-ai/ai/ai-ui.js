/* ============================================================================
   ai-ui.js — 界面层
   《总统模拟器 · AI 版》扩展层第 6 块
   ----------------------------------------------------------------------------
   把原版「点按钮选行动」的地方换成「写一句话交给 AI 裁决」：
     · 白宫战情室 —— 总统的本周自由行动
     · 竞选行动卡 —— 候选人的本周自由行动
     · 突发事件卡 / 弹窗 —— 自由写下处置方式
     · 重大冲击节点弹窗 —— 自由写下应对
     · 国际危机会商卡 —— 自由写下处置
   另外提供：AI 设置面板、裁决档案、请求诊断、提示词编辑与预览。
   ========================================================================== */
(function (global) {
  'use strict';

  var UI_STATE = {
    tab: 'api',            /* 设置面板当前页 */
    promptMode: 'national',
    draft: { national: '', campaign: '', decision: '', shock: '', crisis: '' },
    error: null,
    result: null,          /* 最近一次结算摘要 */
    test: null,            /* 连通性测试结果 */
    preview: null,
    modelsLoading: false,  /* 正在拉取模型列表 */
    modelsErr: '',
    modelsAt: '',
    modelsTried: false,
    tick: null
  };

  function cfg() { return global.AICFG || {}; }
  function esc(s) { return global.AI.esc(s); }
  function G() { return global.AIG.g(); }
  function busy() { return !!(global.AI.STAT && AI.STAT.busy); }
  function toast(msg) { try { if (typeof showToast === 'function') showToast(msg); } catch (e) {} }

  /* 没填 Key 且不是本地代理：提示会走离线规则 */
  function keyMissing() {
    var c = cfg();
    if (c.apiKey) return false;
    return !/127\.0\.0\.1|localhost/.test(String(c.baseUrl || ''));
  }
  function keyWarnHTML() {
    if (!keyMissing()) return '';
    return '<div class="notice" style="margin:6px 0;font-size:12px">' +
      '还没有配置 API Key：现在执行会走「本地规则」兜底（效果较粗）。' +
      '<button class="btn sm" style="margin-left:8px" onclick="AIUI.open()">去配置</button></div>';
  }
  /* file:// 打开时浏览器多半会拦跨域请求，提前说清楚 */
  function fileWarnHTML() {
    try {
      if (location && location.protocol === 'file:') {
        return '<div class="notice" style="margin:6px 0;font-size:12px">' +
          '检测到用 file:// 直接打开：浏览器通常会拦截 API 请求。' +
          '请在目录里跑 <code>python -m http.server 8080</code>，改用 http://127.0.0.1:8080 打开。</div>';
      }
    } catch (e) {}
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 样式
   * ------------------------------------------------------------------ */
  var CSS = [
    '.ai-console textarea,.ai-decision textarea,.ai-modal textarea{width:100%;box-sizing:border-box;',
    '  min-height:74px;resize:vertical;padding:9px 10px;border-radius:7px;',
    '  border:1px solid var(--line2);background:var(--panel3);color:var(--text);',
    '  font-family:var(--font);font-size:13.5px;line-height:1.6}',
    '.ai-console textarea:focus,.ai-decision textarea:focus{outline:none;border-color:var(--accent)}',
    '.ai-hint{font-size:12px;color:var(--dim);margin:2px 0 8px;line-height:1.6}',
    '.ai-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}',
    '.ai-tiny{font-size:11px;color:var(--dim2)}',
    '.ai-badge{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:4px;',
    '  font-size:10px;letter-spacing:1px;background:var(--accent);color:#100c00;font-weight:700;vertical-align:middle}',
    '.ai-badge.off{background:var(--line2);color:var(--dim)}',
    '.ai-result{margin-top:12px;border:1px solid var(--line);border-left:3px solid var(--accent);',
    '  border-radius:6px;padding:10px 12px;background:var(--panel2)}',
    '.ai-result.bad{border-left-color:var(--bad)}',
    '.ai-rhead{font-weight:600;font-size:13.5px;margin-bottom:4px}',
    '.ai-rtext{font-size:13px;line-height:1.7;color:var(--text)}',
    '.ai-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.ai-chip{font-size:11.5px;padding:2px 7px;border-radius:20px;border:1px solid var(--line2);',
    '  background:var(--panel3);color:var(--dim);white-space:nowrap}',
    '.ai-chip.pos{color:#3fa66a;border-color:#3fa66a55}',
    '.ai-chip.neg{color:#c0393b;border-color:#c0393b55}',
    '.ai-note{font-size:11.5px;color:var(--dim2);margin-top:6px;line-height:1.6}',
    '.ai-follow{font-size:12.5px;color:var(--dim);margin-top:6px;font-style:italic}',
    '.ai-src{font-size:10.5px;color:var(--dim2);font-weight:400;margin-left:6px}',
    '.ai-grade{display:inline-block;font-size:11px;font-weight:600;padding:1px 7px;border-radius:20px;',
    '  margin-right:6px;border:1px solid var(--line2);background:var(--panel3);color:var(--dim);vertical-align:1px}',
    '.ai-grade.g0{color:#c0393b;border-color:#c0393b66}',
    '.ai-grade.g1{color:#d97b2b;border-color:#d97b2b66}',
    '.ai-grade.g2{color:#d99b2b;border-color:#d99b2b66}',
    '.ai-grade.g3{color:#3fa66a;border-color:#3fa66a66}',
    '.ai-grade.g4{color:#1f9fd9;border-color:#1f9fd966}',
    '.ai-busy{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--dim)}',
    '.ai-spin{width:13px;height:13px;border:2px solid var(--line2);border-top-color:var(--accent);',
    '  border-radius:50%;animation:aipin .9s linear infinite;display:inline-block}',
    '@keyframes aipin{to{transform:rotate(360deg)}}',
    '.ai-err{margin-top:10px;font-size:12.5px;color:var(--bad);line-height:1.6}',
    '.ai-classic{margin-top:12px;padding-top:10px;border-top:1px dashed var(--line)}',
    '.ai-classic .card{border:none;background:transparent;padding:0;margin:0;box-shadow:none}',
    '.ai-classic .card>h3{display:none}',
    '.ai-hide{display:none!important}',
    '.ai-set input[type=text],.ai-set input[type=password],.ai-set input[type=number],.ai-set select,',
    '.ai-set textarea{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;',
    '  border:1px solid var(--line2);background:var(--panel3);color:var(--text);font-family:var(--font);font-size:12.5px}',
    '.ai-set label{display:block;font-size:12px;color:var(--dim);margin:10px 0 4px}',
    '.ai-set .ai-two{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
    '.ai-set .ai-three{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}',
    '.ai-tabs{display:flex;gap:6px;margin:12px 0;flex-wrap:wrap}',
    '.ai-kv{font-size:12px;line-height:1.9}',
    '.ai-kv b{font-weight:600}',
    '.ai-kv code{background:var(--panel3);padding:1px 5px;border-radius:4px;font-size:11.5px}',
    '.ai-pre{white-space:pre-wrap;word-break:break-word;font-size:11.5px;line-height:1.65;',
    '  background:var(--panel3);border:1px solid var(--line);border-radius:6px;padding:10px;',
    '  max-height:380px;overflow:auto;font-family:ui-monospace,Consolas,monospace;color:var(--dim)}',
    '.ai-check{display:flex;align-items:center;gap:8px;font-size:12.5px;margin:8px 0;color:var(--text)}',
    '.ai-check input{width:auto}',
    '.ai-prov{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}',
    '.ai-prov span{font-size:11.5px;padding:3px 9px;border:1px solid var(--line2);border-radius:20px;cursor:pointer}',
    '.ai-prov span.on{background:var(--accent);color:#100c00;border-color:var(--accent);font-weight:600}',
    '.ai-loss{font-size:11.5px;color:var(--dim);margin-top:4px}',
    /* ---- 态势简报 ---- */
    '.ai-brief{margin-top:12px;border:1px solid var(--line);border-left:3px solid var(--accent2);',
    '  border-radius:6px;padding:9px 12px;background:var(--panel3)}',
    '.ai-brief-hd{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600}',
    '.ai-brief-hd .ai-tiny{margin-left:auto;font-weight:400}',
    '.ai-brief-sum{font-size:12.5px;color:var(--text);line-height:1.65;margin-top:4px}',
    '.ai-brief-line{font-size:12px;color:var(--dim);margin-top:3px;line-height:1.6}',
    '.ai-sec{margin:14px 0 0}',
    '.ai-sec-h{font-size:11.5px;letter-spacing:1px;color:var(--dim2);margin-bottom:5px}',
    '.ai-sec .it{font-size:12.5px;line-height:1.7;padding:5px 0;border-bottom:1px dashed var(--line)}',
    '.ai-sec .it:last-child{border-bottom:none}',
    '.ai-sec .wk{font-size:10.5px;color:var(--dim2);margin-right:6px;font-family:ui-monospace,Consolas,monospace}',
    '.ai-sec .tagline{font-size:11px;color:var(--accent2);margin-left:6px}',
    '.ai-empty{font-size:12px;color:var(--dim2);padding:4px 0}'
  ].join('\n');

  function injectCSS() {
    try {
      if (document.getElementById('ai-layer-style')) return;
      var st = document.createElement('style');
      st.id = 'ai-layer-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 公共片段
   * ------------------------------------------------------------------ */
  function busyHTML() {
    if (!busy()) return '';
    var secs = Math.max(0, Math.round((Date.now() - (AI.STAT.startedAt || Date.now())) / 1000));
    return '<div class="ai-busy" id="aibusy"><span class="ai-spin"></span>' +
      '<span>AI 正在裁决' + (AI.STAT.busyLabel ? '（' + esc(AI.STAT.busyLabel) + '）' : '') +
      '… 已等待 <b id="aibusy-t">' + secs + '</b> 秒</span>' +
      '<button class="btn sm" style="margin-left:auto" onclick="AIUI.cancel()">取消</button></div>';
  }

  function errorHTML() {
    if (!UI_STATE.error) return '';
    return '<div class="ai-err">⚠ ' + esc(UI_STATE.error) + '</div>';
  }

  function resultHTML() {
    var r = UI_STATE.result;
    if (!r) return '';
    var cls = r.ok ? '' : ' bad';
    var gcls = 'g' + (r.grade == null ? 3 : Math.max(0, Math.min(4, r.grade)));
    var grade = r.gradeCN ? '<span class="ai-grade ' + gcls + '">' + esc(r.gradeCN) + '</span>' : '';
    var head = r.ok ? (grade + '【' + esc(r.headline) + '】') : (grade || '✕ 指令未执行');
    var src = (r.source === 'offline' ? '本地规则' : 'AI');
    var meta = src + ' · ' + (cfg().model || '') +
      (r.apCost ? ' · ' + r.apCost + ' 行动点' : '') +
      (r.risk ? ' · 风险 ' + ({ low: '低', medium: '中', high: '高' }[r.risk] || r.risk) : '');
    var chips = (r.chips || []).map(function (c) {
      var s = (c.v > 0 ? '+' : '') + c.v + (c.unit || '');
      return '<span class="ai-chip ' + (c.pos ? 'pos' : 'neg') + '">' + esc(c.label) + ' ' + esc(s) + '</span>';
    }).join('');
    return '<div class="ai-result' + cls + '">' +
      '<div class="ai-rhead">' + head + '<span class="ai-src">' + esc(meta) + '</span></div>' +
      '<div class="ai-rtext">' + esc(r.narrative || r.rejectReason || '') + '</div>' +
      (chips ? '<div class="ai-chips">' + chips + '</div>' : '') +
      (r.bill ? '<div class="ai-note">已进入起草：《' + esc(r.bill) + '》</div>' : '') +
      (r.followup ? '<div class="ai-follow">' + esc(r.followup) + '</div>' : '') +
      ((r.notes && r.notes.length) ? '<div class="ai-note">注：' + esc(r.notes.join('；')) + '</div>' : '') +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 态势简报（玩家可见的账）
   * ------------------------------------------------------------------ */
  function briefState() {
    try { return global.AILEDGER ? global.AILEDGER.ensure() : null; } catch (e) { return null; }
  }

  function secHTML(title, items, mapper) {
    if (!items || !items.length) return '';
    return '<div class="ai-sec"><div class="ai-sec-h">' + title + '</div>' +
      items.map(function (x) { return '<div class="it">' + mapper(x) + '</div>'; }).join('') +
      '</div>';
  }

  function briefSummaryHTML() {
    var s = briefState();
    if (!s) return '';
    var st = global.AILEDGER.stats();
    var empty = !s.brief.summary && !st.actions && !st.external && !st.commitments;
    var head = '<div class="ai-brief-hd">态势简报' +
      '<span class="ai-tiny">' +
      (empty ? '尚无记录' : ('行动 ' + st.actions + ' · 外部事件 ' + st.external +
        (st.commitments ? ' · 待办 ' + st.commitments : '') +
        (st.risks ? ' · 风险 ' + st.risks : '') + ' · 更新于 ' + (st.updated || '—'))) +
      '<button class="btn sm" style="margin-left:8px" onclick="AIUI.openBrief()">查看</button>' +
      '</span></div>';
    var body = empty
      ? '<div class="ai-brief-sum">每次裁决后，AI 会把「谁下了什么命令、谁在等答复、哪颗雷还没爆」记进这里，' +
        '并把事件的影响一直带在上下文里。</div>'
      : (s.brief.summary ? '<div class="ai-brief-sum">' + esc(s.brief.summary) + '</div>' : '') +
        (s.brief.risks && s.brief.risks.length
          ? '<div class="ai-brief-line">风险提示：' + esc(s.brief.risks.slice(-2).map(function (r) { return r.t; }).join('；')) + '</div>'
          : '');
    return '<div class="ai-brief">' + head + body + '</div>';
  }

  function briefModalHTML() {
    var s = briefState();
    if (!s) return '';
    var st = global.AILEDGER.stats();
    var b = s.brief;
    var body = '';
    if (b.summary) body += '<div class="ai-brief-sum" style="font-size:13.5px">' + esc(b.summary) + '</div>';
    body += secHTML('局势要点', b.situation, function (t) { return esc(t); });
    body += secHTML('最近行动', b.actions.slice().reverse(), function (a) {
      return '<span class="wk">' + esc(a.w || '') + '</span>' + esc(a.t) +
        (a.outcome ? '<div class="ai-brief-line">→ ' + esc(a.outcome) + '</div>' : '') +
        ((a.tags && a.tags.length) ? '<span class="tagline">' + esc(a.tags.join(' / ')) + '</span>' : '');
    });
    body += secHTML('外部事件', b.external.slice().reverse(), function (a) {
      return '<span class="wk">' + esc(a.w || '') + '</span>' + esc(a.t) +
        (a.impact ? '<div class="ai-brief-line">影响：' + esc(a.impact) + '</div>' : '');
    });
    body += secHTML('承诺与期限', b.commitments, function (a) {
      return '<span class="wk">' + esc(a.w || '') + '</span>' + esc(a.t) +
        (a.due ? '<span class="tagline">期限：' + esc(a.due) + '</span>' : '') +
        '<span class="tagline">' + esc(a.status === 'done' ? '已完成' : (a.status || '进行中')) + '</span>';
    });
    body += secHTML('关键人物与机构', b.actors.slice().reverse(), function (a) {
      return '<b>' + esc(a.who) + '</b>：' + esc(a.stance) +
        '<span class="wk" style="margin-left:6px">' + esc(a.w || '') + '</span>';
    });
    body += secHTML('已知风险', b.risks.slice().reverse(), function (a) {
      return '<span class="wk">' + esc(a.w || '') + '</span>' + esc(a.t);
    });
    if (!body) body = '<div class="ai-empty">还没有记录。先在战情室下一条命令。</div>';

    return '<div class="modal ai-modal"><div class="box" style="max-width:780px;position:relative;max-height:88vh;overflow:auto">' +
      '<button class="btn sm" style="position:absolute;top:12px;right:12px;z-index:5" onclick="AIUI.closeModal()">✕</button>' +
      '<div class="kicker">SITUATION BRIEF · 态势简报</div>' +
      '<h2 style="padding-right:60px">白宫态势简报</h2>' +
      '<div class="ai-tiny" style="margin-bottom:10px">' +
      esc(global.AILEDGER.dateCN()) + '　·　更新于 ' + esc(st.updated || '—') +
      '　·　行动 ' + st.actions + ' / 外部事件 ' + st.external + ' / 承诺 ' + st.commitments +
      '　·　距上次整理 ' + st.sinceMaintain + ' 次</div>' +
      body +
      '<div class="ai-row" style="margin-top:16px">' +
      '<button class="btn primary sm" onclick="AIHOOKS.maintain(true)"' + (busy() ? ' disabled' : '') + '>整理态势</button>' +
      '<button class="btn sm" onclick="AIUI.clearBrief()">清空简报</button>' +
      '<span class="ai-tiny">整理＝让 AI 把重复的合并、过期的删掉；失败时本地压缩。</span>' +
      '</div>' +
      '<div class="ai-tiny" style="margin-top:10px">这里只显示玩家可见层。裁决引擎另有一份更详细的内部档案，' +
      '记录它掌握的隐藏事实与因果链，只在提示词里使用，不出现在界面上。</div>' +
      '</div></div>';
  }

  function openBrief() {
    UI.modal = { type: 'aibrief' };
    if (typeof render === 'function') render();
  }

  function clearBrief() {
    try { global.AILEDGER.reset(); } catch (e) {}
    if (typeof showToast === 'function') showToast('态势简报已清空（内部档案一并重置）。');
    UI.modal = null;
    if (typeof render === 'function') render();
  }

  function classicHTML(kind) {    if (!cfg().showClassic) return '';
    var inner = '';
    try {
      if (kind === 'national' && global.AIORIG && AIORIG.presActionsPane) inner = AIORIG.presActionsPane();
      else if (kind === 'campaign' && global.AIORIG && AIORIG.camp2ActionsHTML) inner = AIORIG.camp2ActionsHTML();
      else if (kind === 'event' && global.AIORIG && AIORIG.eventChoicesHTML) inner = AIORIG.eventChoicesHTML();
      else if (kind === 'shock' && global.AIORIG && AIORIG.shockChoicesHTML) inner = AIORIG.shockChoicesHTML();
      else if (kind === 'crisis' && global.AIORIG && AIORIG.crisisChoicesHTML) inner = AIORIG.crisisChoicesHTML();
    } catch (e) {}
    if (!inner) return '';
    return '<details class="ai-classic"><summary class="ai-tiny" style="cursor:pointer">' +
      '经典内置选项（备用：AI 不可用时仍可照常游玩）</summary>' + inner + '</details>';
  }

  function draftBox(kind, placeholder, rows) {
    var v = UI_STATE.draft[kind] || '';
    var disabled = busy() ? ' disabled' : '';
    return '<textarea rows="' + (rows || 3) + '"' + disabled +
      ' placeholder="' + esc(placeholder) + '"' +
      ' oninput="AIUI.setDraft(\'' + kind + '\',this.value)"' +
      ' onkeydown="if(event.ctrlKey&&event.key===\'Enter\'){event.preventDefault();AIUI.submit(\'' + kind + '\');}">' +
      esc(v) + '</textarea>';
  }

  /* ------------------------------------------------------------------ *
   * 一、白宫战情室（总统执政行动）
   * ------------------------------------------------------------------ */
  function nationalConsoleHTML() {
    var g = G();
    if (!g) return '';
    var ap = g.ap || 0;
    return '<div class="card ai-console"><h3>白宫战情室' +
      '<span class="ai-badge">AI</span>' +
      '<span class="sub">自由指令 · 行动点 ' + ap + ' / ' + g.apMax + '</span></h3>' +
      '<div class="ai-hint">写下本周你要做的事——对象、手段、力度说清楚即可。AI 会按当前局势判断能否执行、花几个行动点、以及国内外会怎么反应。' +
      (ap <= 0 ? '<br><b style="color:var(--bad)">本周行动点已用尽。</b>' : '') + '</div>' +
      keyWarnHTML() + fileWarnHTML() +
      draftBox('national', '例：今晚黄金时段发表全国电视讲话，宣布把处方药价格上限写进行政令，并要求国会两周内跟进立法。') +
      '<div class="ai-row">' +
      '<button class="btn primary sm" onclick="AIUI.submit(\'national\')"' + (busy() || ap <= 0 ? ' disabled' : '') + '>执行</button>' +
      '<button class="btn sm" onclick="AIUI.openBrief()">态势简报</button>' +
      '<button class="btn sm" onclick="AISet.open()">AI 设置</button>' +
      '<button class="btn sm" onclick="AIUI.openHistory()">裁决档案</button>' +
      '<span class="ai-tiny">Ctrl+Enter 提交 · 行动点由 AI 判定（0~3）</span>' +
      '</div>' +
      busyHTML() + errorHTML() + resultHTML() + briefSummaryHTML() + classicHTML('national') +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 二、竞选行动台
   * ------------------------------------------------------------------ */
  function campaignConsoleHTML() {
    var g = G();
    if (!g) return '';
    var c = {};
    try { c = global.ensureCamp ? ensureCamp() : (g.campaign || {}); } catch (e) {}
    return '<div class="card ai-console"><h3>竞选行动' +
      '<span class="ai-badge">AI</span>' +
      '<span class="sub">行动点 ' + (g.ap || 0) + ' · 资金 $' + Math.round(c.funds || 0) + 'M · 体力 ' + Math.round(c.energy == null ? 100 : c.energy) + '</span></h3>' +
      '<div class="ai-hint">这一周你怎么打？AI 只结算竞选层面的东西（势头、资金、体力、知名度、地面组织、州内投入），不会动用总统权力。</div>' +
      keyWarnHTML() + fileWarnHTML() +
      draftBox('campaign', '例：在宾夕法尼亚连跑三场工会集会，同时投放一轮针对铁锈带制造业的电视广告。') +
      '<div class="ai-row">' +
      '<button class="btn primary sm" onclick="AIUI.submit(\'campaign\')"' + (busy() ? ' disabled' : '') + '>执行</button>' +
      '<button class="btn sm" onclick="AIUI.openBrief()">态势简报</button>' +
      '<button class="btn sm" onclick="AISet.open()">AI 设置</button>' +
      '<button class="btn sm" onclick="AIUI.openHistory()">裁决档案</button>' +
      '<span class="ai-tiny">Ctrl+Enter 提交</span>' +
      '</div>' +
      busyHTML() + errorHTML() + resultHTML() + briefSummaryHTML() + classicHTML('campaign') +
      '</div>';
  }

  /* 初选阶段的原版行动区是一个内联按钮行，塞不进整块输入台：
     这里改成一个按钮，点开弹出完整的竞选行动台。 */
  function campaignModalHTML() {
    return '<div class="modal ai-modal"><div class="box" style="max-width:680px">' +
      '<div class="kicker">CAMPAIGN · 竞选行动</div>' +
      '<h2>这一周怎么打</h2>' +
      '<div class="ai-hint">用一句话安排本周的竞选：去哪、做什么、花多少钱、打什么议题。' +
      'AI 只结算竞选数值（势头、资金、体力、知名度、地面组织、州内投入）。</div>' +
      draftBox('campaign', '例：在宾夕法尼亚连跑三场工会集会，同时投放一轮针对铁锈带制造业的电视广告。', 4) +
      '<div class="ai-row">' +
      '<button class="btn primary sm" onclick="AIUI.submit(\'campaign\')"' + (busy() ? ' disabled' : '') + '>执行</button>' +
      '<button class="btn sm" onclick="AIUI.closeModal()">稍后再说</button>' +
      '<span class="ai-tiny">Ctrl+Enter 提交</span>' +
      '</div>' + busyHTML() + errorHTML() + resultHTML() + classicHTML('campaign') +
      '</div></div>';
  }

  function openCampaign() {
    UI.modal = { type: 'aicampaign' };
    if (typeof render === 'function') render();
  }
  function closeModal() {
    UI.modal = null;
    if (typeof render === 'function') render();
  }

  /* ------------------------------------------------------------------ *
   * 三、突发事件决断
   * ------------------------------------------------------------------ */  function decisionBodyHTML(title, text, sub, kind, extraLine) {
    return '<div class="ai-hint">用自己的话写下你的处置——下命令、表态、拖一拖，都行。AI 会判断这一步的代价与后果。</div>' +
      draftBox(kind || 'decision', '例：今天下午就召开记者会，宣布联邦接管现场救援，并要求国会四十八小时内通过追加拨款。', 4) +
      '<div class="ai-row">' +
      '<button class="btn primary sm" onclick="AIUI.submit(\'' + (kind || 'decision') + '\')"' + (busy() ? ' disabled' : '') + '>提交决定</button>' +
      '<button class="btn sm" onclick="AISet.open()">AI 设置</button>' +
      '<span class="ai-tiny">Ctrl+Enter 提交</span>' +
      '</div>' + busyHTML() + errorHTML() + resultHTML() + (extraLine || '');
  }

  function eventCardHTML(pe) {
    if (!pe || !pe.ev) return '';
    var ev = pe.ev;
    return '<div class="card ai-decision" style="border-color:#8d7018">' +
      '<h3>⚠ ' + esc(ev.cn || '突发事件') + '<span class="ai-badge">AI</span>' +
      '<span class="sub">' + (ev.m != null ? esc(MONTHS_CN ? MONTHS_CN[ev.m] : '') : '') + '</span></h3>' +
      '<p style="font-size:13.5px;color:var(--text)">' + esc(pe.txt || ev.t || '') + '</p>' +
      decisionBodyHTML(ev.cn, pe.txt || ev.t, '', 'decision', classicHTML('event')) +
      '</div>';
  }

  function eventModalHTML(pe) {
    if (!pe || !pe.ev) return '';
    var ev = pe.ev;
    var m = (ev.crisis ? (typeof monthOfWeek === 'function' ? monthOfWeek(G().w) : 1) : (ev.m || 0));
    return '<div class="modal"><div class="box ai-modal" style="max-width:680px">' +
      '<div class="kicker">BREAKING · ' + (G().y) + '年' + esc(MONTHS_CN ? MONTHS_CN[Math.max(0, m - (ev.crisis ? 1 : 0))] : '') + '</div>' +
      '<h2>' + esc(ev.cn || '突发事件') + '</h2>' +
      '<p>' + esc(pe.txt || ev.t || '') + '</p>' +
      decisionBodyHTML(ev.cn, pe.txt, '', 'decision', classicHTML('event')) +
      '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 四、重大冲击节点
   * ------------------------------------------------------------------ */
  function shockModalHTML() {
    var m = UI && UI.modal;
    if (!m || m.type !== 'shockev' || !m.shock) return '';
    var k = m.shock, ev = m.ev;
    var def = (ERA_SHOCKS && ERA_SHOCKS[k]) || {};
    var pct = 0, acted = 0;
    try { pct = Math.round(global.shockScore(k) * 100); } catch (e) {}
    try { acted = (G().shocks[k] || {}).acted || 0; } catch (e) {}
    var txt = '';
    try { txt = (typeof evTextNow === 'function') ? evTextNow(ev) : (ev.t || ''); } catch (e) { txt = ev.t || ''; }
    var soft = pct >= 50
      ? '<div class="notice" style="margin:10px 0;font-size:12.5px">得益于已实施的措施（应对进度 ' + pct + '%），这一次的负面冲击会被削弱。</div>'
      : '';
    return '<div class="modal"><div class="box ai-modal" style="max-width:680px;border-color:var(--accent)">' +
      '<div class="kicker">SHOCK · ' + esc(def.cn || '重大冲击') + '</div>' +
      '<h2>' + esc(ev.cn || def.cn || '') + '</h2>' +
      '<p style="font-size:13.5px">' + esc(txt) + '</p>' + soft +
      '<div class="ai-hint">这一步你打算怎么处置？资源型、制度型、表态型都可以写。</div>' +
      draftBox('shock', '例：立即要求财政部与联储联合设立商业票据融资便利，并向国会提交 7000 亿美元的资产购买授权。', 4) +
      '<div class="ai-row">' +
      '<button class="btn primary sm" onclick="AIUI.submit(\'shock\')"' + (busy() ? ' disabled' : '') + '>提交处置</button>' +
      '<button class="btn sm" onclick="AIUI.dismissShock()">稍后处理</button>' +
      '<span class="ai-tiny">应对进度 ' + pct + '% · 已处理节点 ' + acted + ' 个</span>' +
      '</div>' + busyHTML() + errorHTML() + resultHTML() + classicHTML('shock') +
      '</div></div>';
  }

  function dismissShock() {
    /* 把弹窗收掉，但事件保留在 pendingEv，下次冲击周还会再弹 */
    try { UI.modal = null; } catch (e) {}
    if (typeof render === 'function') render();
  }

  /* ------------------------------------------------------------------ *
   * 五、国际危机
   * ------------------------------------------------------------------ */
  function crisisPaneHTML() {
    var sel = UI && UI.selCrisis;
    var g = G();
    if (!sel) {
      return '<div class="card"><h3>国际焦点</h3><div class="muted">当前没有正在处理的国际危机。</div></div>';
    }
    var c = null;
    try { c = global.activeCrisis(sel); } catch (e) {}
    if (!c) return '<div class="card"><h3>国际焦点</h3><div class="muted">这场危机已经结束。</div></div>';
    var def = null;
    try { def = global.crisisDef(c.id); } catch (e) {}
    var cdLeft = 0;
    try {
      cdLeft = (typeof crisisOnCooldown === 'function' && crisisOnCooldown(c))
        ? Math.max(1, (c.nextAt || 0) - absWeek()) : 0;
    } catch (e) {}

    /* 当前阶段的文本 */
    var txt = '';
    try {
      var st = (def && def.stages && def.stages.length)
        ? def.stages[Math.min(c.stage || 0, def.stages.length - 1)] : { t: '' };
      var evNode = (def && def.events && typeof crisisCurrentEvent === 'function') ? crisisCurrentEvent(c, def) : null;
      var tNode = (!evNode && typeof crisisNodeOf === 'function') ? crisisNodeOf(c, def) : null;
      var stageTxt = evNode ? evNode.t : (tNode ? tNode.t : st.t);
      txt = (typeof evTextNow === 'function') ? evTextNow(evNode || stageTxt) : String(stageTxt || '');
      if (!txt && def && def.hist) txt = def.hist;
    } catch (e) {}

    var inv = c.involvement || 0;
    return '<div class="card ai-decision" style="border-color:var(--accent)">' +
      '<h3>' + esc(c.cn) + '<span class="ai-badge">AI</span>' +
      '<span class="sub">' + esc(c.region || (def && def.region) || '国际') +
      (c.law ? ' · 已获军事授权' : '') + '</span></h3>' +
      '<p style="font-size:13.5px">' + (cdLeft > 0 ? '局势正在发展，尚未出现新的动向。' : esc(txt)) + '</p>' +
      (def && def.hist ? '<div class="tiny" style="margin-top:4px">背景：' + esc(def.hist) + '</div>' : '') +
      '<div class="row" style="margin-top:10px">' +
      '<span class="tag ' + (inv >= 2 ? 'R' : (inv === 1 ? 'y' : 'n')) + '">介入程度：' +
      (inv >= 2 ? '直接介入' : (inv === 1 ? '有限介入' : '未介入')) + '</span>' +
      (c.law ? '<span class="tag g">已获国会军事授权</span>' : '<span class="tag n">尚无军事授权</span>') +
      '</div>' +
      (cdLeft > 0
        ? '<div class="notice" style="margin:10px 0">局势正在发展，约 <b>' + cdLeft + '</b> 周后会有新的进展，此时无法推进。</div>'
        : '<hr>' + '<div class="ai-hint">你想怎么处置？军事授权要走国会，直接派兵不需要，但代价不同。</div>' +
          draftBox('crisis', '例：先与盟友协调，公开提出停火方案；同时把航母战斗群前移，作为谈不拢时的筹码。', 4) +
          '<div class="ai-row">' +
          '<button class="btn primary sm" onclick="AIUI.submit(\'crisis\')"' + (busy() ? ' disabled' : '') + '>提交处置</button>' +
          '<button class="btn sm" onclick="AIUI.deferCrisis()">暂缓处置</button>' +
          '<span class="ai-tiny">暂缓：紧张度上升、支持率下降</span>' +
          '</div>') +
      busyHTML() + errorHTML() + resultHTML() + classicHTML('crisis') +
      '<div class="row" style="margin-top:12px">' +
      '<button class="btn sm" onclick="UI.selCrisis=null;UI.tab=\'world\';render()">← 返回世界地图</button>' +
      '</div></div>';
  }

  function deferCrisis() {
    var cid = (UI && UI.selCrisis) || '';
    if (cid && typeof crisisDefer === 'function') { crisisDefer(cid); return; }
    if (typeof render === 'function') render();
  }

  /* ------------------------------------------------------------------ *
   * 六、设置面板
   * ------------------------------------------------------------------ */
  var PROMPT_TABS = [
    ['system', '系统提示词'], ['task_national', '任务·执政'], ['task_campaign', '任务·竞选'],
    ['task_event', '任务·事件'], ['task_shock', '任务·冲击'], ['task_crisis', '任务·危机'],
    ['task_maintain', '任务·整理'], ['task_press', '任务·舆论'],
    ['task_press_outlet', '任务·媒体版面']
  ];

  function tabBtn(id, cn) {
    return '<button class="btn sm' + (UI_STATE.tab === id ? ' primary' : '') +
      '" onclick="AIUI.setTab(\'' + id + '\')">' + cn + '</button>';
  }

  /* ------------------------------------------------------------------ *
   * 模型列表：状态 / 候选 / 芯片
   * ------------------------------------------------------------------ */
  function cachedModels() {
    try { return AI.modelList(); } catch (e) { return null; }
  }

  function modelStatusHTML() {
    if (UI_STATE.modelsLoading) return '正在向接口拉取模型列表…';
    if (UI_STATE.modelsErr) return '<span style="color:var(--bad)">' + esc(UI_STATE.modelsErr) + '</span>';
    var list = cachedModels();
    if (list && list.models.length) {
      return '已缓存 ' + list.models.length + ' 个模型 · ' + esc(list.at || '') +
             '　（点右侧「拉取列表」可刷新）';
    }
    var fb = (AI.providerPreset(cfg().provider) || {}).fallback || [];
    if (fb.length) return '还没有拉取过，先用预设里的 ' + fb.length + ' 个候选（可手输任意模型名）';
    return '可手输模型名，或点「拉取列表」自动获取';
  }

  function modelOptionsHTML() {
    var list = cachedModels();
    if (!list) return '';
    return list.models.map(function (id) {
      return '<option value="' + esc(id) + '"></option>';
    }).join('');
  }

  function modelChipsHTML() {
    var list = cachedModels();
    if (!list) return '';
    var cur = cfg().model || '';
    var max = 10;
    return '<div class="ai-prov" style="margin-top:8px">' +
      list.models.slice(0, max).map(function (id, i) {
        return '<span class="' + (id === cur ? 'on' : '') +
          '" onclick="AIUI.setModelByIdx(' + i + ')" title="' + esc(id) + '">' + esc(id) + '</span>';
      }).join('') +
      (list.models.length > max ? '<span style="opacity:.6;cursor:default">共 ' + list.models.length + ' 个…</span>' : '') +
      '</div>';
  }

  function setModelByIdx(i) {
    var list = cachedModels();
    if (!list || !list.models[i]) return;
    AI.set({ model: list.models[i] });
    if (typeof render === 'function') render();
  }

  function fetchModels(manual) {
    if (UI_STATE.modelsLoading) return;
    if (global.AI.STAT.busy) {
      if (manual) toast('正在生成内容，稍后再拉取。');
      return;
    }
    var c = cfg();
    if (!c.baseUrl) {
      UI_STATE.modelsErr = '先填接口地址，再拉取模型列表。';
      if (manual) toast(UI_STATE.modelsErr);
      if (typeof render === 'function') render();
      return;
    }
    UI_STATE.modelsLoading = true;
    UI_STATE.modelsErr = '';
    if (typeof render === 'function') render();
    global.AICLIENT.models().then(function (res) {
      AI.setModelList(res.models.map(function (x) { return x.id; }), res.at);
      UI_STATE.modelsLoading = false;
      UI_STATE.modelsAt = res.at;
      UI_STATE.modelsTried = true;
      if (!cfg().model && res.models.length) AI.set({ model: res.models[0].id });
      if (manual) toast('拉到 ' + res.models.length + ' 个模型。');
    }).catch(function (e) {
      UI_STATE.modelsLoading = false;
      UI_STATE.modelsTried = true;
      UI_STATE.modelsErr = (e && e.message) ? e.message : String(e);
      if (manual) toast('拉取失败：' + UI_STATE.modelsErr.slice(0, 60));
    }).then(function () {
      if (typeof render === 'function') render();
    });
  }

  function apiTabHTML() {
    var c = cfg();
    var provs = (AI.PROVIDERS || []).map(function (p) {
      var on = (c.baseUrl || '') === p.baseUrl ? ' on' : '';
      return '<span class="' + on.trim() + '" onclick="AIUI.usePreset(\'' + p.id + '\')" title="' +
        esc(p.note) + '">' + esc(p.cn) + '</span>';
    }).join('');
    var cur = AI.providerPreset(c.provider === 'openai' ? 'openai' : c.provider);
    return '<div class="ai-set">' +
      '<label>服务商预设（点一下自动填地址与模型）</label><div class="ai-prov">' + provs + '</div>' +
      '<div class="ai-loss">' + esc(cur.note || '') + '</div>' +
      fileWarnHTML() +

      '<div class="ai-two">' +
        '<div><label>协议</label><select onchange="AIUI.setCfg({provider:this.value})">' +
        ['openai', 'anthropic', 'gemini', 'custom'].map(function (p) {
          return '<option value="' + p + '"' + (c.provider === p ? ' selected' : '') + '>' +
            ({ openai: 'OpenAI 兼容 /chat/completions', anthropic: 'Anthropic /v1/messages',
               gemini: 'Google generateContent', custom: '自定义（同 OpenAI 协议 + 自定义头）' }[p]) + '</option>';
        }).join('') + '</select></div>' +
        '<div><label>模型</label>' +
          '<div style="display:flex;gap:6px">' +
            '<input type="text" list="ai-model-list" value="' + esc(c.model) + '" ' +
            'onchange="AIUI.setCfg({model:this.value.trim()})" placeholder="deepseek-chat" style="flex:1;min-width:0">' +
            '<button class="btn sm" onclick="AIUI.fetchModels(true)"' +
            (busy() || UI_STATE.modelsLoading ? ' disabled' : '') + '>' +
            (UI_STATE.modelsLoading ? '拉取中…' : '拉取列表') + '</button>' +
          '</div>' +
          '<div class="ai-tiny" style="margin-top:4px">' + modelStatusHTML() + '</div>' +
        '</div>' +
      '</div>' +
      modelChipsHTML() +
      '<datalist id="ai-model-list">' + modelOptionsHTML() + '</datalist>' +

      '<label>接口地址（base URL，不含 /chat/completions）</label>' +
      '<input type="text" value="' + esc(c.baseUrl) + '" onchange="AIUI.setCfg({baseUrl:this.value.trim()})" ' +
      'placeholder="https://api.deepseek.com/v1">' +

      '<label>API Key（只存在这台机器的 localStorage 里，不会上传到别处）</label>' +
      '<input type="password" value="' + esc(c.apiKey) + '" onchange="AIUI.setCfg({apiKey:this.value.trim()})" ' +
      'placeholder="sk-...">' +

      '<div class="ai-three">' +
        '<div><label>温度</label><input type="number" step="0.05" min="0" max="2" value="' + c.temperature +
        '" onchange="AIUI.setCfg({temperature:Number(this.value)})"></div>' +
        '<div><label>最大输出 token</label><input type="number" step="50" min="200" max="8000" value="' + c.maxTokens +
        '" onchange="AIUI.setCfg({maxTokens:Number(this.value)})"></div>' +
        '<div><label>超时（毫秒）</label><input type="number" step="5000" min="5000" max="300000" value="' + c.timeoutMs +
        '" onchange="AIUI.setCfg({timeoutMs:Number(this.value)})"></div>' +
      '</div>' +

      (c.provider === 'custom'
        ? '<label>自定义请求头（JSON，例如 {"x-api-key":"..."}）</label>' +
          '<textarea rows="3" onchange="AIUI.setCfg({customHeaders:this.value})">' + esc(c.customHeaders) + '</textarea>'
        : '') +

      '<div class="ai-row" style="margin-top:14px">' +
      '<button class="btn primary sm" onclick="AIUI.test()"' + (busy() ? ' disabled' : '') + '>测试连接</button>' +
      '<button class="btn sm" onclick="AIUI.useProxy()" title="把接口地址切到 http://127.0.0.1:8787/v1（先运行 node ai/proxy.js）">改用本地代理</button>' +
      '<span class="ai-tiny">会向接口发一条极小的请求，只验证地址、密钥与返回格式是否通。浏览器直连被 CORS 挡时，用本地代理。</span></div>' +
      testHTML() +
      '</div>';
  }

  function testHTML() {
    var t = UI_STATE.test;
    if (!t) return '';
    var ok = t.ok;
    return '<div class="ai-result' + (ok ? '' : ' bad') + '">' +
      '<div class="ai-rhead">' + (ok ? '✓ 连接正常' : '✕ 连接失败') + '</div>' +
      '<div class="ai-kv">' +
      '<div>协议：<code>' + esc(cfg().provider) + '</code>　模型：<code>' + esc(t.model || cfg().model) + '</code></div>' +
      '<div>耗时：<b>' + (t.ms || 0) + ' ms</b>　用量：输入 ' + ((t.usage && t.usage.input) || 0) +
      ' / 输出 ' + ((t.usage && t.usage.output) || 0) + ' token</div>' +
      '<div>端点：<code>' + esc(t.endpoint || '') + '</code></div>' +
      (t.parseError ? '<div style="color:var(--bad)">返回内容无法解析：' + esc(t.parseError) + '</div>' : '') +
      '<div class="ai-note">原始返回：' + esc(t.text || '') + '</div>' +
      '</div></div>';
  }

  function playTabHTML() {
    var c = cfg();
    return '<div class="ai-set">' +
      '<label>上下文深度（越大越聪明，也越费 token）</label>' +
      '<select onchange="AIUI.setCfg({contextLevel:this.value})">' +
      [['lite', '精简：只给核心数字（省 token，8k 模型友好）'],
       ['standard', '标准：局势 + 国会 + 世界 + 危机 + 近期新闻'],
       ['deep', '详细：再加重点州、统计、18 条新闻（16k+ 模型）']].map(function (o) {
        return '<option value="' + o[0] + '"' + (c.contextLevel === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>' +

      '<label>叙事风格</label>' +
      '<select onchange="AIUI.setCfg({style:this.value})">' +
      [['documentary', '白宫纪事（克制、机构感）'],
       ['news', '通讯社快讯（短句、消息源）'],
       ['novel', '政治小说（允许气氛）']].map(function (o) {
        return '<option value="' + o[0] + '"' + (c.style === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>' +

      '<label>数值严格度（上限倍率：' + c.strict + '）</label>' +
      '<input type="range" min="0.4" max="1.6" step="0.05" value="' + c.strict +
      '" oninput="this.nextElementSibling.textContent=this.value" ' +
      'onchange="AIUI.setCfg({strict:Number(this.value)})">' +
      '<div class="ai-tiny">' + c.strict + '　0.6 = 保守（效果更小、更稳）；1.5 = 宽松（更容易出大新闻）</div>' +

      '<div class="ai-check"><input type="checkbox" id="ai-cv"' + (c.variance ? ' checked' : '') +
      ' onchange="AIUI.setCfg({variance:this.checked})"><label for="ai-cv" style="margin:0">数值随机扰动（±22%：同一句话的力度不会每次都一模一样；成败只由 AI 档位决定）</label></div>' +

      '<div class="ai-check"><input type="checkbox" id="ai-gm"' + (c.godMode ? ' checked' : '') +
      ' onchange="AIUI.setCfg({godMode:this.checked})"><label for="ai-gm" style="margin:0">上帝模式：行动不会失败或被阻碍（只改提示词；行动点照常消耗、数值上限照旧）</label></div>' +

      '<div class="ai-check"><input type="checkbox" id="ai-of"' + (c.offlineFallback ? ' checked' : '') +
      ' onchange="AIUI.setCfg({offlineFallback:this.checked})"><label for="ai-of" style="margin:0">接口不可用时用本地规则裁决（离线也能玩，但效果较粗）</label></div>' +

      '<div class="ai-check"><input type="checkbox" id="ai-sc"' + (c.showClassic ? ' checked' : '') +
      ' onchange="AIUI.setCfg({showClassic:this.checked})"><label for="ai-sc" style="margin:0">保留原版内置行动/选项（折叠显示，备用）</label></div>' +

      '<div class="sechead" style="margin-top:16px">叙事账本（态势简报 / 内部档案）</div>' +
      '<div class="ai-check"><input type="checkbox" id="ai-lp"' + (c.ledgerInPrompt ? ' checked' : '') +
      ' onchange="AIUI.setCfg({ledgerInPrompt:this.checked})"><label for="ai-lp" style="margin:0">把账本喂给 AI（关掉能省 token，但 AI 会失忆、前后矛盾）</label></div>' +

      '<div class="ai-check"><input type="checkbox" id="ai-ma"' + (c.maintainAuto ? ' checked' : '') +
      ' onchange="AIUI.setCfg({maintainAuto:this.checked})"><label for="ai-ma" style="margin:0">自动整理（攒够次数后让 AI 合并重复、删掉过期条目）</label></div>' +

      '<label>每多少次裁决整理一次（当前 ' + c.maintainEvery + '）</label>' +
      '<input type="number" min="1" max="50" step="1" value="' + c.maintainEvery +
      '" onchange="AIUI.setCfg({maintainEvery:Number(this.value)})">' +

      '<div class="sechead" style="margin-top:16px">舆论场（媒体 + 民间信息流）</div>' +
      '<div class="ai-check"><input type="checkbox" id="ai-pa"' + (c.pressAuto ? ' checked' : '') +
      ' onchange="AIUI.setCfg({pressAuto:this.checked})"><label for="ai-pa" style="margin:0">自动更新舆论（推进到一定周数后悄悄换一版）</label></div>' +

      '<div class="ai-two">' +
        '<div><label>每几周换一版（当前 ' + c.pressEvery + '）</label>' +
        '<input type="number" min="1" max="12" step="1" value="' + c.pressEvery +
        '" onchange="AIUI.setCfg({pressEvery:Number(this.value)})"></div>' +
        '<div><label>民间发言条数（当前 ' + c.pressPosts + '）</label>' +
        '<input type="number" min="8" max="14" step="1" value="' + c.pressPosts +
        '" onchange="AIUI.setCfg({pressPosts:Number(this.value)})"></div>' +
      '</div>' +
      '<div class="ai-row"><button class="btn sm" onclick="AIPRESS_UI.openTab()">打开舆论场</button></div>' +

      '<label>前情提要 / 剧情记忆（每次请求都会带上，可写人物关系、你的执政路线、想延续的伏笔）</label>' +
      '<textarea rows="6" onchange="AIUI.setCfg({memory:this.value})" placeholder="例：本局我走的是里根式减税路线，但与工会关系极差；2022 年中期选举后众议院归共和党。">' +
      esc(c.memory) + '</textarea>' +

      '<div class="ai-row"><button class="btn sm" onclick="AIUI.openHistory()">查看裁决档案</button>' +
      '<button class="btn sm" onclick="AIUI.clearHistory()">清空档案</button></div>' +
      '</div>';
  }

  function promptTabHTML() {
    var c = cfg();
    var key = UI_STATE.promptMode;
    var ov = c.promptOverrides || {};
    var isSystem = key === 'system';
    var def = isSystem ? global.AIPROMPT.SYSTEM : (global.AIPROMPT.TASKS[key.replace('task_', '')] || '');
    var val = ov[key] || '';
    var body = val || def;
    return '<div class="ai-set">' +
      '<div class="ai-tabs">' + PROMPT_TABS.map(function (t) {
        return '<button class="btn sm' + (UI_STATE.promptMode === t[0] ? ' primary' : '') +
          '" onclick="AIUI.setPromptMode(\'' + t[0] + '\')">' + t[1] + '</button>';
      }).join('') + '</div>' +
      '<div class="ai-loss">提示词决定 AI 的判断标准。改坏了可以点「恢复默认」。' +
      '当前编辑：<b>' + (PROMPT_TABS.filter(function (t) { return t[0] === key; })[0] || ['', key])[1] + '</b>' +
      (val ? '（已覆写）' : '（默认）') + '</div>' +
      '<textarea rows="18" style="font-family:ui-monospace,Consolas,monospace;font-size:11.5px" ' +
      'onchange="AIUI.setPrompt(\'' + key + '\',this.value)">' + esc(body) + '</textarea>' +
      '<div class="ai-row">' +
      '<button class="btn sm" onclick="AIUI.setPrompt(\'' + key + '\',\'\')">恢复默认</button>' +
      '<button class="btn sm" onclick="AIUI.preview()">预览完整请求</button>' +
      '<span class="ai-tiny">系统提示词约 ' + global.AICTX.estimateTokens(global.AIPROMPT.system()) + ' token</span>' +
      '</div></div>';
  }

  function statusTabHTML() {
    var c = cfg();
    var st = global.AI.STAT;
    var last = st.last || null;
    var hist = global.AI.history() || [];
    var mask = c.apiKey ? (c.apiKey.slice(0, 4) + '****' + c.apiKey.slice(-4)) : '（未填）';
    var lastHtml = '';
    if (last) {
      lastHtml = '<div class="ai-kv">' +
        '<div>时间：' + esc(last.at || '') + '　模式：<code>' + esc(last.mode || '') + '</code></div>' +
        '<div>状态：' + esc(last.status || '') + '　耗时：<b>' + (last.ms || 0) + 'ms</b>' +
        '　尝试次数：' + (last.attempts || 1) + '</div>' +
        '<div>token：输入 ' + (last.usage && last.usage.input || 0) + ' / 输出 ' + (last.usage && last.usage.output || 0) + '</div>' +
        '<div>端点：<code>' + esc(last.endpoint || '') + '</code></div>' +
        (last.error ? '<div style="color:var(--bad)">错误：' + esc(last.error) + '</div>' : '') +
        '</div>';
    } else lastHtml = '<div class="muted">还没有发出过请求。</div>';

    return '<div class="ai-set">' +
      '<div class="ai-kv">' +
      '<div>协议：<code>' + esc(c.provider) + '</code>　模型：<code>' + esc(c.model) + '</code></div>' +
      '<div>Key：<code>' + esc(mask) + '</code>　累计请求：<b>' + (st.count || 0) + '</b> 次</div>' +
      '<div>累计 token：输入 ' + (st.tokensIn || 0) + ' / 输出 ' + (st.tokensOut || 0) + '</div>' +
      '</div><hr>' +
      ledgerStatusHTML() +
      '<div class="sechead" style="margin-top:16px">最近一次请求</div>' + lastHtml +
      '<div class="sechead" style="margin-top:16px">裁决档案（最近 ' + Math.min(10, hist.length) + ' 条）</div>' +
      (hist.length
        ? hist.slice(-10).reverse().map(function (h) {
            return '<div class="item" style="cursor:default"><div class="nm">' +
              (h.ok ? '✓ ' : '✕ ') + esc(h.headline || '') + '</div>' +
              '<div class="meta">' + esc(h.at) + ' · ' + esc(h.mode) + ' · ' +
              (h.source === 'offline' ? '本地规则' : 'AI') + '</div>' +
              '<div class="meta" style="margin-top:2px">' + esc(h.input || '') + '</div></div>';
          }).join('')
        : '<div class="muted">还没有档案。</div>') +
      '<div class="ai-row"><button class="btn sm" onclick="AIUI.clearHistory()">清空档案</button>' +
      '<button class="btn sm" onclick="AIUI.resetAll()">恢复全部默认设置</button></div>' +
      '</div>';
  }

  function ledgerStatusHTML() {
    var s = briefState();
    if (!s) return '';
    var st = global.AILEDGER.stats();
    return '<div class="sechead" style="margin-top:8px">叙事账本</div>' +
      '<div class="ai-kv">' +
      '<div>玩家可见层：行动 <b>' + st.actions + '</b> · 外部事件 <b>' + st.external + '</b> · ' +
      '承诺 <b>' + st.commitments + '</b> · 人物 <b>' + st.actors + '</b> · 风险 <b>' + st.risks + '</b></div>' +
      '<div>内部档案：事实 <b>' + st.facts + '</b> · 因果链 <b>' + st.chains + '</b> · ' +
      '议程 <b>' + st.agendas + '</b> · 定时后果 <b>' + st.ticking + '</b></div>' +
      '<div>距上次整理 <b>' + st.sinceMaintain + '</b> 次　·　更新于 ' + esc(st.updated || '—') + '</div>' +
      '</div>' +
      '<div class="ai-row" style="margin-top:6px">' +
      '<button class="btn sm" onclick="AIUI.openBrief()">查看态势简报</button>' +
      '<button class="btn sm" onclick="AIHOOKS.maintain(true)">立即整理</button>' +
      '</div>' +
      '<div class="ai-tiny" style="margin-top:4px">内部档案只喂给模型，不在任何界面上显示。</div>';
  }

  function settingsHTML() {
    var body = UI_STATE.tab === 'prompt' ? promptTabHTML()
      : (UI_STATE.tab === 'play' ? playTabHTML()
      : (UI_STATE.tab === 'status' ? statusTabHTML() : apiTabHTML()));
    return '<div class="modal ai-modal"><div class="box" style="max-width:860px;position:relative;max-height:88vh;overflow:auto">' +
      '<button class="btn sm" style="position:absolute;top:12px;right:12px;z-index:5" onclick="AIUI.close()">✕</button>' +
      '<div class="kicker">AI ENGINE · 总统模拟器 AI 版</div>' +
      '<h2 style="padding-right:60px">AI 设置</h2>' +
      '<div class="ai-tabs">' + tabBtn('api', '接口') + tabBtn('prompt', '提示词') +
      tabBtn('play', '玩法') + tabBtn('status', '状态') + '</div>' +
      body +
      '<div class="ai-row" style="margin-top:18px;justify-content:flex-end">' +
      '<button class="btn" onclick="AIUI.close()">关闭</button>' +
      '<button class="btn gold" onclick="AIUI.close()">保存并返回</button></div>' +
      '<div class="ai-tiny" style="margin-top:10px">所有设置即时生效并保存在本机浏览器里。' +
      'API Key 只用于你自己的浏览器直接调用接口，不会经过本游戏作者的任何服务器。</div>' +
      '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 七、裁决档案 / 请求预览
   * ------------------------------------------------------------------ */
  function historyHTML() {
    var hist = (global.AI.history() || []).slice().reverse();
    return '<div class="modal ai-modal"><div class="box" style="max-width:820px;position:relative;max-height:86vh;overflow:auto">' +
      '<button class="btn sm" style="position:absolute;top:12px;right:12px" onclick="AIUI.close()">✕</button>' +
      '<div class="kicker">ADJUDICATION LOG</div><h2>裁决档案</h2>' +
      '<div class="ai-tiny" style="margin-bottom:10px">记录每一次自由行动的输入、AI 给出的标题与实际结算的数值，方便回看「AI 判得对不对」。</div>' +
      (hist.length ? hist.map(function (h) {
        var chips = (h.chips || []).map(function (c) {
          return '<span class="ai-chip ' + (c.pos ? 'pos' : 'neg') + '">' + esc(c.label) + ' ' +
            (c.v > 0 ? '+' : '') + c.v + (c.unit || '') + '</span>';
        }).join('');
        return '<div class="item" style="cursor:default;border-left:3px solid ' +
          (h.ok ? 'var(--ok)' : 'var(--bad)') + ';margin-bottom:8px">' +
          '<div class="nm">' + (h.ok ? '' : '✕ ') + esc(h.headline || '') +
          '<span class="ai-src">' + esc(h.at) + ' · ' + esc(h.mode) + ' · ' +
          (h.source === 'offline' ? '本地规则' : 'AI') + '</span></div>' +
          '<div class="meta" style="margin-top:3px">输入：' + esc(h.input || '') + '</div>' +
          (chips ? '<div class="ai-chips">' + chips + '</div>' : '') +
          ((h.notes && h.notes.length) ? '<div class="ai-note">' + esc(h.notes.join('；')) + '</div>' : '') +
          '</div>';
      }).join('') : '<div class="muted">还没有记录。先在战情室里下一条命令。</div>') +
      '<div class="ai-row" style="justify-content:flex-end"><button class="btn" onclick="AIUI.close()">关闭</button></div>' +
      '</div></div>';
  }

  function previewHTML() {
    var p = UI_STATE.preview;
    if (!p) return '';
    return '<div class="modal ai-modal"><div class="box" style="max-width:900px;position:relative;max-height:88vh;overflow:auto">' +
      '<button class="btn sm" style="position:absolute;top:12px;right:12px" onclick="UI.modal=null;render()">✕</button>' +
      '<div class="kicker">PROMPT PREVIEW</div><h2>这一次 AI 会看到什么</h2>' +
      '<div class="ai-tiny" style="margin-bottom:8px">估算：系统 ' + p.sysTok + ' token + 用户 ' + p.userTok +
      ' token ≈ ' + (p.sysTok + p.userTok) + ' token（不含输出）</div>' +
      '<div class="sechead">SYSTEM</div><div class="ai-pre">' + esc(p.system) + '</div>' +
      '<div class="sechead" style="margin-top:10px">USER</div><div class="ai-pre">' + esc(p.user) + '</div>' +
      '<div class="ai-row" style="justify-content:flex-end"><button class="btn" onclick="UI.modal=null;render()">关闭</button></div>' +
      '</div></div>';
  }

  /* 供 modalHTML 调用 */
  function modalFor(type) {
    if (type === 'aiset') return settingsHTML();
    if (type === 'aihist') return historyHTML();
    if (type === 'aipreview') return previewHTML();
    if (type === 'aicampaign') return campaignModalHTML();
    if (type === 'aibrief') return briefModalHTML();
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 八、交互动作
   * ------------------------------------------------------------------ */
  function setDraft(kind, val) {
    UI_STATE.draft[kind] = String(val == null ? '' : val);
  }
  function setTab(t) {
    UI_STATE.tab = t;
    if (typeof render === 'function') render();
  }
  function setPromptMode(k) {
    UI_STATE.promptMode = k;
    if (typeof render === 'function') render();
  }
  function setPrompt(key, val) {
    var ov = {};
    var cur = cfg().promptOverrides || {};
    for (var k in cur) ov[k] = cur[k];
    if (String(val || '').trim()) ov[key] = String(val);
    else delete ov[key];
    global.AI.set({ promptOverrides: ov });
    if (typeof render === 'function') render();
  }
  function setCfg(patch) {
    global.AI.set(patch);
    if (typeof render === 'function') render();
  }
  function usePreset(id) {
    global.AI.usePreset(id);
    UI_STATE.test = null;
    UI_STATE.modelsErr = '';
    if (typeof render === 'function') render();
    /* 换服务商后顺手拉一次模型列表（有 Key 才拉） */
    if (cfg().apiKey && !cachedModels()) fetchModels(false);
  }
  /* 一键切到本地代理：浏览器直连被 CORS 挡下时的标准出路 */
  function useProxy() {
    var port = 8787;
    var patch = { provider: 'openai', baseUrl: 'http://127.0.0.1:' + port + '/v1' };
    if (!cfg().model) patch.model = 'deepseek-chat';
    global.AI.set(patch);
    UI_STATE.test = null;
    UI_STATE.modelsErr = '';
    UI_STATE.modelsTried = false;
    toast('已切到本地代理：先运行 node ai/proxy.js，上游地址与 key 写在 ai/proxy.config.json。');
    if (typeof render === 'function') render();
  }
  function open() {
    UI_STATE.tab = 'api';
    UI.modal = { type: 'aiset' };
    if (typeof render === 'function') render();
    /* 第一次打开设置、且还没缓存模型列表时，自动拉一次 */
    if (cfg().apiKey && !cachedModels() && !UI_STATE.modelsTried) fetchModels(false);
  }
  function close() {
    UI.modal = null;
    UI_STATE.test = null;
    if (typeof render === 'function') render();
  }
  function openHistory() {
    UI.modal = { type: 'aihist' };
    if (typeof render === 'function') render();
  }
  function clearHistory() {
    global.AI.clearHistory();
    try { if (G()) G().aiLog = []; } catch (e) {}
    if (typeof showToast === 'function') showToast('裁决档案已清空。');
    if (typeof render === 'function') render();
  }
  function resetAll() {
    global.AI.reset();
    UI_STATE.test = null;
    if (typeof showToast === 'function') showToast('AI 设置已恢复默认。');
    if (typeof render === 'function') render();
  }

  function preview() {
    var p = global.AIPROMPT.build('national', global.AICTX.text('national'),
      UI_STATE.draft.national || '（这里会显示你输入的行动）', {});
    UI_STATE.preview = {
      system: p.system, user: p.user,
      sysTok: global.AICTX.estimateTokens(p.system),
      userTok: global.AICTX.estimateTokens(p.user)
    };
    UI.modal = { type: 'aipreview' };
    if (typeof render === 'function') render();
  }

  function test() {
    if (busy()) return;
    UI_STATE.test = null;
    global.AI.STAT.busy = true;
    global.AI.STAT.busyLabel = '测试连接';
    global.AI.STAT.startedAt = Date.now();
    UI_STATE.error = null;
    if (typeof render === 'function') render();
    global.AICLIENT.test().then(function (res) {
      UI_STATE.test = res;
    }).catch(function (e) {
      UI_STATE.test = { ok: false, ms: 0, model: cfg().model, endpoint: '',
        text: e && e.message ? e.message : String(e), parseError: '' };
      UI_STATE.error = null;
    }).then(function () {
      global.AI.STAT.busy = false;
      global.AI.STAT.busyLabel = '';
      if (typeof render === 'function') render();
      /* 连接正常就顺手把模型列表拉下来 */
      if (UI_STATE.test && UI_STATE.test.ok && !cachedModels()) fetchModels(false);
    });
  }

  /* ------------------------------------------------------------------ *
   * 九、提交与结算（由 ai-hooks.js 的 submit 调用）
   * ------------------------------------------------------------------ */
  function startBusy(label) {
    AI.STAT.busy = true;
    AI.STAT.busyLabel = label || '裁决中';
    AI.STAT.startedAt = Date.now();
    UI_STATE.error = null;
    UI_STATE.result = null;
    if (typeof render === 'function') render();
    stopTick();
    UI_STATE.tick = setInterval(function () {
      var el = document.getElementById('aibusy-t');
      if (!el) return;
      el.textContent = Math.max(0, Math.round((Date.now() - AI.STAT.startedAt) / 1000));
    }, 500);
  }

  function stopTick() {
    if (UI_STATE.tick) { clearInterval(UI_STATE.tick); UI_STATE.tick = null; }
  }

  function endBusy() {
    AI.STAT.busy = false;
    AI.STAT.busyLabel = '';
    stopTick();
  }

  function fail(msg, ctx) {
    endBusy();
    UI_STATE.error = msg;
    AI.STAT.error = msg;
    if (typeof render === 'function') render();
  }

  function cancel() {
    if (!busy()) return;
    global.AICLIENT.abort();
    endBusy();
    UI_STATE.error = '已取消这次请求。';
    if (typeof render === 'function') render();
  }

  global.AIUI = {
    state: UI_STATE,
    css: injectCSS,
    nationalConsoleHTML: nationalConsoleHTML,
    campaignConsoleHTML: campaignConsoleHTML,
    campaignModalHTML: campaignModalHTML,
    openCampaign: openCampaign,
    closeModal: closeModal,
    briefSummaryHTML: briefSummaryHTML,
    briefModalHTML: briefModalHTML,
    openBrief: openBrief,
    clearBrief: clearBrief,
    eventCardHTML: eventCardHTML,
    eventModalHTML: eventModalHTML,
    shockModalHTML: shockModalHTML,
    crisisPaneHTML: crisisPaneHTML,
    settingsHTML: settingsHTML,
    historyHTML: historyHTML,
    modalFor: modalFor,
    setDraft: setDraft, setTab: setTab, setPromptMode: setPromptMode,
    setPrompt: setPrompt, setCfg: setCfg, usePreset: usePreset, useProxy: useProxy,
    open: open, close: close, openHistory: openHistory,
    clearHistory: clearHistory, resetAll: resetAll, preview: preview, test: test,
    fetchModels: fetchModels, setModelByIdx: setModelByIdx,
    startBusy: startBusy, endBusy: endBusy, fail: fail, cancel: cancel,
    dismissShock: dismissShock, deferCrisis: deferCrisis,
    busyHTML: busyHTML, resultHTML: resultHTML, errorHTML: errorHTML,
    keyMissing: keyMissing, keyWarnHTML: keyWarnHTML, fileWarnHTML: fileWarnHTML
  };
})(window);
