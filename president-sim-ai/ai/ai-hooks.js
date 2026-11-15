/* ============================================================================
   ai-hooks.js — 挂载与结算流程
   《总统模拟器 · AI 版》扩展层第 7 块
   ----------------------------------------------------------------------------
   1. 覆写原版的五个入口（战情室 / 竞选行动 / 事件卡 / 冲击弹窗 / 危机面板）
      与 modalHTML（接管三种 AI 弹窗）。AI 关闭时原样交回原版函数。
   2. 实现提交管线：读输入 → 组上下文与提示词 → 调接口 → 解析 → 归一化
      → 限幅 → 结算 → 推进事件/冲击/危机的状态 → 重绘。
   3. 把「改完的 AI 结果」交回原版机制：applyFx 进经济冲量队列、
      applyCampFx 进竞选统计、makeCustomBill 进法案起草队列、
      _shockResolve 记冲击进度、crisis 的冷却与推进照旧。
   ========================================================================== */
(function (global) {
  'use strict';

  var AIORIG = {};
  var installed = false;

  function cfg() { return global.AICFG || {}; }
  function G() { return global.AIG.g(); }
  function toast(msg) { try { if (typeof showToast === 'function') showToast(msg); } catch (e) {} }
  function fail(msg) { global.AIUI.fail(msg); }
  function ap() { return (G() && G().ap) || 0; }

  /* ------------------------------------------------------------------ *
   * 经典（原版）选项片段：AI 出错时可以退回
   * ------------------------------------------------------------------ */
  function eventChoicesHTML() {
    var g = G();
    if (!g || !g.pendingEvents || !g.pendingEvents.length) return '';
    var ev = g.pendingEvents[0].ev || {};
    var ch = ev.ch || [];
    if (!ch.length) return '<div class="muted">这个事件没有预设选项。</div>';
    return '<div class="choices">' + ch.map(function (c, i) {
      return '<div class="choice" onclick="chooseEvent(0,' + i + ');render()">' +
        '<div class="t">' + global.AI.esc(c.t) + '</div>' +
        '<div class="d">' + global.AI.esc(c.d || '') + '</div>' +
        (typeof fxHint === 'function' ? fxHint(c) : '') + '</div>';
    }).join('') + '</div>';
  }

  function shockChoicesHTML() {
    var m = UI && UI.modal;
    if (!m || m.type !== 'shockev' || !m.ev) return '';
    var opts = m.ev.o || [];
    if (!opts.length) return '<div class="muted">这个节点没有预设选项。</div>';
    return '<div class="choices">' + opts.map(function (o) {
      if (!o || !o.id) return '';
      return '<div class="choice" onclick="shockEventAct(\'' + o.id + '\')">' +
        '<div class="t">' + global.AI.esc(o.t) + '</div>' +
        '<div class="d">' + global.AI.esc(o.d || '') + '</div>' +
        '<div class="eff">行动点 ' + (o.ap || 0) + '</div></div>';
    }).join('') + '</div>';
  }

  function crisisChoicesHTML() {
    /* 危机面板结构复杂，这里只给一条退出通道 */
    return '<div class="ai-classic"><button class="btn sm" onclick="AI.set({enabled:false});AIUI.state.error=null;render()">' +
      '关闭 AI 模式，回到原版危机面板</button></div>';
  }

  /* ------------------------------------------------------------------ *
   * 上下文补充：把「正在等待决断的那件事」摘出来
   * ------------------------------------------------------------------ */
  function decisionExtra() {
    var g = G();
    if (!g || !g.pendingEvents || !g.pendingEvents.length) return null;
    var pe = g.pendingEvents[0], ev = pe.ev || {};
    var extra = {
      decision: {
        标题: ev.cn || '突发事件',
        正文: pe.txt || ev.t || '',
        类型: ev.crisis ? '国际危机连锁事件' : (ev.id ? ('事件 ' + ev.id) : '突发事件')
      }
    };
    /* 给 AI 一个「原版数值量级」参考，让它的力度与原事件匹配，但不告诉它选项内容 */
    if (ev.ch && ev.ch.length) {
      var mag = 0, n = 0;
      ev.ch.forEach(function (c) {
        var f = (c && c.fx) || {};
        ['appr', 'tension', 'gdp', 'unemp', 'infl', 'pc', 'div'].forEach(function (k) {
          if (f[k]) { mag += Math.abs(f[k]); n++; }
        });
      });
      extra.decision.量级参考 = n ? Math.round(mag / n * 10) / 10 : 2;
    }
    if (ev.m != null && MONTHS_CN) extra.decision.月份 = MONTHS_CN[ev.m];
    return extra;
  }

  function shockExtra() {
    var m = UI && UI.modal;
    if (!m || m.type !== 'shockev' || !m.shock) return null;
    var k = m.shock, ev = m.ev || {};
    var def = (ERA_SHOCKS && ERA_SHOCKS[k]) || {};
    var prog = 0;
    try { prog = Math.round(global.shockScore(k) * 100); } catch (e) {}
    var txt = '';
    try { txt = (typeof evTextNow === 'function') ? evTextNow(ev) : (ev.t || ''); } catch (e) { txt = ev.t || ''; }
    return {
      shock: {
        冲击: def.cn || k,
        节点: ev.cn || '',
        正文: txt,
        应对进度: prog + '%',
        已处理节点: ((G().shocks || {})[k] || {}).acted || 0,
        提示: '引擎会按应对进度削弱负面效果，只算这一节点的增量'
      }
    };
  }

  function crisisExtra() {
    var sel = UI && UI.selCrisis;
    if (!sel) return null;
    var c = null, def = null;
    try { c = global.activeCrisis(sel); def = global.crisisDef(sel); } catch (e) {}
    if (!c) return null;
    var txt = '';
    try {
      var st = (def && def.stages && def.stages.length)
        ? def.stages[Math.min(c.stage || 0, def.stages.length - 1)] : { t: '' };
      var evNode = (def && def.events && typeof crisisCurrentEvent === 'function') ? crisisCurrentEvent(c, def) : null;
      var tNode = (!evNode && typeof crisisNodeOf === 'function') ? crisisNodeOf(c, def) : null;
      var stageTxt = evNode ? evNode.t : (tNode ? tNode.t : st.t);
      txt = (typeof evTextNow === 'function') ? evTextNow(evNode || stageTxt) : String(stageTxt || '');
    } catch (e) {}
    return {
      crisis: {
        危机: c.cn || (def && def.cn) || sel,
        背景: def && def.hist ? def.hist : '',
        当前阶段: txt,
        介入程度: c.involvement || 0,
        已获军事授权: !!c.law,
        对手国: def && def.foe ? def.foe : ''
      }
    };
  }

  /* ------------------------------------------------------------------ *
   * 提交管线
   * ------------------------------------------------------------------ */
  function submit(kind) {
    var ui = global.AIUI;
    if (!ui) return;
    if (global.AI.STAT.busy) { toast('上一个请求还没回来，稍等一下。'); return; }
    if (!cfg().enabled) { toast('AI 模式已关闭。可在 AI 设置里重新打开。'); return; }

    var input = String(ui.state.draft[kind] || '').trim();
    if (!input) { ui.state.error = '先写一句你要做的事，再提交。'; render(); return; }
    if (input.length > 500) { ui.state.error = '一次最多 500 字。请把指令写短一点。'; render(); return; }

    var g = G();
    if (!g || g.phase === 'setup') return;

    var mode = kind;
    if (kind === 'decision') mode = 'event';

    /* 前置校验：不消耗任何资源 */
    if (mode === 'national' || mode === 'campaign') {
      if (ap() < 1) { if (typeof actionFail === 'function') actionFail('本周行动点已用尽。'); return; }
    }
    if (mode === 'event' && !(g.pendingEvents && g.pendingEvents.length)) {
      ui.state.error = '当前没有待决断的事件。'; render(); return;
    }
    if (mode === 'shock' && !(UI.modal && UI.modal.type === 'shockev')) {
      ui.state.error = '当前没有待处理的冲击节点。'; render(); return;
    }
    if (mode === 'crisis' && !(UI.selCrisis && global.activeCrisis && global.activeCrisis(UI.selCrisis))) {
      ui.state.error = '当前没有选中危机。'; render(); return;
    }

    var extra = {};
    if (mode === 'event') extra = decisionExtra() || {};
    else if (mode === 'shock') extra = shockExtra() || {};
    else if (mode === 'crisis') extra = crisisExtra() || {};

    var label = ({ national: '白宫行动', campaign: '竞选行动', event: '事件决断',
                   shock: '冲击处置', crisis: '危机处置' })[mode] || mode;
    ui.startBusy(label);

    var ctxText = '';
    try { ctxText = global.AICTX.text(mode, extra); } catch (e) { ctxText = '{}'; }
    var built = null;
    try { built = global.AIPROMPT.build(mode, ctxText, input, {}); }
    catch (e) { fail('提示词组装失败：' + e.message); return; }

    var promptTok = global.AICTX.estimateTokens(built.system) + global.AICTX.estimateTokens(built.user);

    /* 把「这一次到底在决断哪件事」固定下来：等请求回来时，
       玩家可能已经点了别的界面，不能用 G.pendingEvents[0] 去猜。 */
    var decisionRef = (mode === 'event' && g.pendingEvents && g.pendingEvents[0])
      ? g.pendingEvents[0].ev : null;
    var shockRef = (mode === 'shock' && UI.modal && UI.modal.type === 'shockev')
      ? { k: UI.modal.shock, ev: UI.modal.ev } : null;

    function finishWith(rawText, dt, usage, attempt, endpoint, allowRepair) {
      var text = String(rawText == null ? '' : rawText).trim();
      if (!text) return { error: '接口返回了空内容' };
      var raw;
      try {
        raw = global.AICLIENT.extractJson(text);
      } catch (e) {
        return { error: e.message };
      }
      var norm = global.AIADJ.normalize(raw, mode, ctxText);
      /* 档位缺失/非法（上帝模式下只允许 成功/大成功）：整份结果作废，不落任何数值 */
      if (norm.invalid) {
        global.AI.STAT.last = {
          at: global.AI.nowText(), mode: mode, ms: dt, attempts: attempt,
          usage: usage, endpoint: endpoint || '', status: 'invalid',
          error: norm.rejectReason || '结果作废', promptTokens: promptTok
        };
        return { invalid: norm };
      }
      norm = global.AIADJ.gate(norm);

      global.AI.STAT.last = {
        at: global.AI.nowText(), mode: mode, ms: dt, attempts: attempt,
        usage: usage, endpoint: endpoint || '', status: 'ok', error: '',
        promptTokens: promptTok
      };

      var summary = global.AIADJ.apply(norm, mode, { input: input, source: 'ai' });
      summary.promptTokens = promptTok;
      ui.state.result = summary;
      ui.state.error = null;
      /* 成功结算后清空输入框，避免手滑重复提交 */
      var dk = (mode === 'event') ? 'decision' : mode;
      if (ui.state.draft && ui.state.draft[dk] != null) ui.state.draft[dk] = '';
      global.AI.STAT.count++;
      global.AI.STAT.tokensIn += (usage && usage.input) || 0;
      global.AI.STAT.tokensOut += (usage && usage.output) || 0;

      afterApply(mode, norm, summary, input, { decision: decisionRef, shock: shockRef });
      return { ok: true };
    }

    /* 结果作废：只报错，不改数值、不扣行动点、不推进事件/冲击/危机，也不回退到本地规则 */
    function rejectInvalid(norm) {
      ui.state.result = null;
      ui.state.error = (norm && norm.rejectReason)
        ? norm.rejectReason + '（未扣行动点，也未改动任何数值；可直接重试）'
        : 'AI 返回的结果不合规，已作废。';
    }

    global.AICLIENT.chat(built.system, built.user).then(function (res) {
      global.AI.STAT.last = { at: global.AI.nowText(), mode: mode, ms: res.totalMs || res.ms,
        attempts: res.attempts, usage: res.usage, endpoint: res.endpoint,
        status: 'ok', error: '', promptTokens: promptTok };
      var r = finishWith(res.text, res.totalMs || res.ms, res.usage, res.attempts, res.endpoint, true);
      if (r && r.invalid) { rejectInvalid(r.invalid); return null; }
      if (r && r.error) {
        /* 解析失败：带上修复指令重试一次；仍失败就作废，不落任何数值 */
        var user2 = built.user + '\n\n' + global.AIPROMPT.repairNote();
        return global.AICLIENT.chat(built.system, user2).then(function (res2) {
          var r2 = finishWith(res2.text, res2.totalMs || res2.ms, res2.usage,
                              (res2.attempts || 1) + 1, res2.endpoint, false);
          if (r2 && r2.invalid) { rejectInvalid(r2.invalid); return null; }
          if (r2 && r2.error) {
            ui.state.result = null;
            ui.state.error = '两次返回都无法解析（' + r2.error + '），本次结果作废，未改动任何数值。';
          }
          return null;
        });
      }
      return null;
    }).catch(function (e) {
      handleError(e, mode, input, extra, promptTok, { decision: decisionRef, shock: shockRef });
    }).then(function () {
      ui.endBusy();
      if (typeof render === 'function') render();
      /* 账本攒够了就让模型整体整理一遍（后台静默，不打断玩家） */
      try {
        var last = ui.state.result;
        if (last && last.source === 'ai' && cfg().maintainAuto) maintain(false);
      } catch (e) {}
    });
  }

  /* ------------------------------------------------------------------ *
   * 账本整理：把两份账整体重写一遍（合并重复、删过期）
   * ------------------------------------------------------------------ */
  function maintain(manual) {
    var ui = global.AIUI;
    if (!global.AILEDGER || !cfg().enabled) return;
    var state = global.AILEDGER.ensure();
    if (!state) return;
    if (global.AI.STAT.busy) {
      if (manual) toast('正在处理另一个请求，稍后再整理。');
      return;
    }
    if (!manual && !cfg().maintainAuto) return;
    if (!manual && !global.AILEDGER.needsMaintenance()) return;
    if (!state.brief.actions.length && !state.brief.external.length &&
        !state.dossier.facts.length && !state.brief.summary) return;

    var payload = global.AILEDGER.maintenancePayload();
    var built;
    try { built = global.AIPROMPT.buildMaintain(payload); }
    catch (e) { return; }

    /* 整理是后台动作：不要把战情室上刚显示的那张结果卡清掉 */
    var keepResult = ui.state.result;
    ui.startBusy('整理态势');
    ui.state.result = keepResult;
    global.AICLIENT.chat(built.system, built.user, {
      maxTokens: Math.max(1000, Number(cfg().maxTokens) || 1200),
      temperature: 0.2
    }).then(function (res) {
      var raw = global.AICLIENT.extractJson(res.text);
      var ok = global.AILEDGER.applyMaintenance(raw);
      if (!ok) throw new Error('整理结果结构不对');
      if (manual) toast('态势已整理：简报与内部档案都已合并。');
      ui.state.briefStamp = Date.now();
    }).catch(function (e) {
      global.AILEDGER.localCompact();
      if (manual) {
        ui.state.error = '模型整理失败，已用本地规则压缩合并：' + (e && e.message ? e.message : e);
      }
    }).then(function () {
      ui.endBusy();
      if (typeof render === 'function') render();
    });
  }

  function handleError(e, mode, input, extra, promptTok, refs) {
    var ui = global.AIUI;
    var msg = (e && e.message) ? e.message : String(e);
    global.AI.STAT.last = {
      at: global.AI.nowText(), mode: mode, ms: 0, attempts: 0, usage: null,
      endpoint: '', status: 'error', error: msg, promptTokens: promptTok
    };
    global.AI.STAT.error = msg;

    /* 接口没连上 / 没返回内容：直接作废这次指令，不扣行动点、不改数值、不回退本地规则 */
    ui.state.result = null;
    ui.state.error = msg + '。本次指令未执行：没有扣除行动点，也没有改动任何数值。' +
      '可重试，或到 AI 设置里检查接口；也可以展开「经典内置选项」继续玩。';
  }

  /* 结算之后：推进事件 / 冲击 / 危机各自的状态机 */
  function afterApply(mode, norm, summary, input, refs) {
    var g = G();
    if (!g) return;
    refs = refs || {};

    /* 初选阶段的竞选行动是在弹窗里提交的，结算完把弹窗收掉 */
    if (mode === 'campaign' && UI.modal && UI.modal.type === 'aicampaign') UI.modal = null;

    if (mode === 'event') {
      try {
        var list = g.pendingEvents || [];
        var idx = -1;
        if (refs.decision) {
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].ev === refs.decision) { idx = i; break; }
          }
        }
        if (idx < 0 && list.length) idx = 0;          /* 引用失效时退回队首 */
        if (idx >= 0) {
          list.splice(idx, 1);
          if (typeof log === 'function') {
            log('你的处置：' + String(input).slice(0, 64) + (String(input).length > 64 ? '…' : ''), 'hi');
          }
        }
        if (UI.modal && UI.modal.type === 'event') UI.modal = null;
      } catch (e) {}
      return;
    }

    if (mode === 'shock') {
      try {
        var k = refs.shock ? refs.shock.k : null;
        var ev = refs.shock ? refs.shock.ev : null;
        if (!k && UI.modal && UI.modal.type === 'shockev') { k = UI.modal.shock; ev = UI.modal.ev; }
        if (k && ev) {
          var def = (ERA_SHOCKS && ERA_SHOCKS[k]) || { cn: k };
          var id = 'ai_' + global.AI.uid();
          var dir = 0;
          if (/强硬|交易/.test(norm.tone || '')) dir = 1;
          else if (/拖延/.test(norm.tone || '')) dir = -1;
          ev.o = ev.o || [];
          ev.o.push({ id: id, t: String(input).slice(0, 42), d: 'AI 裁决', fx: {}, ap: 0, dir: dir });
          global._shockResolve(k, def, ev, id, false);
        }
        if (UI.modal && UI.modal.type === 'shockev') UI.modal = null;
      } catch (e) {
        summary.notes.push('冲击状态推进失败：' + (e.message || e));
      }
      return;
    }

    if (mode === 'crisis') {
      try {
        var sel = UI.selCrisis;
        var c = sel && global.activeCrisis ? global.activeCrisis(sel) : null;
        var cdef = sel && global.crisisDef ? global.crisisDef(sel) : null;
        if (!c) return;
        var now = (typeof absWeek === 'function') ? absWeek() : (g.y * 52 + g.w);
        c.involvement = Math.max(c.involvement || 0,
          /强硬|军事|介入|制裁/.test(norm.tone || '') ? 2 : 1);
        c.lastAct = now;
        c.nextAt = now + 4 + Math.floor(Math.random() * 3);
        if (cdef && cdef.events && typeof crisisPickNext === 'function' && typeof crisisSetEvent === 'function') {
          var nxt = crisisPickNext(c, cdef);
          if (nxt) {
            crisisSetEvent(c, cdef, nxt);
            if (typeof log === 'function') {
              log('【' + c.cn + '】' + ((typeof evTextNow === 'function') ? evTextNow(nxt) : (nxt.t || '')), 'hi');
            }
          } else {
            c.long = true;
            if (typeof log === 'function' && typeof crisisFollowUpText === 'function') {
              log('【' + c.cn + '】' + crisisFollowUpText(c, cdef), 'hi');
            }
          }
        } else {
          c.stage = (c.stage || 0) + 1;
          if (cdef && cdef.stages && c.stage >= cdef.stages.length) {
            c.long = true;
            try { (g.doneCrises = g.doneCrises || {})[c.id] = 1; } catch (e2) {}
            if (typeof log === 'function' && typeof crisisFollowUpText === 'function') {
              log('【' + c.cn + '】' + crisisFollowUpText(c, cdef), 'hi');
            }
          } else if (typeof log === 'function') {
            var st = cdef && cdef.stages ? cdef.stages[Math.min(c.stage, cdef.stages.length - 1)] : null;
            if (st && st.t) log('【' + c.cn + '】' + ((typeof evTextNow === 'function') ? evTextNow(st) : st.t), 'hi');
          }
        }
      } catch (e) {
        summary.notes.push('危机推进失败：' + (e.message || e));
      }
      return;
    }
  }

  /* ------------------------------------------------------------------ *
   * 安装覆写
   * ------------------------------------------------------------------ */
  function install() {
    if (installed) return;
    installed = true;

    /* 保存原函数（经典模式还要用） */
    AIORIG.presActionsPane = global.presActionsPane;
    AIORIG.camp2ActionsHTML = global.camp2ActionsHTML;
    AIORIG.pendingEventCard = global.pendingEventCard;
    AIORIG.shockEvModalPane = global.shockEvModalPane;
    AIORIG.crisisPane = global.crisisPane;
    AIORIG.modalHTML = global.modalHTML;
    AIORIG.gearBtnHTML = global.gearBtnHTML;
    AIORIG.actionButtons = global.actionButtons;
    AIORIG.campaignPane2 = global.campaignPane2;
    AIORIG.fireEvent = global.fireEvent;
    AIORIG.mainPane = global.mainPane;
    AIORIG.topbar = global.topbar;
    AIORIG.setTab = global.setTab;
    AIORIG.doAdvance = global.doAdvance;
    AIORIG.settingsPane = global.settingsPane;
    AIORIG.eventChoicesHTML = eventChoicesHTML;
    AIORIG.shockChoicesHTML = shockChoicesHTML;
    AIORIG.crisisChoicesHTML = crisisChoicesHTML;
    global.AIORIG = AIORIG;

    global.presActionsPane = function () {
      try {
        if (!cfg().enabled) return AIORIG.presActionsPane ? AIORIG.presActionsPane() : '';
        return global.AIUI.nationalConsoleHTML();
      } catch (e) { return AIORIG.presActionsPane ? AIORIG.presActionsPane() : ''; }
    };

    global.camp2ActionsHTML = function () {
      try {
        if (!cfg().enabled) return AIORIG.camp2ActionsHTML ? AIORIG.camp2ActionsHTML() : '';
        return global.AIUI.campaignConsoleHTML();
      } catch (e) { return AIORIG.camp2ActionsHTML ? AIORIG.camp2ActionsHTML() : ''; }
    };

    global.pendingEventCard = function () {
      try {
        if (!cfg().enabled || !G().pendingEvents.length) {
          return AIORIG.pendingEventCard ? AIORIG.pendingEventCard() : '';
        }
        return global.AIUI.eventCardHTML(G().pendingEvents[0]);
      } catch (e) { return AIORIG.pendingEventCard ? AIORIG.pendingEventCard() : ''; }
    };

    global.shockEvModalPane = function () {
      try {
        if (!cfg().enabled) return AIORIG.shockEvModalPane ? AIORIG.shockEvModalPane() : '';
        return global.AIUI.shockModalHTML();
      } catch (e) { return AIORIG.shockEvModalPane ? AIORIG.shockEvModalPane() : ''; }
    };

    global.crisisPane = function () {
      try {
        if (!cfg().enabled) return AIORIG.crisisPane ? AIORIG.crisisPane() : '';
        return global.AIUI.crisisPaneHTML();
      } catch (e) { return AIORIG.crisisPane ? AIORIG.crisisPane() : ''; }
    };

    global.modalHTML = function () {      var m = UI && UI.modal;
      if (m && (m.type === 'aiset' || m.type === 'aihist' || m.type === 'aipreview' ||
                m.type === 'aicampaign' || m.type === 'aibrief')) {
        return global.AIUI.modalFor(m.type);
      }
      if (cfg().enabled && m && m.type === 'event') {
        var g = G();
        if (g && g.pendingEvents && g.pendingEvents.length) {
          return global.AIUI.eventModalHTML(g.pendingEvents[0]);
        }
      }
      return AIORIG.modalHTML ? AIORIG.modalHTML() : '';
    };

    /* 引擎自己跑出来的外部事件（随机/历史事件）也进账：不花 token，玩家看得到 */
    global.fireEvent = function (ev) {
      var r = AIORIG.fireEvent ? AIORIG.fireEvent.apply(this, arguments) : undefined;
      try {
        if (cfg().enabled && ev && global.AILEDGER) {
          var txt = '';
          try { txt = (typeof evTextNow === 'function') ? evTextNow(ev) : (ev.t || ''); } catch (e) { txt = ev.t || ''; }
          global.AILEDGER.noteExternal({ cn: ev.cn, t: txt }, null);
        }
      } catch (e) {}
      return r;
    };

    /* ------------------------------------------------------------------ *
     * 舆论场：新标签页「舆论」
     * ------------------------------------------------------------------ */
    global.mainPane = function () {
      try {
        if (cfg().enabled && UI.tab === 'opinion' && global.AIPRESS_UI) {
          return global.AIPRESS_UI.paneHTML();
        }
      } catch (e) {}
      return AIORIG.mainPane ? AIORIG.mainPane.apply(this, arguments) : '';
    };

    global.topbar = function () {
      var html = AIORIG.topbar ? AIORIG.topbar.apply(this, arguments) : '';
      try {
        if (cfg().enabled && html.indexOf("setTab('opinion')") < 0) {
          html = html.replace('<div class="tab advance"',
            '<div class="tab ' + (UI.tab === 'opinion' ? 'on' : '') +
            '" onclick="setTab(\'opinion\')">舆论</div><div class="tab advance"');
        }
      } catch (e) {}
      return html;
    };

    global.setTab = function (t) {
      var r = AIORIG.setTab ? AIORIG.setTab.apply(this, arguments) : undefined;
      try {
        if (t === 'opinion' && cfg().enabled && global.AIPRESS_UI) global.AIPRESS_UI.afterOpen();
      } catch (e) {}
      return r;
    };

    /* 每推进一周，到点悄悄换一版舆论：已有快照才换，避免开局就烧请求 */
    var lastPressTry = 0;    global.doAdvance = function () {
      var r = AIORIG.doAdvance ? AIORIG.doAdvance.apply(this, arguments) : undefined;
      try {
        var P = global.AIPRESS;
        if (cfg().enabled && cfg().pressAuto && P && !global.AI.STAT.busy && P.current() &&
            P.stale() && (Date.now() - lastPressTry) > 20000) {
          lastPressTry = Date.now();
          P.refresh(false);
        }
      } catch (e) {}
      return r;
    };

    /* 初选阶段的原版行动区是一行按钮：换成「写一条竞选指令」，点开是完整输入台 */
    global.actionButtons = function () {
      try {
        if (!cfg().enabled) return AIORIG.actionButtons ? AIORIG.actionButtons() : '';
        var html = '<button class="btn primary sm" onclick="AIUI.openCampaign()">' +
          '✎ 写一条竞选行动（AI）</button>';
        if (cfg().showClassic && AIORIG.actionButtons) html += AIORIG.actionButtons();
        return html;
      } catch (e) { return AIORIG.actionButtons ? AIORIG.actionButtons() : ''; }
    };

    /* 竞选主面板（module 37 的新版界面）：它把表态按钮直接写在 HTML 里，
       所以这里只给那张卡的 div 加一个 ai-hide 类把它藏起来，再在后面追加自由行动台。 */
    global.campaignPane2 = function () {
      var html = AIORIG.campaignPane2 ? AIORIG.campaignPane2() : '';
      try {
        if (!cfg().enabled) return html;
        if (!cfg().showClassic) {
          html = html.replace(/<div class="card"><h3>竞选行动 /,
                              '<div class="card ai-hide"><h3>竞选行动 ');
        }
        return html + global.AIUI.campaignConsoleHTML();
      } catch (e) { return html; }
    };

    /* 顶栏加两个按钮：态势简报 / AI 设置（挂在原版齿轮旁边） */
    global.gearBtnHTML = function () {
      var base = AIORIG.gearBtnHTML ? AIORIG.gearBtnHTML() : '';
      var c = cfg();
      var on = c.enabled && c.apiKey;
      var dot = global.AI.STAT.busy ? '#d99b2b' : (on ? '#3fa66a' : '#c0393b');
      var bst = null;
      try { bst = global.AILEDGER ? global.AILEDGER.stats() : null; } catch (e) {}
      var n = bst ? (bst.actions + bst.external + bst.commitments) : 0;
      return base +
        '<button class="btn sm" onclick="AIUI.openBrief()" title="态势简报：AI 记录的最近行动、外部事件、承诺与风险" aria-label="态势简报">' +
        '态势' + (n ? '<span style="opacity:.6;font-size:10px;margin-left:2px">' + n + '</span>' : '') + '</button>' +
        '<button class="btn sm" onclick="AIUI.open()" title="AI 设置（接口 / 提示词 / 玩法）" aria-label="AI 设置">' +
        'AI<span style="color:' + dot + ';font-size:10px;vertical-align:super">●</span></button>';
    };

    /* 主设置面板（齿轮 ⚙）里加一段「AI 裁决 · 上帝模式」：这是游戏的设置页，不是 AI 设置页 */
    global.settingsPane = function () {
      var html = AIORIG.settingsPane ? AIORIG.settingsPane.apply(this, arguments) : '';
      try {
        var c = cfg();
        var on = !!c.godMode;
        var block = '<div class="setsec">' +
          '<div class="sechead">AI 裁决 · 上帝模式</div>' +
          '<p class="tiny" style="margin:2px 0 0">开启后，AI 不会把你的行动判成被否决、被拖延或只办成一半：' +
          'success 只接受「成功 / 大成功」两档，其余档位（含未执行、部分成功）整份结果直接作废、' +
          '不产生任何效果。行动点照常消耗，数值上限与预算不变。</p>' +
          '<div class="setopts">' +
          '<span class="setopt' + (on ? '' : ' on') + '" onclick="AIUI.setGodMode(false)" title="按 AI 判断的档位正常结算">关闭</span>' +
          '<span class="setopt' + (on ? ' on' : '') + '" onclick="AIUI.setGodMode(true)" title="AI 只能给成功/大成功">开启</span>' +
          '</div>' +
          '<div class="tiny" style="margin-top:6px">当前：<b>' + (on ? '已开启' : '未开启') + '</b>' +
          (c.enabled ? '' : '（AI 模式本身是关闭状态）') + '</div>' +
          '</div>';
        var anchor = '<div style="text-align:right;margin-top:16px">';
        if (html.indexOf(anchor) >= 0) html = html.replace(anchor, block + anchor);
        else html = html.replace(/<\/div><\/div>$/, block + '</div></div>');
      } catch (e) {}
      return html;
    };

    /* 提交入口挂到 AIUI 上（界面里的 onclick 用的就是它） */
    global.AIUI.submit = submit;
    global.AIUI.state.selftest = false;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */
  function boot() {
    global.AIUI.css();
    install();
    /* 自检：?selftest=1 时把诊断结果写进页面，便于无头浏览器抓取 */
    try {
      if (/[?&]selftest=1/.test(String(location.search || '')) && global.AISELFTEST) {
        global.AISELFTEST.run();
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    /* 原版在 DOMContentLoaded 里建 G 并渲染；我们排在它之后 */
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(function () { try { boot(); } catch (e) { console.error('[AI] boot', e); } }, 0);
    });
  } else {
    setTimeout(function () { try { boot(); } catch (e) { console.error('[AI] boot', e); } }, 0);
  }

  global.AIHOOKS = { install: install, boot: boot, AIORIG: AIORIG, submit: submit, maintain: maintain };
})(window);
