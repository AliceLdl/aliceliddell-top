/* ============================================================================
   ai-adjudicate.js — 校验 / 限幅 / 结算 / 离线兜底
   《总统模拟器 · AI 版》扩展层第 5 块
   ----------------------------------------------------------------------------
   模型给出的数字不能直接进引擎：这里做四道关。
     1) 字段白名单 + 类型校验（不认识的一律丢弃，绝不把字符串写进经济引擎）
     2) 分项硬上限（与提示词里的区间一致，再乘「严格度」倍率）
     3) 执行档位折算：成败由模型返回的 success 档位决定（none / fail / partial /
     success / triumph），按档位乘固定系数 —— 引擎不再掷骰子，同一档位永远是
     同一个结果，玩家的成败只来自 AI 的判定
     4) 总量预算：一条指令能造成的影响总和有上限，超了按比例缩
   最后调用原版引擎的 applyFx / applyCampFx / makeCustomBill，
   让效果照常进入「经济冲量队列」「州级情绪」「法案排期」等机制。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 上限表（标准难度；乘以 AICFG.strict）
   * ------------------------------------------------------------------ */
  var CAP = {
    appr: 6, gdp: 0.30, unemp: 0.30, infl: 0.20, conf: 6, sp: 6,
    deficit: 0.30, debt: 0.20, tension: 12, div: 5, pc: 8,
    rel: 15, corp: 10
  };

  /* 每条指令允许的「影响总量」（加权和，1.0 ≈ 一次像样的行动） */
  var BUDGET_BASE = 3.2, BUDGET_PER_AP = 2.0;

  /* ------------------------------------------------------------------ *
   * 执行档位（取代原来的 ok:true/false + 随机成功判定）
   *   none     未执行：指令越权/不可能/无效 —— 不扣行动点，不改任何数值
   *   fail     执行失败：做了，砸了 —— 照扣行动点，正效果 ×0.35、负效果 ×1.10
   *   partial  部分成功 —— 正效果 ×0.70，负效果照旧
   *   success  成功 —— 原样结算
   *   triumph  大成功 —— 正效果 ×1.15，负效果 ×0.85
   * 系数是确定性的：同一档位 + 同一模型输出 = 同一结果，不存在引擎掷骰子。
   * ------------------------------------------------------------------ */
  var GRADES = [
    { id: 'none',    idx: 0, cn: '未执行', pos: 0,    neg: 0,    ok: false,
      tags: ['none', 'not_executed', 'notexecuted', 'reject', 'rejected', 'skipped', 'none_executed', '未执行', '没执行', '拒绝', '无效'] },
    { id: 'fail',    idx: 1, cn: '执行失败',   pos: 0.35, neg: 1.10, ok: true,
      tags: ['fail', 'failed', 'failure', 'lose', 'loss', '失败', '执行失败', '翻车'] },
    { id: 'partial', idx: 2, cn: '部分成功',   pos: 0.70, neg: 1.00, ok: true,
      tags: ['partial', 'partly', 'half', 'mixed', '部分成功', '部分', '打了折扣'] },
    { id: 'success', idx: 3, cn: '成功',       pos: 1.00, neg: 1.00, ok: true,
      tags: ['success', 'succeed', 'ok', 'done', 'yes', '成功', '达成'] },
    { id: 'triumph', idx: 4, cn: '大成功',     pos: 1.15, neg: 0.85, ok: true,
      tags: ['triumph', 'great', 'perfect', 'outstanding', '很好', '大成功', '超预期'] }
  ];
  var GRADE_BY_ID = {};
  GRADES.forEach(function (g) { GRADE_BY_ID[g.id] = g; });

  function gradeOf(id) { return GRADE_BY_ID[id] || GRADE_BY_ID.success; }

  /* ------------------------------------------------------------------ *
   * 行动公开性 visibility
   *   密谈 / 内部 / 公开 / 高调 四档，只决定「民意类」效果要不要打折：
   *   私下谈成的交易照样改变关系与政治资本，但不会当天上头条。
   *   pub     → approval / confidence / stock / 社会撕裂 的系数
   *   tension → 全球紧张度（走漏之前只有情报圈知道，所以略打折）
   * ------------------------------------------------------------------ */
  var VIS = [
    { id: 'secret',  cn: '密谈', pub: 0.15, tension: 0.60,
      tags: ['secret', 'covert', 'hidden', 'quiet', '密谈', '秘密', '私下', '未公开', '不公开', '暗中'] },
    { id: 'private', cn: '内部', pub: 0.45, tension: 0.80,
      tags: ['private', 'internal', 'closed', '内部', '闭门', '半公开', '小范围', '仅通知'] },
    { id: 'open',    cn: '公开', pub: 1.00, tension: 1.00,
      tags: ['open', 'public', 'normal', '公开', '常规', '正常', '例行'] },
    { id: 'loud',    cn: '高调', pub: 1.25, tension: 1.10,
      tags: ['loud', 'high', 'broadcast', 'nationwide', '高调', '大张旗鼓', '全国直播', '公开宣讲'] }
  ];
  var VIS_BY_ID = {};
  VIS.forEach(function (v) { VIS_BY_ID[v.id] = v; });
  function visOf(id) { return VIS_BY_ID[id] || VIS_BY_ID.open; }

  /* 没给 / 给了不认识的值 → 按「公开」处理（公开性只是补充信息，不该让整份结果作废） */
  function parseVisibility(raw) {
    if (!raw || typeof raw !== 'object') return 'open';
    var v = raw.visibility;
    if (v == null) v = raw['公开性'];
    if (v == null) v = raw.visibilityLevel;
    if (v == null) v = raw.publicity;
    if (v == null) return 'open';
    if (typeof v === 'number') {
      var i = Math.round(Math.max(0, Math.min(VIS.length - 1, v)));
      return VIS[i].id;
    }
    if (typeof v === 'boolean') return v ? 'open' : 'secret';
    var s = String(v).trim().toLowerCase().replace(/[\s_\-]+/g, '');
    if (!s) return 'open';
    for (var k = 0; k < VIS.length; k++) {
      for (var j = 0; j < VIS[k].tags.length; j++) {
        if (s === String(VIS[k].tags[j]).toLowerCase().replace(/[\s_\-]+/g, '')) return VIS[k].id;
      }
    }
    if (/秘密|私下|暗中|secret|covert|hidden|quiet/.test(s)) return 'secret';
    if (/内部|闭门|小范围|internal|closed|private/.test(s)) return 'private';
    if (/高调|大张旗鼓|全国直播|loud|nationwide|broadcast/.test(s)) return 'loud';
    return 'open';
  }

  var CN = {
    appr: '支持率', gdp: '经济增长', unemp: '失业率', infl: '通胀', conf: '信心',
    sp: '股市', deficit: '赤字', debt: '债务', tension: '全球紧张度', div: '社会撕裂',
    pc: '政治资本'
  };

  function num(v, fb) { return global.AI.num(v, fb); }
  function round(v, d) { return global.AI.round(v, d); }
  function cfg() { return global.AICFG || {}; }
  function strict() { return (cfg().strict != null ? cfg().strict : 1); }

  function countryIds() {
    var out = {};
    try { global.AIG.countries().forEach(function (c) { out[c.id] = c.cn; }); } catch (e) {}
    return out;
  }
  function sectorIds() {
    var out = {};
    try { global.AIG.sectors().forEach(function (s) { out[s.id] = s.cn; }); } catch (e) {}
    return out;
  }
  var BILL_TOPICS = ['经济税收', '医疗', '气候能源', '外交国防', '财政赤字', '移民',
                     '劳工', '科技监管', '教育', '金融监管', '住房', '联邦制'];

  /* ------------------------------------------------------------------ *
   * 文本清洗
   * ------------------------------------------------------------------ */
  function cleanText(s, max) {
    var t = String(s == null ? '' : s)
      .replace(/<[^>]*>/g, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (max && t.length > max) t = t.slice(0, max);
    return t;
  }

  function clampField(v, cap) {
    var n = num(v, 0);
    var c = cap * strict();
    if (n > c) n = c;
    if (n < -c) n = -c;
    return n;
  }

  /* ------------------------------------------------------------------ *
   * 4. 执行档位解析（替代原来的随机成功判定）+ 随机扰动
   * ------------------------------------------------------------------ */
  /* 模型返回的档位写法：数字、布尔、英文/中文档名都收；
     识别不出来（没给、给空、给了别的词）一律返回 null —— 调用方据此直接作废这份结果。 */
  function parseGrade(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var v = raw.success;
    if (v == null) v = raw['结果'];
    if (v == null) v = raw.grade;
    if (v == null) v = raw.result;
    if (v == null || v === '') return null;

    if (typeof v === 'boolean') return v ? 'success' : 'none';
    if (typeof v === 'number') {
      if (!isFinite(v)) return null;
      var i = Math.round(Math.max(0, Math.min(GRADES.length - 1, v)));
      return GRADES[i].id;
    }
    var s = String(v).trim().toLowerCase()
      .replace(/[\s_\-]+/g, '').replace(/["'「」【】]/g, '');
    if (!s) return null;
    for (var k = 0; k < GRADES.length; k++) {
      var g = GRADES[k];
      for (var j = 0; j < g.tags.length; j++) {
        var t = String(g.tags[j]).toLowerCase().replace(/[\s_\-]+/g, '');
        if (s === t) return g.id;
      }
    }
    /* 包含关系兜底：「部分成功（但代价很大）」也能认出来 */
    if (/未执行|没执行|拒绝|refus|reject|notexecut|^none/.test(s)) return 'none';
    if (/部分|partial|partly|一半/.test(s)) return 'partial';
    if (/大成功|超预期|triumph|great|perfect/.test(s)) return 'triumph';
    if (/失败|fail|翻车/.test(s)) return 'fail';
    return null;
  }

  /* 当前配置下允许的档位：上帝模式只认「成功 / 大成功」 */
  function allowedGrades(god) {
    return god ? ['success', 'triumph']
               : ['none', 'fail', 'partial', 'success', 'triumph'];
  }

  function jitter(v) {
    if (!cfg().variance) return v;
    return v * (0.78 + Math.random() * 0.44);   /* ±22% */
  }

  /* 按档位折算一个数值。
     注意「正/负效果」指对总统有利还是有害，不看数字正负：
     失业率 +0.3 是坏事，紧张度 -5 才是好事。 */
  var UP_IS_BAD = {
    unemp: 1, infl: 1, debt: 1, tension: 1, div: 1, def: 1, deficit: 1, scandalHeat: 1
  };
  function gradeScale(v, g, upIsBad) {
    var n = num(v, 0);
    if (!n) return 0;
    var good = upIsBad ? n < 0 : n > 0;
    return n * (good ? g.pos : g.neg);
  }

  /* ------------------------------------------------------------------ *
   * 归一化：把模型的 JSON 变成引擎可用的结构
   * ------------------------------------------------------------------ */
  function normalize(raw, mode, ctx) {
    var out = {
      ok: true, success: 'success', grade: 3, gradeCN: '成功',
      headline: '', narrative: '', apCost: 0, difficulty: 0.4,
      risk: 'low', tone: '', followup: '', rejectReason: '',
      fx: {}, div: 0, def: 0, rel: {}, corp: {}, bill: null, flags: [],
      campaign: null, notes: [], ledger: null, raw: raw
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.ok = false; out.invalid = 'not_object';
      out.success = 'none'; out.grade = 0; out.gradeCN = '未执行';
      out.rejectReason = '模型返回的不是一个对象，本次结果作废。';
      return out;
    }

    /* --- 档位严格校验：模型必须给出合法 success，否则整份结果作废（不落任何数值）。
           上帝模式下只接受「成功 / 大成功」，其余（含部分成功）一律作废。 --- */
    var godNow = !!cfg().godMode;
    var parsed = parseGrade(raw);
    var allow = allowedGrades(godNow);
    if (parsed == null || allow.indexOf(parsed) < 0) {
      out.ok = false;
      out.invalid = (parsed == null) ? 'missing' : 'god_rejected';
      out.success = 'none'; out.grade = 0; out.gradeCN = '未执行';
      out.rejectReason = parsed == null
        ? '模型没有返回合法的 success 档位，本次结果作废。'
        : (godNow
            ? '上帝模式只接受「成功 / 大成功」，模型返回了「' + gradeOf(parsed).cn + '」，本次结果作废。'
            : '无法识别的 success 档位「' + cleanText(raw.success, 20) + '」，本次结果作废。');
      out.notes.push(out.rejectReason);
      return out;
    }

    var grade = gradeOf(parsed);
    out.success = grade.id;
    out.grade = grade.idx;
    out.gradeCN = grade.cn;
    out.ok = grade.ok;

    var vis = visOf(parseVisibility(raw));
    out.visibility = vis.id;
    out.visibilityCN = vis.cn;

    out.headline = cleanText(raw.headline, 40);
    out.narrative = cleanText(raw.narrative, 700);
    out.followup = cleanText(raw.followup, 120);
    out.rejectReason = cleanText(raw.rejectReason, 200);
    out.tone = cleanText(raw.tone, 8);
    out.risk = ['low', 'medium', 'high'].indexOf(raw.risk) >= 0 ? raw.risk : 'low';
    out.apCost = Math.round(Math.max(0, Math.min(3, num(raw.apCost, mode === 'national' ? 1 : 1))));
    out.difficulty = Math.max(0, Math.min(1, num(raw.difficulty, 0.4)));

    var eff = (raw.effects && typeof raw.effects === 'object') ? raw.effects : {};

    /* --- 直接映射的字段 --- */
    var map = {
      approval: 'appr', gdp: 'gdp', unemployment: 'unemp', inflation: 'infl',
      confidence: 'conf', stock: 'sp', debt: 'debt', tension: 'tension',
      politicalCapital: 'pc'
    };
    for (var ek in map) {
      if (eff[ek] == null) continue;
      var fk = map[ek];
      var v = num(eff[ek]);
      if (!v) continue;
      out.fx[fk] = clampField(v, CAP[fk]);
    }
    /* --- 单独处理的字段 --- */
    if (eff.deficit != null) out.def = clampField(eff.deficit, CAP.deficit);
    if (eff.division != null) out.div = clampField(eff.division, CAP.div);

    /* --- relations --- */
    var cids = countryIds();
    var srcRel = eff.relations || raw.relations || null;
    if (srcRel && typeof srcRel === 'object') {
      for (var rid in srcRel) {
        var key = String(rid).toUpperCase();
        if (!cids[key]) {
          /* 允许用中文国名 */
          for (var cid in cids) if (cids[cid] === rid) { key = cid; break; }
        }
        if (!cids[key]) { out.notes.push('忽略未知国家：' + rid); continue; }
        var rv = clampField(srcRel[rid], CAP.rel);
        if (rv) out.rel[key] = (out.rel[key] || 0) + rv;
      }
    }

    /* --- sectors --- */
    var sids = sectorIds();
    var srcSec = eff.sectors || raw.sectors || null;
    if (srcSec && typeof srcSec === 'object') {
      for (var sid in srcSec) {
        var sk = String(sid);
        if (!sids[sk]) {
          for (var k2 in sids) if (sids[k2] === sid) { sk = k2; break; }
        }
        if (!sids[sk]) { out.notes.push('忽略未知行业：' + sid); continue; }
        var sv = clampField(srcSec[sid], CAP.corp);
        if (sv) out.corp[sk] = (out.corp[sk] || 0) + sv;
      }
    }

    /* --- 法案 --- */
    var b = raw.bill;
    if (b && typeof b === 'object' && b.title) {
      var topic = cleanText(b.topic, 12);
      if (BILL_TOPICS.indexOf(topic) < 0) topic = '经济税收';
      out.bill = {
        title: cleanText(b.title, 26),
        topic: topic,
        dir: Math.round(Math.max(-10, Math.min(10, num(b.direction, 0)))),
        summary: cleanText(b.summary, 60)
      };
    }

    /* --- 标记 --- */
    if (Array.isArray(raw.flags)) {
      raw.flags.slice(0, 6).forEach(function (f) {
        var s = String(f || '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32);
        if (s && s !== '__') out.flags.push('ai_' + s);
      });
    }

    /* --- 竞选数值 --- */
    if (raw.campaign && typeof raw.campaign === 'object') {
      var c = raw.campaign;
      out.campaign = {
        momentum: clampField(c.momentum, 0.3),
        funds: clampField(c.funds, 40),
        energy: clampField(c.energy, 25),
        stats: {},
        visits: {},
        stateLift: {}
      };
      var STAT_CAP = { nameRec: 3, enthusiasm: 3, groundGame: 3, adSpend: 25,
                       endorseScore: 3, debateScore: 2, scandalHeat: 8, oppoStock: 2 };
      var st = c.stats || {};
      for (var sk2 in STAT_CAP) {
        if (st[sk2] == null) continue;
        var sv2 = num(st[sk2]);
        if (sv2) out.campaign.stats[sk2] = clampField(sv2, STAT_CAP[sk2]);
      }
      var validState = {};
      try { global.AIG.states().forEach(function (s) { validState[s.id] = 1; }); } catch (e) {}
      if (c.visits && typeof c.visits === 'object') {
        for (var vk in c.visits) {
          if (!validState[vk]) continue;
          var vv = clampField(c.visits[vk], 4);
          if (vv) out.campaign.visits[vk] = vv;
        }
      }
      if (c.stateLift && typeof c.stateLift === 'object') {
        for (var lk in c.stateLift) {
          if (!validState[lk]) continue;
          var lv = clampField(c.stateLift[lk], 2.5);
          if (lv) out.campaign.stateLift[lk] = lv;
        }
      }
    }

    if (!out.headline) out.headline = out.narrative ? out.narrative.slice(0, 18) : (out.ok ? '既定行动' : '指令未能执行');
    if (out.ok && !out.narrative) {
      out.narrative = '白宫就「' + out.headline + '」发布了简短的执行说明，具体效果将在接下来的几周里显现。';
    }

    /* --- 叙事账本（增量）：原样保留，交给 AILEDGER 校验与落账 --- */
    if (raw.ledger && typeof raw.ledger === 'object') {
      out.ledger = raw.ledger;
    } else if (raw['账本'] && typeof raw['账本'] === 'object') {
      out.ledger = raw['账本'];
    }

    /* 拒绝时不保留任何数值 */
    if (!out.ok) {
      out.fx = {}; out.div = 0; out.def = 0; out.rel = {}; out.corp = {};
      out.bill = null; out.campaign = null; out.flags = []; out.apCost = 0;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 档位折算与总量预算（在 normalize 之后、apply 之前）
   * ------------------------------------------------------------------ */
  function gate(norm) {
    if (!norm.ok) return norm;
    var g = gradeOf(norm.success);

    /* 1) 抖动 */
    var k;
    for (k in norm.fx) norm.fx[k] = jitter(norm.fx[k]);
    norm.div = jitter(norm.div);
    norm.def = jitter(norm.def);
    for (k in norm.rel) norm.rel[k] = jitter(norm.rel[k]);
    for (k in norm.corp) norm.corp[k] = jitter(norm.corp[k]);
    if (norm.campaign) {
      norm.campaign.momentum = jitter(norm.campaign.momentum);
      norm.campaign.funds = jitter(norm.campaign.funds);
      norm.campaign.energy = jitter(norm.campaign.energy);
      for (k in norm.campaign.stats) norm.campaign.stats[k] = jitter(norm.campaign.stats[k]);
      for (k in norm.campaign.visits) norm.campaign.visits[k] = jitter(norm.campaign.visits[k]);
      for (k in norm.campaign.stateLift) norm.campaign.stateLift[k] = jitter(norm.campaign.stateLift[k]);
    }

    /* 2) 档位折算：确定性，不再掷骰子 —— 成功/失败只由模型返回的 success 决定 */
    norm.success = g.id;
    norm.grade = g.idx;
    norm.gradeCN = g.cn;
    if (g.pos !== 1 || g.neg !== 1) {
      for (k in norm.fx) norm.fx[k] = gradeScale(norm.fx[k], g, UP_IS_BAD[k]);
      for (k in norm.rel) norm.rel[k] = gradeScale(norm.rel[k], g, 0);
      for (k in norm.corp) norm.corp[k] = gradeScale(norm.corp[k], g, 0);
      norm.div = gradeScale(norm.div, g, 1);
      norm.def = gradeScale(norm.def, g, 1);
      if (norm.campaign) {
        norm.campaign.momentum = gradeScale(norm.campaign.momentum, g, 0);
        norm.campaign.funds = gradeScale(norm.campaign.funds, g, 0);
        norm.campaign.energy = gradeScale(norm.campaign.energy, g, 0);
        for (k in norm.campaign.stats) {
          if (k === 'adSpend') continue;                 /* 花出去的钱不打折 */
          norm.campaign.stats[k] = gradeScale(norm.campaign.stats[k], g, UP_IS_BAD[k]);
        }
        for (k in norm.campaign.visits) {
          norm.campaign.visits[k] = Math.max(0, gradeScale(norm.campaign.visits[k], g, 0));
        }
        for (k in norm.campaign.stateLift) {
          norm.campaign.stateLift[k] = gradeScale(norm.campaign.stateLift[k], g, 0);
        }
      }
      norm.notes.push('结算档位：' + g.cn + '（有利效果 ×' + g.pos + '，不利效果 ×' + g.neg + '）');
      norm.stumble = (g.id === 'fail');
    }

    /* 2.5) 公开度：只有「民意类」通道随公开度打折/放大。
       密谈能谈成事（关系、行业、政治资本照旧），但不会当天上头条。 */
    var visNow = visOf(norm.visibility);
    norm.visibility = visNow.id;
    norm.visibilityCN = visNow.cn;
    if (visNow.pub !== 1 || visNow.tension !== 1) {
      ['appr', 'conf', 'sp'].forEach(function (fk) {
        if (norm.fx[fk]) norm.fx[fk] *= visNow.pub;
      });
      if (norm.fx.tension) norm.fx.tension *= visNow.tension;
      norm.div *= visNow.pub;
      norm.notes.push('公开度：' + visNow.cn + '（民意类效果 ×' + visNow.pub + '）');
    }

    /* 3) 总量预算 */
    var w = 0;
    w += Math.abs(norm.fx.appr || 0) / CAP.appr;
    w += Math.abs(norm.fx.gdp || 0) / CAP.gdp;
    w += Math.abs(norm.fx.unemp || 0) / CAP.unemp;
    w += Math.abs(norm.fx.infl || 0) / CAP.infl;
    w += Math.abs(norm.fx.conf || 0) / CAP.conf;
    w += Math.abs(norm.fx.sp || 0) / CAP.sp;
    w += Math.abs(norm.fx.debt || 0) / CAP.debt;
    w += Math.abs(norm.fx.pc || 0) / CAP.pc;
    w += Math.abs(norm.fx.tension || 0) / CAP.tension;
    w += Math.abs(norm.div) / CAP.div;
    w += Math.abs(norm.def) / CAP.deficit;
    for (k in norm.rel) w += Math.abs(norm.rel[k]) / CAP.rel;
    for (k in norm.corp) w += Math.abs(norm.corp[k]) / CAP.corp;

    var budget = BUDGET_BASE + BUDGET_PER_AP * (norm.apCost || 0);
    if (w > budget && w > 0) {
      var scale = budget / w;
      norm.notes.push('影响总量超预算，按 ' + round(scale * 100, 0) + '% 缩放');
      for (k in norm.fx) norm.fx[k] *= scale;
      norm.div *= scale;
      norm.def *= scale;
      for (k in norm.rel) norm.rel[k] *= scale;
      for (k in norm.corp) norm.corp[k] *= scale;
    }

    /* 4) 最终再夹一次硬上限（抖动与缩放都可能把值推出区间） */
    function reclamp(o, key, cap) {
      if (o[key] == null) return;
      var c = cap * strict();
      if (o[key] > c) o[key] = c;
      if (o[key] < -c) o[key] = -c;
    }
    for (k in norm.fx) {
      var capKey = ({ appr: 'appr', gdp: 'gdp', unemp: 'unemp', infl: 'infl', conf: 'conf',
                      sp: 'sp', debt: 'debt', tension: 'tension', pc: 'pc' })[k];
      if (capKey) reclamp(norm.fx, k, CAP[capKey]);
    }
    reclamp(norm, 'div', CAP.div);
    reclamp(norm, 'def', CAP.deficit);
    for (k in norm.rel) reclamp(norm.rel, k, CAP.rel);
    for (k in norm.corp) reclamp(norm.corp, k, CAP.corp);

    /* 5) 最终取整与兜底 */
    norm.div = Math.round(norm.div * 100) / 100;
    norm.def = Math.round(norm.def * 1000) / 1000;
    for (k in norm.fx) norm.fx[k] = Math.round(norm.fx[k] * 1000) / 1000;
    for (k in norm.rel) norm.rel[k] = Math.round(norm.rel[k] * 10) / 10;
    for (k in norm.corp) norm.corp[k] = Math.round(norm.corp[k] * 10) / 10;
    return norm;
  }

  /* ------------------------------------------------------------------ *
   * 结算
   * ------------------------------------------------------------------ */
  function chipsOf(norm) {
    var out = [];
    if (!norm) return out;
    function add(label, v, unit, d) {
      var val = round(v, d == null ? 1 : d);
      if (!val) return;
      out.push({ label: label, v: val, unit: unit || '', pos: val > 0 });
    }
    add('支持率', norm.fx.appr, '%');
    add('增长', norm.fx.gdp, '%', 2);
    add('失业', norm.fx.unemp, '%', 2);
    add('通胀', norm.fx.infl, '%', 2);
    add('信心', norm.fx.conf, '', 0);
    add('股市', norm.fx.sp, '%', 1);
    add('赤字', norm.def, 'pt', 2);
    add('债务', norm.fx.debt, '', 2);
    add('紧张度', norm.fx.tension, '', 1);
    add('撕裂', norm.div, '', 1);
    add('政治资本', norm.fx.pc, '', 1);
    var cids = countryIds();
    for (var k in norm.rel) add((cids[k] || k) + '关系', norm.rel[k], '', 1);
    var sids = sectorIds();
    for (var s in norm.corp) add((sids[s] || s) + '好感', norm.corp[s], '', 1);
    if (norm.campaign) {
      add('势头', norm.campaign.momentum, '', 2);
      add('竞选资金', norm.campaign.funds, 'M', 0);
      add('体力', norm.campaign.energy, '', 0);
      var stCN = { nameRec: '知名度', enthusiasm: '热情', groundGame: '地面组织',
                   adSpend: '广告投放', endorseScore: '背书', debateScore: '辩论评价',
                   scandalHeat: '丑闻热度', oppoStock: '对手弱点' };
      for (var st in norm.campaign.stats) add(stCN[st] || st, norm.campaign.stats[st], '', 1);
      for (var v in norm.campaign.visits) add('州投入 ' + v, norm.campaign.visits[v], '', 1);
      for (var l in norm.campaign.stateLift) add('州情绪 ' + l, norm.campaign.stateLift[l], '', 1);
    }
    return out;
  }

  function apply(norm, mode, meta) {
    meta = meta || {};
    var g = global.AIG.g();
    var summary = {
      ok: !!(norm && norm.ok), headline: norm ? norm.headline : '',
      success: norm ? (norm.success || 'success') : 'none',
      grade: norm ? (norm.grade == null ? 3 : norm.grade) : 0,
      gradeCN: norm ? (norm.gradeCN || '成功') : '未执行',
      visibility: norm ? (norm.visibility || 'open') : 'open',
      visibilityCN: norm ? (norm.visibilityCN || '公开') : '公开',
      narrative: norm ? norm.narrative : '', apCost: norm ? norm.apCost : 0,
      risk: norm ? norm.risk : 'low', tone: norm ? norm.tone : '',
      followup: norm ? norm.followup : '', rejectReason: norm ? norm.rejectReason : '',
      chips: [], notes: norm ? (norm.notes || []) : [], stumble: !!(norm && norm.stumble),
      bill: null, mode: mode, source: meta.source || 'ai'
    };
    if (!norm) return summary;

    if (!norm.ok) {
      if (typeof global.log === 'function') {
        global.log('【未执行】' + (norm.rejectReason || '这一指令在现实政治中不成立。'), 'bad');
      }
      /* 拒绝也留一笔：只写内部档案（玩家不该在简报里看到"你试图越权"） */
      if (global.AILEDGER && norm.ledger && norm.ledger.dossier) {
        try {
          global.AILEDGER.applyDelta({ dossier: norm.ledger.dossier },
            { mode: 'reject', headline: norm.headline || '越权尝试', input: meta.input });
        } catch (e) {}
      }
      AI_SINK(summary, norm, meta);
      return summary;
    }

    /* --- 行动点 --- */
    var ap = Math.max(0, Math.min(3, norm.apCost || 0));
    if (g && ap > 0) {
      var canPay = Math.min(ap, Math.max(0, g.ap || 0));
      g.ap = Math.max(0, (g.ap || 0) - canPay);
      if (canPay < ap) {
        summary.notes.push('行动点不足，仅扣除 ' + canPay + ' 点');
        norm.notes.push('行动点不足');
      }
    }

    /* --- 主效果：交给原版 applyFx（经济进冲量队列、关系、行业、紧张度、政治资本） --- */
    var fx = {};
    for (var k in norm.fx) fx[k] = norm.fx[k];
    if (Object.keys(norm.rel).length) fx.rel = norm.rel;
    if (Object.keys(norm.corp).length) fx.corp = norm.corp;
    if (norm.flags && norm.flags.length) {
      try {
        (g.flags = g.flags || {});
        norm.flags.forEach(function (f) { g.flags[f] = 1; });
      } catch (e) {}
    }
    if (Object.keys(fx).length) {
      try {
        global.applyFx(fx, {
          speed: meta.speed || 'policy',
          src: norm.headline || '总统行动',
          econNote: '由总统指令触发的政策冲击，分周释放'
        });
      } catch (e) {
        summary.notes.push('applyFx 失败：' + e.message);
      }
    }

    /* --- applyFx 不管的两项 --- */
    try {
      if (norm.div) g.div = Math.max(0, Math.min(100, (g.div || 0) + norm.div));
      if (norm.def) g.econ.def = Math.max(0, Math.min(30, (g.econ.def || 0) + norm.def));
    } catch (e) {}

    /* --- 竞选数值 --- */
    if (norm.campaign) {
      try {
        var c = global.ensureCamp ? global.ensureCamp() : (g.campaign = g.campaign || { funds: 40, energy: 100, momentum: 1, visits: {} });
        if (norm.campaign.funds) c.funds = Math.max(0, (c.funds || 0) + norm.campaign.funds);
        if (norm.campaign.energy) c.energy = Math.max(0, Math.min(100, (c.energy == null ? 100 : c.energy) + norm.campaign.energy));
        if (norm.campaign.momentum) c.momentum = Math.max(0.2, (c.momentum || 1) + norm.campaign.momentum);
        if (Object.keys(norm.campaign.stats).length && global.campStatAdd) {
          global.campStatAdd(norm.campaign.stats);
          if (norm.campaign.stats.adSpend) c._adWeek = (c._adWeek || 0) + norm.campaign.stats.adSpend;
        }
        c.visits = c.visits || {};
        for (var vk in norm.campaign.visits) {
          c.visits[vk] = (c.visits[vk] || 0) + norm.campaign.visits[vk];
        }
        for (var lk in norm.campaign.stateLift) {
          if (global.stateLift) global.stateLift(lk, 0, 0, norm.campaign.stateLift[lk]);
        }
      } catch (e) { summary.notes.push('竞选结算失败：' + e.message); }
    }

    /* --- 法案：进「起草中」队列，由原版 billScheduler 推进 --- */
    if (norm.bill && g) {
      try {
        var bill = global.makeCustomBill({
          name: norm.bill.title,
          topics: [norm.bill.topic],
          dir: norm.bill.dir,
          spend: 1,
          desc: norm.bill.summary || ('由总统指示起草，聚焦' + norm.bill.topic + '。')
        });
        g.drafts = g.drafts || [];
        g.drafts.push({ bill: bill, w: 1, sponsor: '总统' });
        summary.bill = bill.cn;
        if (typeof global.log === 'function') {
          global.log('【起草】按你的指示，《' + bill.cn + '》进入起草程序，约 1~2 周后提交国会审议。', 'hi');
        }
      } catch (e) { summary.notes.push('法案创建失败：' + e.message); }
    }

    summary.chips = chipsOf(norm);

    /* --- 叙事账本：把这次行动/事件写进双层记忆 --- */
    summary.ledger = { added: 0 };
    if (global.AILEDGER) {
      try {
        summary.ledger = global.AILEDGER.applyDelta(norm.ledger, {
          mode: mode, headline: norm.headline, input: meta.input
        }) || { added: 0 };
      } catch (e) { summary.notes.push('账本写入失败：' + e.message); }
    }

    /* --- 叙事入日志 --- */
    try {
      var cls = summary.stumble ? 'bad' : (norm.risk === 'high' ? 'hi' : 'good');
      if (typeof global.log === 'function') {
        global.log('【' + norm.headline + '】' + norm.narrative, cls);
      }
    } catch (e) {}

    /* --- 档案 --- */
    try {
      g.aiLog = g.aiLog || [];
      g.aiLog.push({
        y: g.y, w: g.w, mode: mode, input: String(meta.input || '').slice(0, 200),
        headline: norm.headline, narrative: norm.narrative, apCost: ap,
        ok: true, success: norm.success, gradeCN: norm.gradeCN,
        visibility: norm.visibility, visibilityCN: norm.visibilityCN,
        source: summary.source, provider: (cfg().provider || ''),
        model: (cfg().model || ''), at: global.AI.nowText(),
        chips: summary.chips
      });
      if (g.aiLog.length > 80) g.aiLog.shift();
    } catch (e) {}

    AI_SINK(summary, norm, meta);
    return summary;
  }

  /* 统一记录到 UI 状态与请求历史 */
  function AI_SINK(summary, norm, meta) {
    try {
      global.AI.STAT.lastApplied = summary;
      global.AI.pushHistory({
        at: global.AI.nowText(), mode: summary.mode, source: summary.source,
        input: String((meta && meta.input) || '').slice(0, 160),
        ok: summary.ok, headline: summary.headline,
        apCost: summary.apCost, chips: summary.chips,
        notes: summary.notes
      });
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 离线兜底：关键字规则（原版数值口径的近似复刻）
   * ------------------------------------------------------------------ */
  var RULES = [
    { re: /电视讲话|全国讲话|发表讲话|讲话|声明|演说/, ap: 1, fx: { appr: 1.2, conf: 1 }, tone: '象征性',
      txt: function () { return '你在椭圆形办公室发表讲话，三大电视网同时直播。评论员认为信息清晰，但反对党指其"没有实质内容"。'; } },
    { re: /国会|游说|拉票|党团|议员|法案|推动立法/, ap: 2, fx: { appr: -0.4, conf: 1 }, tone: '交易',
      txt: function () { return '你与关键议员逐一通话，议场走廊里都在谈你的电话。法案的表决时间表被重新安排。'; } },
    { re: /行政令|签署命令|绕开国会|直接下令/, ap: 1, fx: { appr: -0.6, div: 1.0 }, tone: '强硬',
      txt: function () { return '你签署行政令，联邦机构当日收到执行指引。反对党宣布将提起诉讼，称你绕过了国会。'; } },
    { re: /制裁|禁运|断供|驱逐外交官|加征关税|关税/, ap: 2, fx: { appr: 1.2, tension: 5, conf: -1 }, rel: { CN: -14 }, tone: '强硬',
      txt: function () { return '财政部与国务院同步公布制裁清单，对方召见美国大使抗议。市场担心供应链受扰。'; } },
    { re: /军事|空袭|打击|部署|航母|部队|开战/, ap: 3, fx: { appr: 2.5, tension: 10, sp: -2, div: 2 }, rel: { IR: -12 }, tone: '强硬',
      txt: function () { return '五角大楼确认部队进入预定位置，打击行动在夜间完成。国会两党领袖要求你到会说明。'; } },
    { re: /外交|会晤|通话|访问.*(国|总统|总理)|谈判|条约/, ap: 1, fx: { tension: -2, appr: 0.5 }, rel: { GB: 6 }, tone: '妥协',
      txt: function () { return '你与对方领导人进行了长时间通话，双方同意重启工作组。联合声明措辞经过反复推敲。'; } },
    { re: /刺激|基建|投资|拨款|补贴|救助/, ap: 2, fx: { gdp: 0.3, unemp: -0.1, appr: 1.5, conf: 2 }, def: 0.35, tone: '交易',
      txt: function () { return '白宫公布一揽子支出计划，资金分批拨付。州长们表示欢迎，财政鹰派警告赤字。'; } },
    { re: /紧缩|削减|减支|裁减|平衡预算/, ap: 2, fx: { gdp: -0.2, unemp: 0.1, appr: -1 }, def: -0.45, tone: '程序性',
      txt: function () { return '管理与预算办公室下发削减指引，各机构开始重排项目优先级。工会与地方官员公开反对。'; } },
    { re: /特赦|减刑|赦免/, ap: 1, fx: { div: 1, appr: 0.5 }, tone: '象征性',
      txt: function () { return '你签署特赦令。支持者称之为司法纠错，反对者认为你在讨好特定选民。'; } },
    { re: /医保|医疗|药价|处方药/, ap: 2, fx: { appr: 1.6, div: 0.6 }, corp: { pharma: -8, insur: -4 }, tone: '强硬',
      txt: function () { return '卫生部公布新的支付规则，制药与保险行业当天股价下挫，患者团体表示欢迎。'; } },
    { re: /移民|边境|遣返|庇护/, ap: 2, fx: { div: 2.5, appr: 0.8 }, tone: '强硬',
      txt: function () { return '国土安全部调整边境执法指引，边境州的州长反应分裂，人权组织准备起诉。'; } },
    { re: /能源|气候|石油|管道|环保/, ap: 2, fx: { appr: 0.8, conf: 1 }, corp: { energy: -6, agri: 3 }, tone: '程序性',
      txt: function () { return '内政部发布新的许可规则，能源行业警告投资外流，环保团体称力度不够。'; } },
    { re: /调查|起诉|司法|检察官|弹劾/, ap: 1, fx: { div: 2, appr: -1 }, tone: '程序性',
      txt: function () { return '司法部宣布启动调查，国会相关委员会要求调阅文件。法律程序将拖上数月。'; } },
    { re: /提名|任命|大法官|法官|内阁/, ap: 2, fx: { div: 1.2 }, tone: '交易',
      txt: function () { return '你公布提名人选，参议院司法委员会排定听证日程，两党已开始准备攻防。'; } },
    { re: /访问|视察|走访|前往|灾区|州长/, ap: 1, fx: { appr: 0.9, conf: 1 }, tone: '象征性',
      txt: function () { return '你抵达当地，与州长和救援人员一同出现在镜头前。当地媒体给了整整一小时的直播。'; } }
  ];

  var CAMP_RULES = [
    { re: /集会|造势|演讲|rally|市政厅/, ap: 1, momentum: 0.12, energy: -8,
      stats: { enthusiasm: 0.8, nameRec: 0.5 }, visits: 2.2, tone: '强硬',
      txt: function () { return '会场塞满了人，你讲了四十分钟，短视频当晚在社交平台刷屏。'; } },
    { re: /广告|投放|电视|数字|社交媒体|宣传/, ap: 1, momentum: 0.08, energy: -2, funds: -12,
      stats: { adSpend: 12, nameRec: 1.4, scandalHeat: -2 },
      txt: function () { return '新一组广告在摇摆州铺开，团队把预算压在晚间新闻时段。'; } },
    { re: /筹款|晚宴|金主|募款/, ap: 1, momentum: 0.04, energy: -5, funds: 18,
      stats: { scandalHeat: 2 },
      txt: function () { return '闭门晚宴进账颇丰，随行记者拍到你与几位游说者同桌。'; } },
    { re: /草根|小额|志愿者|社区|教会/, ap: 1, momentum: 0.06, energy: -4, funds: 6,
      stats: { groundGame: 2, enthusiasm: 1 },
      txt: function () { return '志愿者在社区中心排起长队，小额捐款的平均单笔不到三十美元。'; } },
    { re: /辩论|备战|模拟/, ap: 1, momentum: 0.05, energy: -6, stats: { debateScore: 1 },
      txt: function () { return '你在戴维营与幕僚进行模拟辩论，团队把对手的常用句式逐条拆解。'; } },
    { re: /攻击|负面|对手|反对派研究/, ap: 1, momentum: 0.05, energy: -2, funds: -8,
      stats: { scandalHeat: 1.5 },
      txt: function () { return '新一轮负面广告上线，对手阵营连夜发出律师函。'; } },
    { re: /采访|访谈|脱口秀|记者/, ap: 1, momentum: 0.1, energy: -4, stats: { nameRec: 1.2 },
      txt: function () { return '采访中你被追问了三次同一个问题，视频片段在两小时内成为热门。'; } },
    { re: /休整|休息|调整/, ap: 1, momentum: 0, energy: 20, txt: function () { return '你按下了行程表，团队替你应付媒体。'; } },
    { re: /访问|走访|工厂|农场|州|演讲/, ap: 1, momentum: 0.1, energy: -7,
      stats: { enthusiasm: 0.6, nameRec: 0.4 }, visits: 2.0, stateLift: 1.2,
      txt: function () { return '你走进车间与工人握手，当地电视台全程跟拍。'; } }
  ];

  function pickRule(rules, text) {
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].re.test(text)) return rules[i];
    }
    return null;
  }

  function offline(mode, input, extra) {
    var text = String(input || '');
    var r = null, rule = null;
    if (mode === 'campaign') {
      rule = pickRule(CAMP_RULES, text);
      r = { success: 'success', apCost: 1, risk: 'low', tone: '程序性', effects: {} };
      if (rule) {
        r.apCost = rule.ap || 1;
        r.campaign = {
          momentum: rule.momentum || 0, energy: rule.energy || 0, funds: rule.funds || 0,
          stats: rule.stats || {}, visits: rule.visits ? { 'PA': rule.visits } : {},
          stateLift: rule.stateLift ? { 'PA': rule.stateLift } : {}
        };
        r.tone = rule.tone || '程序性';
        r.narrative = rule.txt();
        r.headline = '竞选行程';
      } else {
        r.narrative = '团队按你的意思安排了本周的行程，效果要到下周才看得出来。';
        r.headline = '竞选安排';
        r.campaign = { momentum: 0.04, energy: -3, funds: 0, stats: { nameRec: 0.3 }, visits: {}, stateLift: {} };
      }
      r.followup = '（本地规则裁决：未调用 AI，数值按原版竞选的量级估算。）';
      return { result: r, norm: gate(normalize(r, mode)), offline: true };
    }

    rule = pickRule(RULES, text);
    r = { success: 'success', apCost: 1, risk: 'low', tone: '程序性', effects: {} };
    if (rule) {
      r.apCost = rule.ap || 1;
      r.effects = {
        approval: rule.fx.appr || 0,
        confidence: rule.fx.conf || 0,
        gdp: rule.fx.gdp || 0,
        unemployment: rule.fx.unemp || 0,
        tension: rule.fx.tension || 0,
        stock: rule.fx.sp || 0,
        division: rule.fx.div || 0,
        deficit: rule.def || 0
      };
      if (rule.corp) r.effects.sectors = rule.corp;
      if (rule.rel) r.effects.relations = rule.rel;
      r.tone = rule.tone || '程序性';
      r.narrative = rule.txt();
      r.headline = String(text).replace(/[，。；！？\s].*$/, '').slice(0, 16) || '既定行动';
    } else {
      r.effects = { approval: 0.6, confidence: 1 };
      r.narrative = '白宫按你的指示推动了这项工作，联邦机构开始执行，具体效果还要几周才能看清。';
      r.headline = String(text).replace(/[，。；！？\s].*$/, '').slice(0, 16) || '既定行动';
    }
    r.followup = '（本地规则裁决：未调用 AI，数值按原版行动的量级估算。）';
    return { result: r, norm: gate(normalize(r, mode)), offline: true };
  }

  global.AIADJ = {
    CAP: CAP,
    GRADES: GRADES,
    gradeOf: gradeOf,
    parseGrade: parseGrade,
    VIS: VIS,
    visOf: visOf,
    parseVisibility: parseVisibility,
    normalize: normalize,
    gate: gate,
    apply: apply,
    chipsOf: chipsOf,
    offline: offline,
    cleanText: cleanText
  };
})(window);
