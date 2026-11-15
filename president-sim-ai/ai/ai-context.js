/* ============================================================================
   ai-context.js — 局势快照
   《总统模拟器 · AI 版》扩展层第 3 块
   ----------------------------------------------------------------------------
   把引擎里的 G（全局状态）压缩成模型能读的一小段 JSON。目标是：
     · 模型知道「现在是哪一年哪一周、谁在台上、民意多少、经济怎样、
       国会谁说了算、世界上谁跟谁过不去、手上有什么在审」
     · 长度可控（lite ≈ 200 字 / standard ≈ 700 字 / deep ≈ 1500 字）
     · 绝不因为某个字段缺失而抛异常 —— 所有取值都走 AI.safe()
   ========================================================================== */
(function (global) {
  'use strict';

  function G() { return global.AIG.g(); }
  function R(v, d) { return global.AI.round(v, d == null ? 1 : d); }
  function N(v, d) { return global.AI.num(v, d || 0); }

  function partyCN(p) { return p === 'D' ? '民主党' : (p === 'R' ? '共和党' : '无党派'); }

  /* 把 {a:1,b:2} 压成 "a:1,b:2" */
  function pairs(obj, keys, d) {
    if (!obj) return '';
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (obj[k] == null) continue;
      out.push(k + ':' + R(obj[k], d == null ? 0 : d));
    }
    return out.join(',');
  }

  function issueVec(iss) {
    var out = [];
    try {
      var list = global.AIG.issues();
      for (var i = 0; i < list.length && i < (iss || []).length; i++) {
        var v = Math.round(N(iss[i], 0));
        if (v !== 0) out.push(list[i].k + ':' + v);
      }
    } catch (e) {}
    return out.join(',');
  }

  function logTail(n) {
    var g = G(); if (!g || !g.log) return [];
    var out = [];
    for (var i = Math.max(0, g.log.length - n); i < g.log.length; i++) {
      var e = g.log[i];
      if (!e || !e.t) continue;
      var t = String(e.t);
      if (t.length > 90) t = t.slice(0, 88) + '…';
      out.push(t);
    }
    return out;
  }

  function congressLine() {
    var g = G(); if (!g) return '';
    var c = g.caucus || { h: {}, s: {} };
    var hD = N(c.h && c.h.D), hR = N(c.h && c.h.R);
    var sD = N(c.s && c.s.D), sR = N(c.s && c.s.R);
    var pres = g.pres && g.pres.party;
    function maj(d, r, p) {
      if (p === 'D') return d > r ? '本党多数' : '反对党多数';
      if (p === 'R') return r > d ? '本党多数' : '反对党多数';
      return d > r ? '民主党多数' : '共和党多数';
    }
    return {
      house: hD + 'D/' + hR + 'R（' + maj(hD, hR, pres) + '，435 席）',
      senate: sD + 'D/' + sR + 'R（' + maj(sD, sR, pres) + '，需 60 票终结辩论）'
    };
  }

  function worldLine(level) {
    var g = G(); if (!g || !g.world) return '';
    var list = [];
    var countries = global.AIG.countries();
    for (var i = 0; i < countries.length; i++) {
      var c = countries[i];
      var v = g.world[c.id];
      if (v == null) continue;
      list.push({ id: c.id, cn: c.cn, v: v, att: c.att });
    }
    list.sort(function (a, b) { return a.v - b.v; });
    var foes = list.slice(0, 4);
    var friends = list.slice(-4).reverse();
    var mid = list.filter(function (x) { return x.v > -20 && x.v < 40; });
    var pick = foes.concat(friends);
    if (level === 'deep') pick = pick.concat(mid.slice(0, 8));
    var seen = {}, out = [];
    for (var j = 0; j < pick.length; j++) {
      var x = pick[j];
      if (seen[x.id]) continue;
      seen[x.id] = 1;
      out.push(x.id + ' ' + x.cn + ':' + Math.round(x.v) + (x.att ? '(' + x.att + ')' : ''));
    }
    return out.join('，');
  }

  function sectorLine() {
    var g = G(); if (!g || !g.corps) return '';
    var keys = ['energy', 'defense', 'finance', 'tech', 'pharma', 'agri', 'auto',
                'media', 'realty', 'laborU', 'guns', 'insur', 'unionT'];
    return pairs(g.corps, keys, 0);
  }

  function factionLine() {
    var g = G(); if (!g || !g.factions) return '';
    var p = (g.pres && g.pres.party) || (g.player && g.player.party) || 'D';
    var f = g.factions[p] || {};
    var defs = global.AIG.factions()[p] || [];
    var out = [];
    for (var i = 0; i < defs.length; i++) {
      var k = defs[i].id;
      if (f[k] == null) continue;
      out.push(defs[i].cn + ':' + Math.round(f[k]));
    }
    return partyCN(p) + ' 内 ' + out.join('，');
  }

  function platformLine() {
    var g = G(); if (!g || !g.platform || !g.platform.published) return '';
    var pf = g.platform.issues || {};
    var list = global.AIG.issues();
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var v = pf[list[i].k];
      if (v == null || !v) continue;
      out.push(list[i].cn + (v < 0 ? '偏自由' : '偏保守') + Math.abs(v));
    }
    return out.join('，');
  }

  /* 大选民调：取最接近的若干摇摆州 */
  function pollLine() {
    var g = G(); if (!g || !g.general) return '';
    var gm = g.general;
    var poll = gm.poll || {};
    var ids = ['PA', 'MI', 'WI', 'GA', 'NC', 'AZ', 'NV', 'NH', 'MN', 'VA', 'FL', 'OH', 'TX'];
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      if (poll[ids[i]] == null) continue;
      out.push(ids[i] + ':' + R(poll[ids[i]], 1));
    }
    return {
      national: R(gm.natMargin, 1),
      mine: gm.myParty === 'D' ? '民主党' : '共和党',
      opp: (gm.opp && gm.opp.name ? gm.opp.name : '?') + '/' + partyCN(gm.oppParty),
      swing: out.join('，') || '（无州级民调）'
    };
  }

  function crisisList(level) {
    var g = G(); if (!g || !g.crises) return [];
    var out = [];
    for (var i = 0; i < g.crises.length && i < (level === 'deep' ? 10 : 5); i++) {
      var c = g.crises[i];
      if (!c) continue;
      var def = null;
      try { def = global.crisisDef ? crisisDef(c.id) : null; } catch (e) {}
      if (c.done) continue;
      var o = { cn: c.cn || (def && def.cn) || c.id };
      if (c.stage) o.stage = c.stage;
      if (c.involvement) o.invol = c.involvement;
      if (c.long) o.long = 1;
      if (def && def.hist) o.背景 = String(cleanHist(def.hist)).slice(0, 60);
      out.push(o);
    }
    return out;
  }

  function shockList() {
    var g = G(); if (!g || !g.shocks) return [];
    var out = [];
    for (var k in g.shocks) {
      var sh = g.shocks[k];
      if (!sh || sh.done) continue;
      var o = { k: k, cn: sh.cn || k };
      o.prog = global.shockScore ? R(global.shockScore(k) * 100, 0) : 0;
      if (sh.acted) o.nodes = sh.acted;
      if (sh.lastTxt) o.最近 = String(sh.lastTxt).slice(0, 60);
      out.push(o);
    }
    return out;
  }

  function billsLine() {
    var g = G(); if (!g) return null;
    var o = {};
    if (g.activeBill) {
      o.active = {
        cn: g.activeBill.cn,
        方向: g.activeBill.i,
        民意: g.activeBill.pop,
        剩余周: g.activeBill.weeksLeft
      };
    }
    if (g.pendingSignature && g.pendingSignature.bill) o.待签署 = g.pendingSignature.bill.cn;
    if (g.lastPassedBill) o.最近通过 = g.lastPassedBill.cn;
    return Object.keys(o).length ? o : null;
  }

  function recentAI() {
    var g = G(); if (!g || !g.aiLog || !g.aiLog.length) return [];
    var out = [];
    for (var i = Math.max(0, g.aiLog.length - 4); i < g.aiLog.length; i++) {
      var e = g.aiLog[i];
      if (e && e.headline) out.push(e.headline);
    }
    return out;
  }

  function snapStates(level) {
    if (level !== 'deep') return undefined;
    var g = G(); if (!g || !g.se) return undefined;
    var out = {};
    var ids = ['PA', 'MI', 'WI', 'GA', 'NC', 'AZ', 'NV', 'OH', 'FL', 'TX', 'NH'];
    for (var i = 0; i < ids.length; i++) {
      var s = g.se[ids[i]];
      if (!s) continue;
      out[ids[i]] = '情绪' + Math.round(N(s.mood)) + ' 增长' + R(s.gdp, 1) + ' 失业' + R(s.unemp, 1);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 主函数
   * ------------------------------------------------------------------ */
  function snapshot(mode, extra) {
    extra = extra || {};
    var g = G();
    var level = (global.AICFG && AICFG.contextLevel) || 'standard';
    if (!g) return { error: 'no-game' };

    var p = g.pres || null;
    var you = {
      身份: mode === 'campaign' ? '总统候选人' : '总统',
      姓名: (p && p.name) || (g.player && g.player.name) || '（未定）',
      党: partyCN((p && p.party) || (g.player && g.player.party)),
      支持率: p ? R(p.appr, 1) : null,
      任期第几届: p ? (p.terms || 1) : null,
      蜜月期剩余周: p && p.honeymoon ? p.honeymoon : 0,
      立场: p && p.iss ? issueVec(p.iss) : (g.player && g.player.iss ? issueVec(g.player.iss) : '')
    };

    var econ = {
      增长: R(g.econ && g.econ.gdp, 1),
      失业: R(g.econ && g.econ.unemp, 1),
      通胀: R(g.econ && g.econ.infl, 1),
      基准利率: R(g.econ && (g.econ.fedRate != null ? g.econ.fedRate : g.econ.fedTarget), 2),
      信心: R(g.econ && g.econ.conf, 0),
      股市: R(g.econ && g.econ.sp, 0),
      赤字占GDP: R(g.econ && g.econ.def, 1),
      债务: R(g.econ && g.econ.debt, 1),
      油价: R(g.econ && g.econ.fuel, 2)
    };
    if (level !== 'lite') {
      try {
        var pr = global.econPressure ? econPressure() : null;
        if (pr) econ.压力 = {
          衰退风险: pr.recession ? '高' : '低',
          通胀: R(pr.infl, 2), 失业: R(pr.unemp, 2)
        };
      } catch (e) {}
    }

    var politics = {
      全球紧张度: R(g.tension, 0),
      社会撕裂: R(g.div, 0),
      行动点: N(g.ap) + '/' + N(g.apMax),
      政治资本: g.player ? R(g.player.pc, 0) : null,
      国会: congressLine()
    };
    if (level !== 'lite') politics.党内派别 = factionLine();

    var ctx = {
      时间: (global.dateLabel ? dateLabel(g.y, g.w) : (g.y + '年')) +
            '（第' + g.w + '/52 周）',
      阶段: g.phase,
      你: you,
      经济: econ,
      政治: politics
    };

    if (g.player && g.player.pc != null && level === 'lite') ctx.政治.政治资本 = R(g.player.pc, 0);

    if (level !== 'lite') {
      ctx.世界 = worldLine(level);
      ctx.行业 = sectorLine();
      var pf = platformLine(); if (pf) ctx.执政纲领 = pf;
      var bl = billsLine(); if (bl) ctx.法案 = bl;
      var cs = crisisList(level); if (cs.length) ctx.危机 = cs;
      var sh = shockList(); if (sh.length) ctx.冲击 = sh;
      var ra = recentAI(); if (ra.length) ctx.你最近做过 = ra;
    }

    if (mode === 'campaign' || level === 'deep') {
      try {
        var c = global.ensureCamp ? ensureCamp() : g.campaign;
        if (c) {
          ctx.竞选 = {
            阶段: g.phase === 'primary' ? '初选' : '大选',
            资金百万: Math.round(N(c.funds)),
            体力: Math.round(N(c.energy, 100)),
            势头: R(c.momentum, 2),
            丑闻热度: R(global.campStatGet ? campStatGet('scandalHeat') : c.scandalHeat, 0),
            知名度: R(global.campStatGet ? campStatGet('nameRec') : c.nameRec, 0),
            地面组织: R(global.campStatGet ? campStatGet('groundGame') : c.groundGame, 0)
          };
          var pl = pollLine(); if (pl && typeof pl === 'object') ctx.民调 = pl;
        }
      } catch (e) {}
    }

    if (level === 'deep') {
      try {
        var st = snapStates(level);
        if (st) ctx.重点州 = st;
        ctx.全局统计 = g.stats;
        ctx.近期新闻 = logTail(18);
        ctx.存档标记 = Object.keys(g.flags || {}).filter(function (k) {
          return String(k).indexOf('ai_') === 0;
        }).slice(-8);
      } catch (e) {}
    } else {
      try { ctx.近期新闻 = logTail(8); } catch (e) {}
    }

    /* 当前等待决断的事项：由调用方传入，比从 G 里猜更准 */
    if (extra.decision) ctx.待决断 = extra.decision;
    if (extra.crisis) ctx.当前危机 = extra.crisis;
    if (extra.shock) ctx.当前冲击 = extra.shock;
    if (extra.playerContext) ctx.玩家状态 = extra.playerContext;

    return ctx;
  }

  function text(mode, extra) {
    var o = snapshot(mode, extra);
    try { return JSON.stringify(o); } catch (e) { return '{}'; }
  }

  /* 粗略 token 估算：中文按 1 字 ≈ 1.4 token，ASCII 按 4 字符 ≈ 1 token */
  function estimateTokens(s) {
    s = String(s || '');
    var cjk = 0, other = 0;
    for (var i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) > 255) cjk++; else other++;
    }
    return Math.round(cjk * 1.4 + other / 4);
  }

  global.AICTX = { snapshot: snapshot, text: text, estimateTokens: estimateTokens };
})(window);
