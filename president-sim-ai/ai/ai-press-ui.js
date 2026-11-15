/* ============================================================================
   ai-press-ui.js — 舆论场面板（媒体版面 + 民间信息流）
   《总统模拟器 · AI 版》扩展层
   ----------------------------------------------------------------------------
   新标签「舆论」：
     · 媒体：一次只显示一家，用下拉栏切换；每家一整版，分六个板块
       （头条 / 国内 / 经济 / 国际 / 总统政策观察 / 社论）。
     · 民间：普通美国人的发言，平台皮肤随年代切换：
       论坛（2000-2004）→ Facebook（2005-2009）→ Twitter（2010-2022）→ X（2023+）
   ========================================================================== */
(function (global) {
  'use strict';

  var SLANT_CN = {
    liberal: '自由派', conservative: '保守派', centrist: '中间',
    wire: '通讯社', populist: '民粹右翼'
  };
  var TONE_CN = { support: '肯定', criticize: '批评', mixed: '两极', neutral: '中性' };
  var TONE_COL = {
    support: '#3fa66a', criticize: '#c0393b', mixed: '#d99b2b', neutral: '#8b96a5'
  };

  function G() { return global.AIG.g(); }
  function esc(s) { return global.AI.esc(s); }
  function cfg() { return global.AICFG || {}; }
  function state() { return global.AIUI.state; }
  function busy() { return !!(global.AI.STAT && global.AI.STAT.busy); }

  function fmt(n) {
    n = Number(n) || 0;
    if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿';
    if (n >= 10000) return (n / 10000).toFixed(1) + '万';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function initial(name) {
    var s = String(name || '?').replace(/[·.\s]/g, '');
    return s.charAt(0) || '?';
  }

  /* ------------------------------------------------------------------ *
   * 样式（每个平台自带配色，不跟随游戏的年代皮肤）
   * ------------------------------------------------------------------ */
  var CSS = [
    '.aip-wrap{display:flex;flex-direction:column;gap:12px}',
    '.aip-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.aip-head h3{margin:0;font-size:17px}',
    '.aip-plat{font-size:11.5px;padding:2px 8px;border-radius:20px;border:1px solid var(--line2);color:var(--dim)}',
    '.aip-mood{font-size:11.5px;color:var(--dim);margin-left:auto}',
    '.aip-moodbar{display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:8px}',
    '.aip-moodbar i{display:block;height:100%}',

    /* ---- 媒体：工具条 + 单家版面 ---- */
    '.aip-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.aip-bar h3{margin:0;font-size:16px}',
    '.aip-bar select{min-width:170px;padding:4px 8px;border-radius:6px;border:1px solid var(--line2);',
    '  background:var(--panel3);color:var(--text);font-family:var(--font);font-size:12.5px}',
    '.aip-bar .aip-tiny{margin-left:auto}',
    '.aip-paper{background:var(--panel2);border:1px solid var(--line);border-radius:8px;',
    '  padding:16px 18px 18px;font-family:Georgia,"Songti SC","SimSun",serif}',
    '.aip-paper-hd{text-align:center;border-bottom:3px double var(--line2);padding-bottom:10px;margin-bottom:14px}',
    '.aip-mast-xl{font-size:30px;font-weight:700;letter-spacing:3px;line-height:1.2}',
    '.aip-mast-en{font-size:10.5px;color:var(--dim2);letter-spacing:2.5px;text-transform:uppercase;margin-top:3px}',
    '.aip-slogan{font-size:11.5px;color:var(--dim);font-style:italic;margin-top:5px}',
    '.aip-paper-meta{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;',
    '  font-size:10.5px;color:var(--dim2);margin-top:9px}',
    '.aip-paper-meta span{border-left:1px solid var(--line2);padding-left:8px}',
    '.aip-paper-meta span:first-child{border-left:none;padding-left:0}',
    '.aip-sec{margin-top:16px}',
    '.aip-sec-label{font-size:10.5px;letter-spacing:2.5px;color:var(--dim2);border-bottom:1px solid var(--line);',
    '  padding-bottom:4px;margin-bottom:8px}',
    '.aip-story+.aip-story{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line)}',
    '.aip-story h4{margin:0 0 5px;font-size:14.5px;line-height:1.4;font-weight:700}',
    '.aip-story p{margin:0;font-size:12.5px;line-height:1.8;color:var(--dim)}',
    '.aip-sec.lead .aip-story h4{font-size:21px;line-height:1.32;letter-spacing:.3px}',
    '.aip-sec.lead .aip-story p{font-size:13.5px;color:var(--text)}',
    '.aip-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
    '@media(max-width:720px){.aip-grid{grid-template-columns:1fr}}',
    '.aip-empty{padding:26px 4px;text-align:center}',
    '.aip-empty .t{font-size:13px;color:var(--dim);margin-bottom:10px}',

    /* ---- 论坛 ---- */
    '.aip-feed{border-radius:8px;overflow:hidden;border:1px solid #999}',
    '.aip-feed.forum{background:#e6e6e6;color:#111;font-family:Tahoma,Verdana,sans-serif}',
    '.aip-feed.forum .fbar{background:linear-gradient(#5b7cab,#39557b);color:#fff;padding:7px 12px;',
    '  font-size:12.5px;font-weight:700;letter-spacing:1px;display:flex;gap:10px;align-items:center}',
    '.aip-feed.forum .fbar small{font-weight:400;opacity:.85;letter-spacing:0}',
    '.aip-feed.forum .post{background:#fff;border:1px solid #a7a7a7;margin:8px;padding:0}',
    '.aip-feed.forum .pmeta{background:#dcdcdc;border-bottom:1px solid #a7a7a7;padding:3px 8px;',
    '  font-size:11px;color:#333;display:flex;gap:10px;align-items:center}',
    '.aip-feed.forum .pbody{padding:8px 10px;font-size:12.5px;line-height:1.7}',
    '.aip-feed.forum .pfoot{padding:3px 8px 6px;font-size:10.5px;color:#555}',
    '.aip-feed.forum .av{display:none}',

    /* ---- Facebook ---- */
    '.aip-feed.facebook{background:#f0f2f5;color:#1c1e21}',
    '.aip-feed.facebook .fbar{background:#1877f2;color:#fff;padding:8px 12px;font-size:19px;font-weight:800;',
    '  letter-spacing:-.5px;display:flex;gap:10px;align-items:center}',
    '.aip-feed.facebook .fbar small{font-size:11px;font-weight:400;opacity:.9;letter-spacing:0}',
    '.aip-feed.facebook .post{background:#fff;margin:8px;border-radius:8px;padding:11px 12px;',
    '  box-shadow:0 1px 2px rgba(0,0,0,.16)}',
    '.aip-feed.facebook .prow{display:flex;gap:9px;align-items:flex-start}',
    '.aip-feed.facebook .av{width:34px;height:34px;border-radius:50%;background:#1877f2;color:#fff;',
    '  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex:none}',
    '.aip-feed.facebook .nm{font-size:13px;font-weight:600;color:#050505}',
    '.aip-feed.facebook .h{font-size:11px;color:#65676b}',
    '.aip-feed.facebook .pbody{font-size:13.5px;line-height:1.66;margin:6px 0 8px;padding-left:43px}',
    '.aip-feed.facebook .act{display:flex;gap:20px;border-top:1px solid #e4e6eb;padding-top:7px;',
    '  margin-left:43px;color:#65676b;font-size:12px}',

    /* ---- Twitter ---- */
    '.aip-feed.twitter{background:#fff;color:#14171a}',
    '.aip-feed.twitter .fbar{background:#fff;border-bottom:1px solid #e1e8ed;color:#1da1f2;',
    '  padding:8px 12px;font-size:19px;font-weight:800;letter-spacing:-.5px;display:flex;gap:10px;align-items:center}',
    '.aip-feed.twitter .fbar small{font-size:11px;font-weight:400;color:#657786;letter-spacing:0}',
    '.aip-feed.twitter .post{border-bottom:1px solid #e1e8ed;padding:11px 12px}',
    '.aip-feed.twitter .prow{display:flex;gap:9px}',
    '.aip-feed.twitter .av{width:36px;height:36px;border-radius:50%;background:#1da1f2;color:#fff;',
    '  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex:none}',
    '.aip-feed.twitter .nm{font-size:13.5px;font-weight:700;color:#14171a}',
    '.aip-feed.twitter .h{font-size:12px;color:#657786;font-weight:400}',
    '.aip-feed.twitter .pbody{font-size:13.5px;line-height:1.6;margin:4px 0 6px;padding-left:45px}',
    '.aip-feed.twitter .act{display:flex;gap:34px;color:#657786;font-size:12px;padding-left:45px}',
    '.aip-feed.twitter .act .rt{color:#17bf63}.aip-feed.twitter .act .lk{color:#e0245e}',

    /* ---- X ---- */
    '.aip-feed.x{background:#000;color:#e7e9ea}',
    '.aip-feed.x .fbar{background:#000;border-bottom:1px solid #2f3336;color:#e7e9ea;',
    '  padding:8px 12px;font-size:19px;font-weight:800;letter-spacing:-.5px;display:flex;gap:10px;align-items:center}',
    '.aip-feed.x .fbar small{font-size:11px;font-weight:400;color:#71767b;letter-spacing:0}',
    '.aip-feed.x .post{border-bottom:1px solid #2f3336;padding:11px 12px}',
    '.aip-feed.x .prow{display:flex;gap:9px}',
    '.aip-feed.x .av{width:36px;height:36px;border-radius:50%;background:#333;color:#e7e9ea;',
    '  border:1px solid #2f3336;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex:none}',
    '.aip-feed.x .nm{font-size:13.5px;font-weight:700;color:#e7e9ea}',
    '.aip-feed.x .h{font-size:12px;color:#71767b;font-weight:400}',
    '.aip-feed.x .vf{color:#1d9bf0;font-size:11px;margin-left:3px}',
    '.aip-feed.x .pbody{font-size:13.5px;line-height:1.6;margin:4px 0 6px;padding-left:45px}',
    '.aip-feed.x .act{display:flex;gap:32px;color:#71767b;font-size:12px;padding-left:45px}'
  ].join('\n');

  function injectCSS() {
    try {
      if (document.getElementById('ai-press-style')) return;
      var st = document.createElement('style');
      st.id = 'ai-press-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 头部与空态
   * ------------------------------------------------------------------ */
  function headHTML(p, plat) {
    var g = G();
    var dateCN = '';
    try { dateCN = global.dateLabel(g.y, g.w); } catch (e) { dateCN = g.y + '年'; }
    var src = p ? (p.source === 'offline' ? '本地规则生成' : 'AI 生成') : '';
    var mood = p ? p.mood : null;
    var moodTxt = '';
    if (mood) {
      var tot = (mood.support + mood.oppose + mood.neutral) || 1;
      moodTxt = '样本倾向：支持 ' + Math.round(mood.support / tot * 100) + '% · 反对 ' +
        Math.round(mood.oppose / tot * 100) + '% · 中立 ' + Math.round(mood.neutral / tot * 100) + '%';
    }
    return '<div class="card"><div class="aip-head">' +
      '<h3>舆论场</h3>' +
      '<span class="aip-plat">' + esc(plat.cn) + '</span>' +
      '<span class="aip-plat">' + esc(dateCN) + (p ? ' · 更新于 ' + esc(p.week) : ' · 尚无快照') + '</span>' +
      (src ? '<span class="aip-plat">' + esc(src) + '</span>' : '') +
      '<span class="aip-mood">' + esc(moodTxt) + '</span>' +
      '</div>' +
      (mood ? '<div class="aip-moodbar">' +
        '<i style="width:' + (mood.support / ((mood.support + mood.oppose + mood.neutral) || 1) * 100) + '%;background:#3fa66a"></i>' +
        '<i style="width:' + (mood.oppose / ((mood.support + mood.oppose + mood.neutral) || 1) * 100) + '%;background:#c0393b"></i>' +
        '<i style="flex:1;background:#8b96a5"></i>' +
        '</div>' : '') +
      '<div class="ai-row" style="margin-top:10px">' +
      '<button class="btn primary sm" onclick="AIPRESS.refreshFeed(true)"' + (busy() ? ' disabled' : '') + '>刷新信息流</button>' +
      '<button class="btn sm" onclick="AIPRESS_UI.offlineGen()"' + (busy() ? ' disabled' : '') + '>本地生成（不联网）</button>' +
      (p ? '<button class="btn sm" onclick="AIPRESS_UI.clear()">清空</button>' : '') +
      '<span class="ai-tiny">' + (cfg().pressAuto === false ? '自动更新已关闭' :
        ('每 ' + (cfg().pressEvery || 2) + ' 周自动更新一次')) + '</span>' +
      '</div>' +
      (state().error ? '<div class="ai-err">⚠ ' + esc(state().error) + '</div>' : '') +
      '</div>';
  }

  function emptyHTML(plat) {
    return '<div class="card"><div class="aip-empty">' +
      '<div class="t">这一周还没有舆论快照。<br>点上面「刷新信息流」，或先用「本地生成」看看样子。</div>' +
      '<div class="ai-tiny">' + esc(plat.cn) + '</div>' +
      '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 媒体：下拉切换 + 单家整版
   * ------------------------------------------------------------------ */
  function namesOf(p) {
    try { return global.AIPRESS.outletNames(p) || []; } catch (e) { return []; }
  }

  function barHTML(p) {
    var names = namesOf(p);
    if (!names.length) return '';
    var sel = p.selected || names[0];
    var opts = names.map(function (n, i) {
      var done = p.outlets && p.outlets[n];
      return '<option value="' + i + '"' + (n === sel ? ' selected' : '') + '>' +
        esc(n) + (done ? '' : '（待生成）') + '</option>';
    }).join('');
    var doneN = 0;
    names.forEach(function (n) { if (p.outlets && p.outlets[n]) doneN++; });
    return '<div class="aip-bar">' +
      '<h3>媒体</h3>' +
      '<select onchange="AIPRESS_UI.selectOutlet(this.value)"' + (busy() ? ' disabled' : '') + '>' + opts + '</select>' +
      '<button class="btn sm" onclick="AIPRESS.refreshOutlet(AIPRESS.ensure().selected,true)"' +
      (busy() ? ' disabled' : '') + '>刷新本家</button>' +
      '<button class="btn sm" onclick="AIPRESS.refreshAllOutlets(true)"' +
      (busy() ? ' disabled' : '') + '>生成全部</button>' +
      '<span class="aip-tiny">已生成 ' + doneN + ' / ' + names.length + ' 家</span>' +
      '</div>';
  }

  function paperHTML(o) {
    var def = null;
    try { def = global.AIPRESS.outletDef(o.name); } catch (e) {}
    var meta = [];
    meta.push('<span>' + esc(SLANT_CN[o.slant] || o.slant || '') + '</span>');
    meta.push('<span style="color:' + (TONE_COL[o.tone] || '#8b96a5') + '">本期基调：' +
      esc(TONE_CN[o.tone] || o.tone || '') + '</span>');
    if (o.focus) meta.push('<span>聚焦：' + esc(o.focus) + '</span>');
    meta.push('<span>' + esc(o.week || '') + ' 更新</span>');
    if (o.source === 'offline') meta.push('<span>本地规则生成</span>');

    var secs = o.sections || [];
    var lead = null, rest = [];
    secs.forEach(function (s) { if (s.k === 'lead') lead = s; else rest.push(s); });

    function stories(sec) {
      return (sec.items || []).map(function (it) {
        return '<div class="aip-story"><h4>' + esc(it.h || '') + '</h4>' +
          (it.p ? '<p>' + esc(it.p) + '</p>' : '') + '</div>';
      }).join('');
    }
    function sectionHTML(sec, cls) {
      return '<div class="aip-sec ' + (cls || '') + '">' +
        '<div class="aip-sec-label">' + esc(sec.cn || '') + '</div>' + stories(sec) + '</div>';
    }

    var body = '';
    if (lead) body += sectionHTML(lead, 'lead');
    if (rest.length) {
      body += '<div class="aip-grid">' + rest.map(function (s) { return sectionHTML(s); }).join('') + '</div>';
    }

    return '<div class="aip-paper">' +
      '<div class="aip-paper-hd">' +
      '<div class="aip-mast-xl">' + esc(o.name) + '</div>' +
      (o.en ? '<div class="aip-mast-en">' + esc(o.en) + '</div>' : '') +
      (o.slogan ? '<div class="aip-slogan">“' + esc(o.slogan) + '”</div>' : '') +
      '<div class="aip-paper-meta">' + meta.join('') + '</div>' +
      '</div>' + body + '</div>';
  }

  function missingHTML(name) {
    return '<div class="aip-empty">' +
      '<div class="t">《' + esc(name) + '》这一期还没有版面。</div>' +
      '<button class="btn sm" onclick="AIPRESS.refreshOutlet(AIPRESS.ensure().selected,true)"' +
      (busy() ? ' disabled' : '') + '>生成这一家</button>' +
      '</div>';
  }

  function mediaHTML(p) {
    var names = namesOf(p);
    if (!names.length) return '';
    var sel = p.selected || names[0];
    var o = p.outlets && p.outlets[sel];
    return '<div class="card" style="padding:14px 16px">' +
      barHTML(p) +
      '<div style="margin-top:12px">' + (o ? paperHTML(o) : missingHTML(sel)) + '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 民间信息流
   * ------------------------------------------------------------------ */
  function postHTML(p, plat, i) {
    var id = plat.id;
    var av = '<div class="av">' + esc(initial(p.name)) + '</div>';

    if (id === 'forum') {
      return '<div class="post">' +
        '<div class="pmeta"><b>' + esc(p.name) + '</b>' +
        '<span>发表于 ' + esc(p.time) + '</span>' +
        '<span>#' + (i + 1) + '</span>' +
        '<span style="margin-left:auto">' + esc(p.loc || '') + '</span></div>' +
        '<div class="pbody">' + esc(p.text) + '</div>' +
        '<div class="pfoot">回复 (' + fmt(p.replies) + ') · 查看 ' + fmt(p.views || 0) + '</div>' +
        '</div>';
    }
    if (id === 'facebook') {
      return '<div class="post"><div class="prow">' + av +
        '<div><div class="nm">' + esc(p.name) + ' <span class="h">· ' + esc(p.time) + ' · ' +
        esc(p.loc || '') + '</span></div>' +
        '<div class="h">' + esc(p.handle) + '</div></div></div>' +
        '<div class="pbody">' + esc(p.text) + '</div>' +
        '<div class="act"><span>👍 赞 ' + fmt(p.likes) + '</span>' +
        '<span>💬 评论 ' + fmt(p.replies) + '</span>' +
        '<span>↗ 分享 ' + fmt(p.reposts) + '</span></div></div>';
    }
    if (id === 'twitter') {
      return '<div class="post"><div class="prow">' + av +
        '<div style="flex:1"><div class="nm">' + esc(p.name) +
        (p.verified ? ' <span style="color:#1da1f2">✔</span>' : '') +
        ' <span class="h">' + esc(p.handle) + ' · ' + esc(p.time) + '</span></div>' +
        '<div class="pbody" style="padding-left:0">' + esc(p.text) + '</div>' +
        '<div class="act" style="padding-left:0"><span>💬 ' + fmt(p.replies) + '</span>' +
        '<span class="rt">🔁 ' + fmt(p.reposts) + '</span>' +
        '<span class="lk">♥ ' + fmt(p.likes) + '</span></div></div></div></div>';
    }
    /* X */
    return '<div class="post"><div class="prow">' + av +
      '<div style="flex:1"><div class="nm">' + esc(p.name) +
      (p.verified ? '<span class="vf">✔</span>' : '') +
      ' <span class="h">' + esc(p.handle) + ' · ' + esc(p.time) + '</span></div>' +
      '<div class="pbody" style="padding-left:0">' + esc(p.text) + '</div>' +
      '<div class="act" style="padding-left:0"><span>💬 ' + fmt(p.replies) + '</span>' +
      '<span>🔁 ' + fmt(p.reposts) + '</span>' +
      '<span>♥ ' + fmt(p.likes) + '</span>' +
      '<span>📊 ' + fmt(p.views) + ' 查看</span></div></div></div></div>';
  }

  function feedHTML(p, plat) {
    var posts = p.posts || [];
    var title = plat.id === 'forum' ? '网络论坛 · 政治版' :
                plat.id === 'facebook' ? 'facebook' :
                plat.id === 'twitter' ? 'twitter' :
                '𝕏';
    var sub = plat.id === 'forum' ? 'AMERICA ONLINE' :
              plat.id === 'facebook' ? '动态消息' :
              plat.id === 'twitter' ? '时间线' : '为你推荐';
    return '<div class="card" style="padding:0;overflow:hidden">' +
      '<div class="aip-feed ' + plat.id + '">' +
      '<div class="fbar">' + esc(title) + ' <small>' + esc(sub) + '</small>' +
      '<small style="margin-left:auto">' + esc(p.week || '') + '</small></div>' +
      (posts.length ? posts.map(function (x, i) { return postHTML(x, plat, i); }).join('')
        : '<div class="aip-empty"><div class="t">这一版还没有发言。</div></div>') +
      '</div></div>';
  }

  /* ------------------------------------------------------------------ *
   * 主面板
   * ------------------------------------------------------------------ */
  function paneHTML() {
    injectCSS();
    var g = G();
    if (!g) return '';
    var p = global.AIPRESS.current();
    var plat = p ? (global.AIPRESS.PLATFORMS[p.platform] || global.AIPRESS.platformOf(g.y))
                 : global.AIPRESS.platformOf(g.y);
    var head = headHTML(p, plat);
    if (!p) return '<div class="aip-wrap">' + head + emptyHTML(plat) + '</div>';
    return '<div class="aip-wrap">' + head + mediaHTML(p) + feedHTML(p, plat) + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * 交互
   * ------------------------------------------------------------------ */
  function selectOutlet(v) {
    var p = global.AIPRESS.ensure();
    if (!p) return;
    var names = namesOf(p);
    var idx = Number(v);
    var name = (idx >= 0 && idx < names.length) ? names[idx] : names[0];
    p.selected = name;
    state().error = null;
    if (!p.outlets[name] && !busy() && cfg().enabled) {
      global.AIPRESS.refreshOutlet(name, false);
      return;                                   /* refreshOutlet 会自己重绘 */
    }
    if (typeof render === 'function') render();
  }

  function offlineGen() {
    try {
      global.AIPRESS.offline();
      state().error = null;
      if (typeof showToast === 'function') showToast('已用本地规则生成一版舆论。');
    } catch (e) {
      state().error = '本地生成失败：' + (e && e.message ? e.message : e);
    }
    if (typeof render === 'function') render();
  }

  function clear() {
    try { global.AIPRESS.reset(); } catch (e) {}
    state().error = null;
    if (typeof render === 'function') render();
  }

  /* 切到「舆论」标签之后调用：没有信息流就生成；当前这家没有版面就补一家 */
  function afterOpen() {
    var s = global.AIPRESS.ensure();
    if (!s || !cfg().enabled) return;
    if (global.AI.STAT.busy) return;
    if (!cfg().apiKey && !/127\.0\.0\.1|localhost/.test(String(cfg().baseUrl || ''))) return;
    var emptyFeed = !s.posts.length;
    if (emptyFeed || (cfg().pressAuto && global.AIPRESS.stale())) {
      global.AIPRESS.refreshFeed(false);
      return;
    }
    if (!s.outlets[s.selected]) {
      global.AIPRESS.refreshOutlet(s.selected, false);
    }
  }

  function openTab() {
    var ui = global.AIG.ui();
    if (!ui) return;
    ui.tab = 'opinion';
    if (typeof render === 'function') render();
    afterOpen();
  }

  global.AIPRESS_UI = {
    paneHTML: paneHTML,
    headHTML: headHTML,
    mediaHTML: mediaHTML,
    paperHTML: paperHTML,
    feedHTML: feedHTML,
    injectCSS: injectCSS,
    selectOutlet: selectOutlet,
    offlineGen: offlineGen,
    clear: clear,
    afterOpen: afterOpen,
    openTab: openTab
  };
})(window);
