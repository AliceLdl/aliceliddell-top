/* ============================================================================
   ai-ledger.js — 叙事账本（双层记忆）
   《总统模拟器 · AI 版》扩展层第 3 块
   ----------------------------------------------------------------------------
   数字之外，政治还有另一半：谁下了什么命令、谁在等答复、哪颗雷还没爆。
   这里维护两份账：

     ① 态势简报 G.aiWorld.brief      —— 玩家可见（战情室「态势」面板）
        形势摘要 / 局势要点 / 最近行动 / 外部事件 / 承诺与期限 / 关键人物态度 / 风险

     ② 内部档案 G.aiWorld.dossier    —— 玩家不可见，只喂给模型
        隐藏事实 / 因果链 / 行为体真实议程 / 定时后果 / 玩家画像 / 裁决者笔记

   两份账都随原版存档走（普通字段）。每次裁决由模型写「增量」，代码负责
   打周次戳、去重、限长；每 N 次（或玩家点「整理」）再由模型整体重写一遍，
   把重复的合并、过期的删掉 —— 这就是「AI 维护账本」的闭环。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 上限（超过就丢最旧的；整理时也照这个压）
   * ------------------------------------------------------------------ */
  var CAP = {
    summary: 180,
    situation: 6, actions: 12, external: 10, commitments: 8, actors: 10, risks: 6,
    facts: 28, chains: 14, agendas: 12, ticking: 14, notes: 24, log: 90,
    briefInPrompt: 1400, dossierInPrompt: 1100
  };

  function cfg() { return global.AICFG || {}; }
  function G() { return global.AIG.g(); }
  function round(v, d) { return global.AI.round(v, d); }

  function clean(s, n) {
    var t = String(s == null ? '' : s)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (n && t.length > n) t = t.slice(0, n) + '…';
    return t;
  }

  function weekLabel() {
    var g = G();
    if (!g) return '';
    return g.y + '·W' + g.w;
  }
  function dateCN() {
    var g = G();
    if (!g) return '';
    try {
      if (typeof dateLabel === 'function') return dateLabel(g.y, g.w);
    } catch (e) {}
    return g.y + '年 第' + g.w + '周';
  }

  function blank() {
    return {
      v: 1,
      updated: '',
      sinceMaintain: 0,
      brief: {
        summary: '',
        situation: [],
        actions: [],
        external: [],
        commitments: [],
        actors: [],
        risks: []
      },
      dossier: {
        facts: [],
        chains: [],
        agendas: [],
        ticking: [],
        profile: { style: '', weaknesses: [], base: '' },
        notes: []
      },
      log: []
    };
  }

  /* ------------------------------------------------------------------ *
   * 去重与入列
   * ------------------------------------------------------------------ */
  function keyOf(s) {
    return clean(s, 80).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').slice(0, 18);
  }

  function pushNewest(list, item, max, key) {
    if (!item) return;
    var k = key || keyOf(item.t || item.who || item.note || '');
    if (k) {
      for (var i = 0; i < list.length; i++) {
        var kk = keyOf(list[i].t || list[i].who || list[i].note || '');
        if (kk && kk === k) {
          /* 同一条：用新的覆盖旧的（保留最新措辞与周次） */
          list[i] = item;
          return;
        }
      }
    }
    list.push(item);
    while (list.length > max) list.shift();
  }

  function trimStrings(list, max, n) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = clean(list[i], n || 80);
      if (!t) continue;
      if (out.indexOf(t) >= 0) continue;
      out.push(t);
    }
    while (out.length > max) out.shift();
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 初始化 / 迁移
   * ------------------------------------------------------------------ */
  function ensure() {
    var g = G();
    if (!g) return null;
    if (!g.aiWorld || typeof g.aiWorld !== 'object') g.aiWorld = blank();
    var s = g.aiWorld;
    var b = blank();
    /* 字段补齐（旧存档 / 半损坏时都能救） */
    if (!s.brief || typeof s.brief !== 'object') s.brief = b.brief;
    if (!s.dossier || typeof s.dossier !== 'object') s.dossier = b.dossier;
    var bk = b.brief, dk = b.dossier;
    for (var k in bk) if (s.brief[k] == null) s.brief[k] = bk[k];
    for (var k2 in dk) if (s.dossier[k2] == null) s.dossier[k2] = dk[k2];
    if (!Array.isArray(s.brief.situation)) s.brief.situation = [];
    if (!Array.isArray(s.brief.actions)) s.brief.actions = [];
    if (!Array.isArray(s.brief.external)) s.brief.external = [];
    if (!Array.isArray(s.brief.commitments)) s.brief.commitments = [];
    if (!Array.isArray(s.brief.actors)) s.brief.actors = [];
    if (!Array.isArray(s.brief.risks)) s.brief.risks = [];
    if (!Array.isArray(s.dossier.facts)) s.dossier.facts = [];
    if (!Array.isArray(s.dossier.chains)) s.dossier.chains = [];
    if (!Array.isArray(s.dossier.agendas)) s.dossier.agendas = [];
    if (!Array.isArray(s.dossier.ticking)) s.dossier.ticking = [];
    if (!Array.isArray(s.dossier.notes)) s.dossier.notes = [];
    if (!s.dossier.profile || typeof s.dossier.profile !== 'object') s.dossier.profile = { style: '', weaknesses: [], base: '' };
    if (!Array.isArray(s.log)) s.log = [];
    if (typeof s.sinceMaintain !== 'number') s.sinceMaintain = 0;
    if (!s.updated) s.updated = dateCN();
    return s;
  }

  /* ------------------------------------------------------------------ *
   * 写入：模型给的增量（ledger）
   * ------------------------------------------------------------------ */
  function normalizeDelta(raw) {
    var out = { summary: '', situation: [], actions: [], external: [],
                commitments: [], actors: [], risks: [],
                dossier: { facts: [], chains: [], agendas: [], ticking: [], notes: [] } };
    if (!raw || typeof raw !== 'object') return out;
    out.summary = clean(raw.summary, CAP.summary);
    function arr(v, n) { return Array.isArray(v) ? v.slice(0, n) : []; }

    arr(raw.situation, 3).forEach(function (t) {
      var s = clean(t, 60); if (s) out.situation.push(s);
    });
    arr(raw.actions, 3).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 70);
      if (!t) return;
      out.actions.push({ w: weekLabel(), t: t, outcome: clean(o.outcome, 80),
                         tags: Array.isArray(o.tags) ? o.tags.slice(0, 3).map(function (x) { return clean(x, 6); }) : [] });
    });
    arr(raw.external, 3).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 80);
      if (!t) return;
      out.external.push({ w: weekLabel(), t: t, impact: clean(o.impact, 70) });
    });
    arr(raw.commitments, 3).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 70);
      if (!t) return;
      out.commitments.push({ w: weekLabel(), t: t, due: clean(o.due, 20),
                             status: clean(o.status, 8) || 'pending' });
    });
    arr(raw.actors, 4).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { who: a } : a;
      var who = clean(o.who, 20);
      if (!who) return;
      out.actors.push({ w: weekLabel(), who: who, stance: clean(o.stance, 40) });
    });
    arr(raw.risks, 3).forEach(function (t) {
      var s = clean(t, 60); if (s) out.risks.push(s);
    });

    var d = raw.dossier && typeof raw.dossier === 'object' ? raw.dossier : {};
    arr(d.facts, 4).forEach(function (t) { var s = clean(t, 120); if (s) out.dossier.facts.push(s); });
    arr(d.chains, 3).forEach(function (t) { var s = clean(t, 120); if (s) out.dossier.chains.push(s); });
    arr(d.agendas, 4).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { who: a } : a;
      var who = clean(o.who, 20); if (!who) return;
      out.dossier.agendas.push({ who: who, goal: clean(o.goal, 50), method: clean(o.method, 50) });
    });
    arr(d.ticking, 4).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 80); if (!t) return;
      out.dossier.ticking.push({ t: t, due: clean(o.due, 20), effect: clean(o.effect, 60) });
    });
    arr(d.notes, 3).forEach(function (t) { var s = clean(t, 100); if (s) out.dossier.notes.push(s); });
    return out;
  }

  function applyDelta(raw, meta) {
    var s = ensure();
    if (!s) return { added: 0 };
    var d = normalizeDelta(raw);
    var b = s.brief, k = s.dossier;
    var added = 0;

    if (d.summary) { b.summary = d.summary; added++; }
    d.situation.forEach(function (t) { pushNewest(b.situation, t, CAP.situation); added++; });
    d.actions.forEach(function (a) { pushNewest(b.actions, a, CAP.actions); added++; });
    d.external.forEach(function (a) { pushNewest(b.external, a, CAP.external); added++; });
    d.commitments.forEach(function (a) { pushNewest(b.commitments, a, CAP.commitments); added++; });
    d.actors.forEach(function (a) { pushNewest(b.actors, a, CAP.actors, keyOf(a.who)); added++; });
    d.risks.forEach(function (t) { pushNewest(b.risks, { w: weekLabel(), t: t }, CAP.risks); added++; });

    d.dossier.facts.forEach(function (t) { pushNewest(k.facts, { w: weekLabel(), t: t }, CAP.facts); added++; });
    d.dossier.chains.forEach(function (t) { pushNewest(k.chains, { w: weekLabel(), t: t }, CAP.chains); added++; });
    d.dossier.agendas.forEach(function (a) {
      pushNewest(k.agendas, { w: weekLabel(), who: a.who, goal: a.goal, method: a.method }, CAP.agendas, keyOf(a.who));
      added++;
    });
    d.dossier.ticking.forEach(function (a) {
      pushNewest(k.ticking, { w: weekLabel(), t: a.t, due: a.due, effect: a.effect }, CAP.ticking);
      added++;
    });
    d.dossier.notes.forEach(function (t) { pushNewest(k.notes, { w: weekLabel(), t: t }, CAP.notes); added++; });

    s.updated = dateCN();
    if (meta && meta.mode) {
      s.log.push({ w: weekLabel(), kind: meta.mode, t: clean(meta.headline || meta.input || '', 80) });
      while (s.log.length > CAP.log) s.log.shift();
    }
    s.sinceMaintain = (s.sinceMaintain || 0) + 1;
    return { added: added };
  }

  /* 引擎事件（随机事件 / 历史事件）自动入账：不花费 token，玩家也能看到 */
  function noteExternal(ev, extra) {
    var s = ensure();
    if (!s || !ev) return;
    var title = clean(ev.cn || ev.title || '外部事件', 40);
    var text = clean(ev.text || ev.t || '', 110);
    var item = { w: weekLabel(), t: title + (text ? '：' + text : ''), impact: clean(extra && extra.impact, 60) };
    pushNewest(s.brief.external, item, CAP.external);
    s.log.push({ w: weekLabel(), kind: 'event', t: title });
    while (s.log.length > CAP.log) s.log.shift();
    s.updated = dateCN();
  }

  /* ------------------------------------------------------------------ *
   * 喂给模型的两段文本
   * ------------------------------------------------------------------ */
  function fmtList(list, mapper, max) {
    var out = [];
    for (var i = 0; i < list.length && out.length < max; i++) {
      var v = mapper(list[i], i);
      if (v) out.push(v);
    }
    return out.join('\n');
  }

  function briefForPrompt() {
    var s = ensure();
    if (!s) return '';
    var b = s.brief;
    var lines = [];
    if (b.summary) lines.push('摘要：' + b.summary);
    if (b.situation.length) lines.push('局势：' + b.situation.join('；'));
    if (b.actions.length) {
      lines.push('最近行动：\n' + fmtList(b.actions.slice(-6), function (a) {
        return '· [' + a.w + '] ' + a.t + (a.outcome ? ' → ' + a.outcome : '');
      }, 6));
    }
    if (b.external.length) {
      lines.push('外部事件：\n' + fmtList(b.external.slice(-5), function (a) {
        return '· [' + a.w + '] ' + a.t + (a.impact ? '（' + a.impact + '）' : '');
      }, 5));
    }
    if (b.commitments.length) {
      lines.push('承诺与期限：\n' + fmtList(b.commitments.slice(-4), function (a) {
        return '· ' + a.t + (a.due ? '（' + a.due + '）' : '') + ' [' + a.status + ']';
      }, 4));
    }
    if (b.actors.length) {
      lines.push('关键人物：\n' + fmtList(b.actors.slice(-5), function (a) {
        return '· ' + a.who + '：' + a.stance;
      }, 5));
    }
    if (b.risks.length) lines.push('已知风险：' + b.risks.join('；'));
    var t = lines.join('\n');
    return t.length > CAP.briefInPrompt ? t.slice(0, CAP.briefInPrompt) + '…' : t;
  }

  function dossierForPrompt(level) {
    var s = ensure();
    if (!s) return '';
    var d = s.dossier;
    var n = level === 'deep' ? 99 : (level === 'lite' ? 4 : 8);
    var lines = [];
    if (d.facts.length) {
      lines.push('事实：\n' + fmtList(d.facts.slice(-n), function (a) { return '· [' + a.w + '] ' + a.t; }, n));
    }
    if (d.chains.length) {
      lines.push('因果链：\n' + fmtList(d.chains.slice(-Math.min(n, 6)), function (a) { return '· ' + a.t; }, 6));
    }
    if (d.agendas.length) {
      lines.push('各方真实议程：\n' + fmtList(d.agendas.slice(-Math.min(n, 6)), function (a) {
        return '· ' + a.who + '：想' + (a.goal || '?') + '，手段' + (a.method || '?');
      }, 6));
    }
    if (d.ticking.length) {
      lines.push('尚未爆发的后果：\n' + fmtList(d.ticking.slice(-Math.min(n, 6)), function (a) {
        return '· ' + a.t + (a.due ? '（' + a.due + '触发）' : '') + (a.effect ? ' → ' + a.effect : '');
      }, 6));
    }
    if (d.profile && (d.profile.style || (d.profile.weaknesses || []).length)) {
      lines.push('玩家画像：' + (d.profile.style || '') +
        ((d.profile.weaknesses || []).length ? '；软肋：' + d.profile.weaknesses.join('、') : '') +
        (d.profile.base ? '；基本盘：' + d.profile.base : ''));
    }
    if (d.notes.length) {
      lines.push('裁决者笔记：\n' + fmtList(d.notes.slice(-Math.min(n, 8)), function (a) { return '· ' + a.t; }, 8));
    }
    var t = lines.join('\n');
    return t.length > CAP.dossierInPrompt ? t.slice(0, CAP.dossierInPrompt) + '…' : t;
  }

  /* ------------------------------------------------------------------ *
   * 整理（由模型整体重写；失败时本地压缩）
   * ------------------------------------------------------------------ */
  function maintenancePayload() {
    var s = ensure();
    var g = G();
    var nums = {};
    if (g) {
      nums = {
        时间: weekLabel(),
        支持率: g.pres ? round(g.pres.appr, 1) : null,
        行动点: (g.ap || 0) + '/' + (g.apMax || 0),
        经济: g.econ ? { 增长: round(g.econ.gdp, 1), 失业: round(g.econ.unemp, 1),
                        通胀: round(g.econ.infl, 1), 信心: Math.round(g.econ.conf || 0) } : null,
        紧张度: Math.round(g.tension || 0),
        撕裂: Math.round(g.div || 0)
      };
    }
    return {
      now: weekLabel(),
      numbers: nums,
      brief: s ? s.brief : blank().brief,
      dossier: s ? s.dossier : blank().dossier,
      recent: s ? s.log.slice(-24) : [],
      limits: {
        summary: '≤120字',
        situation: CAP.situation, actions: CAP.actions, external: CAP.external,
        commitments: CAP.commitments, actors: CAP.actors, risks: CAP.risks,
        facts: CAP.facts, chains: CAP.chains, agendas: CAP.agendas,
        ticking: CAP.ticking, notes: CAP.notes
      }
    };
  }

  function applyMaintenance(obj) {
    var s = ensure();
    if (!s || !obj || typeof obj !== 'object') return false;
    var b = obj.brief || obj['简报'] || null;
    var d = obj.dossier || obj['档案'] || null;
    /* 结构不对（例如模型又给了一份裁决）时绝不能落盘，否则会把账本清空 */
    if (!b && !d) return false;
    if (b && typeof b !== 'object') return false;
    if (d && typeof d !== 'object') return false;
    b = b || {};
    d = d || {};
    var nb = blank().brief, nd = blank().dossier;

    nb.summary = clean(b.summary, CAP.summary);
    nb.situation = trimStrings(Array.isArray(b.situation) ? b.situation : [], CAP.situation, 70);
    nb.actions = [];
    (Array.isArray(b.actions) ? b.actions : []).slice(-CAP.actions).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 70); if (!t) return;
      nb.actions.push({ w: clean(o.w, 12) || weekLabel(), t: t, outcome: clean(o.outcome, 80),
                        tags: Array.isArray(o.tags) ? o.tags.slice(0, 3).map(function (x) { return clean(x, 6); }) : [] });
    });
    nb.external = [];
    (Array.isArray(b.external) ? b.external : []).slice(-CAP.external).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 90); if (!t) return;
      nb.external.push({ w: clean(o.w, 12) || weekLabel(), t: t, impact: clean(o.impact, 70) });
    });
    nb.commitments = [];
    (Array.isArray(b.commitments) ? b.commitments : []).slice(-CAP.commitments).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 70); if (!t) return;
      nb.commitments.push({ w: clean(o.w, 12) || weekLabel(), t: t, due: clean(o.due, 20),
                            status: clean(o.status, 8) || 'pending' });
    });
    nb.actors = [];
    (Array.isArray(b.actors) ? b.actors : []).slice(-CAP.actors).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { who: a } : a;
      var who = clean(o.who, 20); if (!who) return;
      nb.actors.push({ w: clean(o.w, 12) || weekLabel(), who: who, stance: clean(o.stance, 40) });
    });
    nb.risks = trimStrings(Array.isArray(b.risks) ? b.risks : [], CAP.risks, 60);

    nd.facts = [];
    (Array.isArray(d.facts) ? d.facts : []).slice(-CAP.facts).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 120); if (!t) return;
      nd.facts.push({ w: clean(o.w, 12) || weekLabel(), t: t });
    });
    nd.chains = [];
    (Array.isArray(d.chains) ? d.chains : []).slice(-CAP.chains).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 120); if (!t) return;
      nd.chains.push({ w: clean(o.w, 12) || weekLabel(), t: t });
    });
    nd.agendas = [];
    (Array.isArray(d.agendas) ? d.agendas : []).slice(-CAP.agendas).forEach(function (a) {
      if (!a || !a.who) return;
      nd.agendas.push({ w: clean(a.w, 12) || weekLabel(), who: clean(a.who, 20),
                        goal: clean(a.goal, 50), method: clean(a.method, 50) });
    });
    nd.ticking = [];
    (Array.isArray(d.ticking) ? d.ticking : []).slice(-CAP.ticking).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 90); if (!t) return;
      nd.ticking.push({ w: clean(o.w, 12) || weekLabel(), t: t, due: clean(o.due, 20), effect: clean(o.effect, 60) });
    });
    nd.notes = [];
    (Array.isArray(d.notes) ? d.notes : []).slice(-CAP.notes).forEach(function (a) {
      if (!a) return;
      var o = typeof a === 'string' ? { t: a } : a;
      var t = clean(o.t, 100); if (!t) return;
      nd.notes.push({ w: clean(o.w, 12) || weekLabel(), t: t });
    });
    if (d.profile && typeof d.profile === 'object') {
      nd.profile = {
        style: clean(d.profile.style, 100),
        weaknesses: Array.isArray(d.profile.weaknesses) ? trimStrings(d.profile.weaknesses, 5, 24) : [],
        base: clean(d.profile.base, 60)
      };
    }

    s.brief = nb;
    s.dossier = nd;
    s.updated = dateCN();
    s.sinceMaintain = 0;
    s.log.push({ w: weekLabel(), kind: 'maintain', t: '账本整理' });
    while (s.log.length > CAP.log) s.log.shift();
    return true;
  }

  /* 本地压缩：去重 + 截断，不花 token */
  function localCompact() {
    var s = ensure();
    if (!s) return;
    function uniq(list, keyFn, max) {
      var seen = {}, out = [];
      for (var i = list.length - 1; i >= 0; i--) {
        var it = list[i];
        var k = keyFn(it);
        if (k && seen[k]) continue;
        seen[k] = 1;
        out.unshift(it);
      }
      while (out.length > max) out.shift();
      return out;
    }
    s.brief.situation = uniq(s.brief.situation.map(function (t) { return t; }), function (t) { return keyOf(t); }, CAP.situation);
    s.brief.actions = uniq(s.brief.actions, function (a) { return keyOf(a.t); }, CAP.actions);
    s.brief.external = uniq(s.brief.external, function (a) { return keyOf(a.t); }, CAP.external);
    s.brief.commitments = uniq(s.brief.commitments, function (a) { return keyOf(a.t); }, CAP.commitments);
    s.brief.actors = uniq(s.brief.actors, function (a) { return keyOf(a.who); }, CAP.actors);
    s.brief.risks = uniq(s.brief.risks, function (a) { return keyOf(a.t); }, CAP.risks);
    s.dossier.facts = uniq(s.dossier.facts, function (a) { return keyOf(a.t); }, CAP.facts);
    s.dossier.chains = uniq(s.dossier.chains, function (a) { return keyOf(a.t); }, CAP.chains);
    s.dossier.agendas = uniq(s.dossier.agendas, function (a) { return keyOf(a.who); }, CAP.agendas);
    s.dossier.ticking = uniq(s.dossier.ticking, function (a) { return keyOf(a.t); }, CAP.ticking);
    s.dossier.notes = uniq(s.dossier.notes, function (a) { return keyOf(a.t); }, CAP.notes);
    s.updated = dateCN();
    s.sinceMaintain = 0;
  }

  /* ------------------------------------------------------------------ *
   * 触发条件 / 状态
   * ------------------------------------------------------------------ */
  function needsMaintenance() {
    var s = ensure();
    if (!s) return false;
    var every = Math.max(1, Number(cfg().maintainEvery) || 5);
    if (s.sinceMaintain >= every) return true;
    var b = s.brief, d = s.dossier;
    return (b.actions.length >= CAP.actions || b.external.length >= CAP.external ||
            d.facts.length >= CAP.facts || d.ticking.length >= CAP.ticking);
  }

  function stats() {
    var s = ensure();
    if (!s) return { actions: 0, external: 0, facts: 0, ticking: 0, updated: '' };
    return {
      actions: s.brief.actions.length,
      external: s.brief.external.length,
      commitments: s.brief.commitments.length,
      actors: s.brief.actors.length,
      risks: s.brief.risks.length,
      facts: s.dossier.facts.length,
      chains: s.dossier.chains.length,
      agendas: s.dossier.agendas.length,
      ticking: s.dossier.ticking.length,
      sinceMaintain: s.sinceMaintain || 0,
      updated: s.updated || ''
    };
  }

  function hasContent() {
    var s = ensure();
    if (!s) return false;
    return !!(s.brief.summary || s.brief.actions.length || s.brief.external.length ||
              s.brief.situation.length);
  }

  function reset() {
    var g = G();
    if (g) g.aiWorld = blank();
  }

  global.AILEDGER = {
    CAP: CAP,
    blank: blank,
    ensure: ensure,
    normalizeDelta: normalizeDelta,
    applyDelta: applyDelta,
    noteExternal: noteExternal,
    briefForPrompt: briefForPrompt,
    dossierForPrompt: dossierForPrompt,
    maintenancePayload: maintenancePayload,
    applyMaintenance: applyMaintenance,
    localCompact: localCompact,
    needsMaintenance: needsMaintenance,
    stats: stats,
    hasContent: hasContent,
    reset: reset,
    weekLabel: weekLabel,
    dateCN: dateCN
  };
})(window);
