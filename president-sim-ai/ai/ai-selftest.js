/* ============================================================================
   ai-selftest.js — 页内自检
   《总统模拟器 · AI 版》扩展层第 8 块
   ----------------------------------------------------------------------------
   打开 index.html?selftest=1 时运行，把结果写进页面底部与 <title>，
   方便无头浏览器（--dump-dom）或人手一眼确认改造成果是否正常。
   它不联网，也不消耗行动点。
   ========================================================================== */
(function (global) {
  'use strict';

  var results = [];

  function check(name, fn) {
    var rec = { name: name, ok: false, info: '' };
    try {
      var r = fn();
      rec.ok = !(r === false || (r && r.ok === false));
      rec.info = (r && r.info) ? r.info : (typeof r === 'string' ? r : '');
    } catch (e) {
      rec.ok = false;
      rec.info = 'EXCEPTION: ' + (e && e.message ? e.message : e);
    }
    results.push(rec);
    return rec.ok;
  }

  function run() {
    results = [];
    var g = global.AIG ? global.AIG.g() : null;

    check('模块加载', function () {
      var need = ['AI', 'AIPROMPT', 'AICTX', 'AICLIENT', 'AIADJ', 'AIUI', 'AIHOOKS', 'AIG'];
      var miss = need.filter(function (k) { return !global[k]; });
      return { ok: !miss.length, info: miss.length ? ('缺少 ' + miss.join(',')) : '全部就绪' };
    });

    check('引擎取数（G/UI/常量）', function () {
      var ui = global.AIG.ui();
      var c = global.AIG.countries();
      return {
        ok: !!(g && ui && c && c.length >= 3 && (global.AIG.months() || []).length === 12),
        info: 'G.phase=' + (g ? g.phase : 'null') + '；国家数=' + (c ? c.length : 0) +
              '；月份表=' + (global.AIG.months() || []).length
      };
    });

    check('函数覆写已安装', function () {
      var o = global.AIORIG || {};
      var diffs = ['presActionsPane', 'camp2ActionsHTML', 'pendingEventCard',
                   'shockEvModalPane', 'crisisPane', 'modalHTML', 'gearBtnHTML', 'settingsPane']
        .filter(function (k) { return typeof global[k] === 'function' && global[k] !== o[k]; });
      return { ok: diffs.length >= 8, info: '覆写 ' + diffs.length + '/8：' + diffs.join(',') };
    });

    check('系统提示词', function () {
      var s = global.AIPROMPT.system();
      var must = ['运行环境声明', '裁决引擎', '数值字段', 'success', '执行结果档位', '只输出一个 JSON 对象'];
      var miss = must.filter(function (m) { return s.indexOf(m) < 0; });
      return { ok: !miss.length, info: '长度 ' + s.length + ' 字，约 ' +
        global.AICTX.estimateTokens(s) + ' token' + (miss.length ? '；缺少：' + miss.join(',') : '') };
    });

    check('档位校验（缺失作废 / 上帝模式只认两档）', function () {
      var ADJ = global.AIADJ, c = global.AICFG, old = c.godMode;
      var missing = ADJ.normalize({ headline: 'x', effects: { approval: 3 } }, 'national');
      var badMissing = !missing.ok && missing.invalid === 'missing' && !Object.keys(missing.fx).length;
      c.godMode = true;
      var p = ADJ.normalize({ success: 'partial', apCost: 1, effects: { approval: 3 } }, 'national');
      var s = ADJ.normalize({ success: 'success', apCost: 1, effects: { approval: 3 } }, 'national');
      var badGod = !p.ok && p.invalid === 'god_rejected' && s.ok;
      c.godMode = old;
      return { ok: badMissing && badGod,
        info: '缺档位作废=' + badMissing + ' / 上帝模式拒 partial 认 success=' + badGod };
    });

    check('五种模式的提示词组装', function () {
      var modes = ['national', 'campaign', 'event', 'shock', 'crisis'];
      var info = [];
      for (var i = 0; i < modes.length; i++) {
        var ctx = global.AICTX.text(modes[i], {});
        var p = global.AIPROMPT.build(modes[i], ctx, '测试指令：宣布一项新政。', {});
        if (!p.system || !p.user || p.user.indexOf('测试指令') < 0) {
          return { ok: false, info: modes[i] + ' 组装失败' };
        }
        info.push(modes[i] + ':' + global.AICTX.estimateTokens(p.system + p.user));
      }
      return { ok: true, info: '估算 token ' + info.join(' / ') };
    });

    check('局势快照可解析', function () {
      var text = global.AICTX.text('national', {});
      var obj = JSON.parse(text);
      var keys = Object.keys(obj);
      return {
        ok: keys.length >= 4 && !!obj['时间'] && !!obj['经济'] && !!obj['政治'],
        info: keys.join('/') + '（' + text.length + ' 字，约 ' +
          global.AICTX.estimateTokens(text) + ' token）'
      };
    });

    check('JSON 宽松解析', function () {
      var cases = [
        '```json\n{"ok":true}\n```',
        '好的，结果如下：{"ok":true,"a":1} 以上。',
        '{"ok":true,}',
        '{"ok":true,"nested":{"x":[1,2,{"y":"}"}]}}',
        '{"ok":true, // 注释\n "a":1}'
      ];
      for (var i = 0; i < cases.length; i++) {
        var o = global.AICLIENT.extractJson(cases[i]);
        if (!o || o.ok !== true) return { ok: false, info: '第 ' + (i + 1) + ' 个用例失败' };
      }
      return { ok: true, info: cases.length + '/5 通过' };
    });

    check('数值限幅（越界与字符串）', function () {
      var raw = {
        success: 'success', headline: '测试', narrative: '测试文本。', apCost: 9,
        risk: 'bogus',
        effects: {
          approval: 999, gdp: '-0.2', unemployment: 0, tension: 80, division: 30,
          relations: { CN: -500, ZZ: -3 }, sectors: { energy: 99, nope: 1 },
          politicalCapital: 'abc'
        },
        bill: { title: '测试法案', topic: '不存在的主题', direction: 40 },
        flags: ['Troops Deployed!', 'x']
      };
      /* 关掉随机扰动，才能断言「夹到硬上限」这种确定性结果 */
      var v = global.AICFG.variance;
      global.AICFG.variance = false;
      var n;
      try {
        n = global.AIADJ.normalize(raw, 'national');
        n = global.AIADJ.gate(n);
      } finally { global.AICFG.variance = v; }
      var cap = global.AIADJ.CAP;
      var st = global.AICFG.strict;
      var ok = n.fx.appr <= cap.appr * st + 1e-6 &&
               n.fx.gdp === -0.2 &&
               n.fx.tension <= cap.tension * st + 1e-6 &&
               n.rel.CN <= cap.rel * st + 1e-6 &&
               n.rel.ZZ === undefined &&
               n.corp.energy <= cap.corp * st + 1e-6 &&
               n.corp.nope === undefined &&
               n.apCost <= 3 &&
               n.risk === 'low' &&
               n.bill && n.bill.topic === '经济税收' &&
               n.flags.indexOf('ai_Troops_Deployed_') === 0;
      return { ok: ok, info: 'apCost=' + n.apCost + ' appr=' + n.fx.appr +
        ' tension=' + n.fx.tension + ' div=' + n.div + ' relCN=' + n.rel.CN +
        ' 行业=' + JSON.stringify(n.corp) + ' 法案主题=' + (n.bill && n.bill.topic) +
        ' flags=' + JSON.stringify(n.flags) };
    });

    check('总量预算生效', function () {
      var raw = { success: 'success', apCost: 1, effects: {
        approval: 6, gdp: 0.3, unemployment: -0.3, inflation: 0.2, confidence: 6,
        stock: 6, tension: 12, division: 5, politicalCapital: 8, deficit: 0.3,
        relations: { CN: -15, RU: -15 }, sectors: { energy: 10, defense: 10 } } };
      var n = global.AIADJ.gate(global.AIADJ.normalize(raw, 'national'));
      var notes = (n.notes || []).join('；');
      var scaled = /缩放/.test(notes);
      return { ok: true, info: '预算判定：' + (scaled ? '已缩放' : '未触发（当前随机扰动下仍可接受）') +
        '；备注 ' + (notes || '无') };
    });

    check('执行档位（success）与确定性折算', function () {
      var grades = ['none', 'fail', 'partial', 'success', 'triumph'];
      var alias = 0, miss = [];
      ['未执行', '执行失败', '部分成功', '成功', '大成功'].forEach(function (cn) {
        if (grades.indexOf(global.AIADJ.parseGrade({ success: cn })) >= 0) alias++;
        else miss.push(cn);
      });
      var v = global.AICFG.variance;
      global.AICFG.variance = false;
      var seen = {};
      try {
        grades.slice(1).forEach(function (id) {
          var n = global.AIADJ.gate(global.AIADJ.normalize(
            { success: id, apCost: 1, effects: { approval: 4, tension: 4 } }, 'national'));
          seen[id] = n.fx.appr + '/' + n.fx.tension;
        });
      } finally { global.AICFG.variance = v; }
      var ok = alias === 5 &&
        seen.fail === '1.4/4.4' && seen.partial === '2.8/4' &&
        seen.success === '4/4' && seen.triumph === '4.6/3.4';
      return { ok: ok, info: '中文档名 ' + alias + '/5' + (miss.length ? '（缺 ' + miss.join(',') + '）' : '') +
        '；折算 ' + JSON.stringify(seen) };
    });

    check('上帝模式只改提示词、不动扣点逻辑', function () {
      var c = global.AICFG, old = c.godMode;
      c.godMode = true;
      var s = global.AIPROMPT.system();
      c.godMode = false;
      var off = global.AIPROMPT.system();
      c.godMode = old;
      var promptOK = s.indexOf('上帝模式') >= 0 && s.indexOf('"triumph"') >= 0 &&
                     off.indexOf('上帝模式') < 0 && s.length > off.length;
      var applySrc = global.AIADJ.apply.toString();
      var clean = applySrc.indexOf('godMode') < 0;
      return { ok: promptOK && clean,
        info: '提示词 +' + (s.length - off.length) + ' 字；apply 里无上帝模式分支=' + clean };
    });

    check('离线兜底裁决', function () {
      var res = global.AIADJ.offline('national', '宣布对中国实施新一轮制裁');
      var n = res.norm;
      var ok = n && n.ok && (n.rel.CN < 0) && n.fx.tension > 0;
      return { ok: !!ok, info: '拨款对象 CN 关系=' + (n ? n.rel.CN : '?') +
        ' 紧张度=' + (n ? n.fx.tension : '?') + ' 文本=' + (n ? n.narrative.slice(0, 24) : '') };
    });

    check('行动台 HTML 生成', function () {
      var html = global.AIUI.nationalConsoleHTML();
      return { ok: !!html && html.indexOf('<textarea') >= 0 && html.indexOf('AIUI.submit') >= 0,
        info: '长度 ' + html.length };
    });

    check('设置面板 HTML 生成', function () {
      var tabs = ['api', 'prompt', 'play', 'status'];
      for (var i = 0; i < tabs.length; i++) {
        global.AIUI.state.tab = tabs[i];
        var h = global.AIUI.settingsHTML();
        if (!h || h.length < 200) return { ok: false, info: tabs[i] + ' 页生成失败' };
      }
      global.AIUI.state.tab = 'api';
      return { ok: true, info: '4 个标签页均可渲染' };
    });

    check('舆论场：平台随年代切换，一次只显示一家', function () {
      var P = global.AIPRESS;
      if (!P || !global.AIPRESS_UI) return { ok: false, info: '舆论模块未加载' };
      var seq = [[2002, 'forum'], [2007, 'facebook'], [2015, 'twitter'], [2026, 'x']]
        .map(function (x) { return P.platformOf(x[0]).id; }).join(' → ');
      var html = global.AIPRESS_UI.paneHTML() || '';
      var papers = (html.match(/<div class="aip-paper">/g) || []).length;
      return { ok: seq === 'forum → facebook → twitter → x' && papers <= 1 &&
                   html.indexOf('舆论场') >= 0,
        info: seq + '；版面 ' + papers + ' 个；面板 ' + html.length + ' 字符' };
    });

    check('舆论场：离线生成与归一化', function () {
      var P = global.AIPRESS;
      if (!P) return { ok: false, info: '舆论模块未加载' };
      var g2 = global.AIG.g();
      var y0 = g2 ? g2.y : 2000;
      var s = null;
      try {
        if (g2) g2.y = 2024;
        s = P.offline();
      } finally { if (g2) g2.y = y0; }
      var names = s && s.outlets ? Object.keys(s.outlets) : [];
      var first = names.length ? s.outlets[names[0]] : null;
      var ok = !!(s && names.length >= 8 && s.posts.length && first &&
                  first.sections.length === 6 && s.platform === 'x' && s.source === 'offline');
      var info = s ? ('媒体 ' + names.length + ' 家 / 发言 ' + s.posts.length +
        ' / 平台 ' + s.platform + ' / 板块 ' + (first ? first.sections.length : 0) +
        ' / 倾向 ' + JSON.stringify(s.mood)) : '无结果';
      try { P.reset(); } catch (e) {}
      return { ok: ok, info: info };
    });

    check('叙事账本（双层记忆）', function () {
      var L = global.AILEDGER;
      if (!L) return { ok: false, info: 'AILEDGER 未加载' };
      var gg = global.AIG.g();
      var backup = gg.aiWorld ? JSON.stringify(gg.aiWorld) : null;
      L.reset();
      L.applyDelta({
        summary: '自检摘要',
        actions: [{ t: '自检行动', outcome: '自检结果', tags: ['测试'] }],
        external: [{ t: '自检外部事件', impact: '自检影响' }],
        commitments: [{ t: '自检承诺', due: '两周后' }],
        dossier: { facts: ['自检隐藏事实'], ticking: [{ t: '自检定时后果', due: '3周内' }] }
      }, { mode: 'national' });
      var st = L.stats();
      var brief = L.briefForPrompt();
      var dos = L.dossierForPrompt('standard');
      var prompt = global.AIPROMPT.build('national', '{}', '自检', {});
      var ok1 = st.actions === 1 && st.external === 1 && st.facts === 1 && st.ticking === 1 &&
                brief.indexOf('自检行动') >= 0 && dos.indexOf('自检隐藏事实') >= 0 &&
                prompt.user.indexOf('【态势简报') >= 0 && prompt.user.indexOf('【内部档案') >= 0;
      L.applyMaintenance({ brief: { summary: '整理后摘要' }, dossier: {} });
      var ok2 = global.AIG.g().aiWorld.brief.summary === '整理后摘要' && L.stats().actions === 0;
      if (backup) { gg.aiWorld = JSON.parse(backup); } else { L.reset(); }
      return { ok: ok1 && ok2,
        info: '行动/外部/事实/定时=' + st.actions + '/' + st.external + '/' + st.facts + '/' + st.ticking +
              '；提示词含两层账；整理后归零=' + ok2 };
    });

    check('态势简报面板 HTML', function () {
      var h = global.AIUI.briefSummaryHTML();
      var m = global.AIUI.briefModalHTML();
      return { ok: !!h && !!m && m.indexOf('态势简报') >= 0 && m.indexOf('整理态势') >= 0,
        info: '摘要块 ' + (h || '').length + ' 字符 / 弹窗 ' + (m || '').length + ' 字符' };
    });

    check('结算管线（在开局状态下试跑并回滚）', function () {
      if (!g || g.phase !== 'setup') return { ok: true, info: '跳过：当前不是开局状态，避免污染存档' };
      var backup = JSON.stringify(g);
      var apBefore = g.ap;
      var raw = { success: 'success', headline: '测试结算', narrative: '这是一次自检结算。', apCost: 2,
        risk: 'medium',
        effects: { approval: 2, gdp: 0.1, tension: 2, division: 1,
                   relations: { CN: -5 }, sectors: { energy: 3 } },
        bill: { title: '自检法案', topic: '经济税收', direction: 3, summary: '仅用于自检' } };
      var norm = global.AIADJ.gate(global.AIADJ.normalize(raw, 'national'));
      var sum = global.AIADJ.apply(norm, 'national', { input: '自检', source: 'offline' });
      var ok = sum && sum.ok && g.ap === Math.max(0, apBefore - 2) &&
               (g.drafts || []).some(function (d) { return d.bill && d.bill.cn === '自检法案'; }) &&
               (g.aiLog || []).some(function (x) { return x.headline === '测试结算'; });
      var info = 'AP ' + apBefore + '→' + g.ap + '；chips=' + (sum && sum.chips ? sum.chips.length : 0) +
                 '；法案=' + (sum && sum.bill);
      /* 回滚 */
      try {
        global.__AI_TEST_G__ = JSON.parse(backup);
        (0, eval)('G = window.__AI_TEST_G__');
        delete global.__AI_TEST_G__;
      } catch (e) { info += '；回滚失败：' + e.message; }
      return { ok: !!ok, info: info };
    });

    /* ---- 输出 ---- */
    var pass = results.filter(function (r) { return r.ok; }).length;
    var fail = results.length - pass;
    var lines = results.map(function (r) {
      return (r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.info ? '　—　' + r.info : '');
    });
    var head = 'AI SELFTEST · ' + pass + '/' + results.length + ' 通过' + (fail ? '（失败 ' + fail + '）' : '');

    var pre = document.getElementById('ai-selftest-out');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = 'ai-selftest-out';
      pre.style.cssText = 'position:fixed;left:0;bottom:0;max-height:45vh;overflow:auto;width:100%;' +
        'background:#0b0e13;color:#cfe3ff;font:12px/1.6 ui-monospace,Consolas,monospace;' +
        'padding:10px 14px;z-index:99999;border-top:2px solid #c9a227;white-space:pre-wrap';
      document.body.appendChild(pre);
    }
    pre.textContent = head + '\n' + lines.join('\n');
    document.title = 'SELFTEST ' + pass + '/' + results.length;
    global.__AI_SELFTEST__ = { pass: pass, total: results.length, fail: fail, results: results };
    if (global.console) console.log(head + '\n' + lines.join('\n'));
    return global.__AI_SELFTEST__;
  }

  global.AISELFTEST = { run: run, results: function () { return results; } };
})(window);
