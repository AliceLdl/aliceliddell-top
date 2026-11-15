/* ============================================================================
   ai-press.js — 舆论场（媒体版面 + 民间信息流）
   《总统模拟器 · AI 版》扩展层
   ----------------------------------------------------------------------------
   两块内容：
     ① 媒体：按年代给出的一张报纸/电视台名单，各自有固定立场。每家单独成版，
        分六个板块（头条 / 国内 / 经济 / 国际 / 总统政策观察 / 社论），
        面板上一次只显示一家，用下拉栏切换；内容按需生成、逐家缓存。
     ② 民间：普通美国人的发言，平台随年代更换皮肤：
        2000-2004 论坛 → 2005-2009 Facebook → 2010-2022 Twitter → 2023+ X。

   数据存在 G.aiPress（普通字段，随存档走）：
     { week, abs, platform, posts[], mood, outlets{名称→版面}, order[], selected }
   ========================================================================== */
(function (global) {
  'use strict';

  function cfg() { return global.AICFG || {}; }
  function G() { return global.AIG.g(); }
  function clean(s, n) {
    var t = String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (n && t.length > n) t = t.slice(0, n) + '…';
    return t;
  }
  function num(v, fb) { return global.AI.num(v, fb == null ? 0 : fb); }
  function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, num(v))); }
  function weekLabel() {
    var g = G();
    return g ? (g.y + '·W' + g.w) : '';
  }
  function weekAbs() {
    var g = G();
    return g ? (g.y * 52 + g.w) : 0;
  }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

  /* ------------------------------------------------------------------ *
   * 一、平台（随年代换皮）
   * ------------------------------------------------------------------ */
  var PLATFORMS = {
    forum: {
      id: 'forum', cn: '网络论坛', site: 'AMERICA ONLINE · 政治版',
      note: '早期 BBS / 留言板：没有点赞，只有回复与浏览数；语气粗粝，引用靠「楼上」，标题党刚开始流行。',
      engagement: '浏览数 100~5000、回复 0~40',
      likes: 0, reposts: 0, replies: 40, views: 5000
    },
    facebook: {
      id: 'facebook', cn: 'Facebook', site: 'facebook',
      note: '大学起家的社交网络：真实姓名、头像墙、点赞与分享；转发时爱加一句自己的评论。',
      engagement: '点赞 5~5000、评论 0~300、分享 0~200',
      likes: 5000, reposts: 200, replies: 300, views: 0
    },
    twitter: {
      id: 'twitter', cn: 'Twitter', site: 'twitter',
      note: '短帖时代：140/280 字、转推、喜欢、话题标签；吵架与玩梗并存，媒体人也在这里抢首发。',
      engagement: '喜欢 10~30000、转推 0~8000、回复 0~2000',
      likes: 30000, reposts: 8000, replies: 2000, views: 0
    },
    x: {
      id: 'x', cn: 'X', site: 'X',
      note: '改名后的 X：转帖、喜欢、查看数；蓝标认证遍地，嘲讽、阴谋论与长帖并存。',
      engagement: '喜欢 100~200000、转帖 0~20000、查看 1000~5000000',
      likes: 200000, reposts: 20000, replies: 20000, views: 5000000
    }
  };

  function platformOf(y) {
    y = Number(y) || 2000;
    if (y <= 2004) return PLATFORMS.forum;
    if (y <= 2009) return PLATFORMS.facebook;
    if (y <= 2022) return PLATFORMS.twitter;
    return PLATFORMS.x;
  }

  /* ------------------------------------------------------------------ *
   * 二、媒体名单（立场固定，随年代进出）
   * ------------------------------------------------------------------ */
  var OUTLETS = [
    { id: 'nyt', cn: '纽约时报', en: 'The New York Times', slant: 'liberal', from: 2000, to: 2040,
      slogan: 'All the News That\u2019s Fit to Print',
      voice: '严肃自由派，重视制度、调查报道与道德姿态；对共和党政府天然挑剔' },
    { id: 'wapo', cn: '华盛顿邮报', en: 'The Washington Post', slant: 'liberal', from: 2000, to: 2040,
      slogan: 'Democracy Dies in Darkness',
      voice: '关注权力运作与国安事务，标题爱用「内部文件显示」' },
    { id: 'wsj', cn: '华尔街日报', en: 'The Wall Street Journal', slant: 'conservative', from: 2000, to: 2040,
      slogan: 'The Daily Diary of the American Dream',
      voice: '社论版自由市场至上，减税与放松监管一律叫好，赤字与关税一律批评' },
    { id: 'usat', cn: '今日美国', en: 'USA Today', slant: 'centrist', from: 2000, to: 2040,
      slogan: 'The Nation\u2019s Newspaper',
      voice: '全国性通俗报纸，短句、图表、民调，尽量两边都问一句' },
    { id: 'ap', cn: '美联社', en: 'Associated Press', slant: 'wire', from: 2000, to: 2040,
      slogan: 'The definitive source for independent journalism',
      voice: '通讯社体：只写事实、数字与各方表态，几乎不评论' },
    { id: 'npr', cn: '全国公共广播', en: 'NPR', slant: 'liberal', from: 2000, to: 2040,
      slogan: 'News, culture, and analysis',
      voice: '温和自由派，爱做长解释、请专家、强调政策细节' },
    { id: 'fox', cn: '福克斯新闻', en: 'Fox News', slant: 'conservative', from: 2000, to: 2040,
      slogan: 'Fair and Balanced',
      voice: '保守派旗舰：主打治安、移民、军队与「主流媒体不告诉你的事」' },
    { id: 'cnn', cn: 'CNN', en: 'CNN', slant: 'centrist', from: 2000, to: 2040,
      slogan: 'Go There',
      voice: '中间偏自由，突发与民调见长，喜欢用「双方都面临压力」的框架' },
    { id: 'politico', cn: '政治报', en: 'Politico', slant: 'centrist', from: 2007, to: 2040,
      slogan: 'The inside story',
      voice: '只关心谁赢谁输、票数从哪来，标题常带「内部人士称」' },
    { id: 'msnbc', cn: 'MSNBC', en: 'MSNBC', slant: 'liberal', from: 2008, to: 2040,
      slogan: 'This is who we are',
      voice: '自由派评论台，喜欢把政策说成「民主的存亡之战」' },
    { id: 'breitbart', cn: '布莱巴特', en: 'Breitbart', slant: 'populist', from: 2012, to: 2040,
      slogan: 'Big Government News',
      voice: '民粹右翼：标题情绪化、爱用感叹号，攻击建制派与移民' },
    { id: 'axios', cn: 'Axios', en: 'Axios', slant: 'centrist', from: 2017, to: 2040,
      slogan: 'Smart brevity',
      voice: '要点式、短段落，末尾爱加一句「为什么重要」' }
  ];

  function roster(year) {
    var y = Number(year) || 2000;
    var alive = OUTLETS.filter(function (o) { return y >= o.from && y <= o.to; });
    var base = alive.filter(function (o) { return o.from <= 2000; });
    var extra = alive.filter(function (o) { return o.from > 2000; });
    var out = base.slice(0, 6).concat(extra).concat(base.slice(6));
    return out.slice(0, 8);
  }

  function outletDef(name) {
    for (var i = 0; i < OUTLETS.length; i++) if (OUTLETS[i].cn === name) return OUTLETS[i];
    return null;
  }

  /* 版面板块（顺序固定，前端照此排版） */
  var SECTIONS = [
    { k: 'lead', cn: '头条' },
    { k: 'domestic', cn: '国内' },
    { k: 'economy', cn: '经济' },
    { k: 'world', cn: '国际' },
    { k: 'policy', cn: '总统政策观察' },
    { k: 'opinion', cn: '社论' }
  ];
  function sectionCN(k) {
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].k === k) return SECTIONS[i].cn;
    return '';
  }

  /* ------------------------------------------------------------------ *
   * 三、数据初始化与迁移
   * ------------------------------------------------------------------ */
  function blank() {
    return {
      v: 2, week: '', abs: 0, updatedAt: '', year: 0, platform: 'forum',
      posts: [], mood: { support: 0, oppose: 0, neutral: 0 },
      outlets: {}, order: [], selected: '',
      source: '', summary: ''
    };
  }

  function wrapLegacy(m) {
    return {
      name: m.outlet || m.name || '未命名媒体',
      en: m.en || '', slant: m.slant || 'centrist',
      tone: m.tone || 'neutral', focus: m.focus || '国内',
      slogan: '', week: '', abs: 0, at: '', source: 'ai',
      sections: [{ k: 'lead', cn: '头条',
        items: [{ h: m.headline || '', p: m.take || '' }] }]
    };
  }

  function ensure() {
    var g = G();
    if (!g) return null;
    if (!g.aiPress || typeof g.aiPress !== 'object') g.aiPress = blank();
    var s = g.aiPress;
    var b = blank();
    for (var k in b) if (s[k] == null) s[k] = b[k];
    if (!Array.isArray(s.posts)) s.posts = [];
    if (!s.mood || typeof s.mood !== 'object') s.mood = b.mood;
    if (!s.outlets || typeof s.outlets !== 'object') s.outlets = {};

    /* 旧版（media 数组）迁移成 outlets */
    if (Array.isArray(s.media) && s.media.length && !Object.keys(s.outlets).length) {
      s.media.forEach(function (m) {
        if (!m || !(m.outlet || m.name)) return;
        var o = wrapLegacy(m);
        o.week = s.week || ''; o.abs = s.abs || 0; o.at = s.updatedAt || '';
        o.source = s.source || 'ai';
        s.outlets[o.name] = o;
      });
    }
    delete s.media;

    /* 旧存档迁移：嘲讽已并入反对 */
    if (s.mood.mock) s.mood.oppose = (s.mood.oppose || 0) + s.mood.mock;
    delete s.mood.mock;
    if (s.mood.support == null) s.mood.support = 0;
    if (s.mood.oppose == null) s.mood.oppose = 0;
    if (s.mood.neutral == null) s.mood.neutral = 0;
    s.posts.forEach(function (p) { if (p && p.stance === 'mock') p.stance = 'oppose'; });

    /* 顺序表 / 当前选中 */
    var names = roster(g.y || 2000).map(function (o) { return o.cn; });
    if (!Array.isArray(s.order) || !s.order.length) s.order = names.slice();
    for (var i = 0; i < names.length; i++) {
      if (s.order.indexOf(names[i]) < 0) s.order.push(names[i]);
    }
    s.order = s.order.filter(function (n) { return outletDef(n) || s.outlets[n]; });
    if (!s.selected || s.order.indexOf(s.selected) < 0) s.selected = s.order[0] || '';
    return s;
  }

  function current() {
    var s = ensure();
    return (s && (s.posts.length || Object.keys(s.outlets).length)) ? s : null;
  }

  function has() { return !!current(); }

  function stale() {
    var s = ensure();
    if (!s || !s.week) return true;
    var every = Math.max(1, Number(cfg().pressEvery) || 2);
    if (s.abs && weekAbs() - s.abs >= every) return true;
    return s.week !== weekLabel();
  }

  function outletNames(s) {
    s = s || ensure();
    if (!s) return [];
    return (s.order || []).slice();
  }

  function selectedOutlet(s) {
    s = s || ensure();
    if (!s || !s.selected) return null;
    return s.outlets[s.selected] || null;
  }

  /* ------------------------------------------------------------------ *
   * 四、生成请求：民间信息流
   * ------------------------------------------------------------------ */
  function payloadBase() {
    var g = G();
    var y = g ? g.y : 2000;
    var led = global.AILEDGER;
    var brief = led ? led.ensure() : null;
    var recent = brief ? brief.brief.actions.slice(-4).map(function (a) {
      return '· ' + a.t + (a.outcome ? ' → ' + a.outcome : '');
    }) : [];
    var external = brief ? brief.brief.external.slice(-3).map(function (a) { return '· ' + a.t; }) : [];
    return {
      now: weekLabel(),
      year: y,
      platform: platformOf(y),
      recentActions: recent,
      externalEvents: external,
      activeBill: g && g.activeBill ? { cn: g.activeBill.cn, pop: g.activeBill.pop } : null,
      pendingEvents: g && g.pendingEvents ? g.pendingEvents.slice(0, 2).map(function (p) { return p.ev && p.ev.cn; }) : [],
      crises: g && g.crises ? g.crises.slice(0, 3).map(function (c) { return c.cn; }) : [],
      approval: g && g.pres ? Math.round(g.pres.appr) : 50
    };
  }

  function contextLines(p) {
    var lines = [];
    lines.push('【当前局势】');
    lines.push(global.AICTX.text('press', {}));
    lines.push('');
    lines.push('【时间】' + p.now + '　·　总统支持率 ' + p.approval + '%');
    lines.push('');
    lines.push('【最近的行动】');
    lines.push(p.recentActions.length ? p.recentActions.join('\n') : '（本周没有新的重大行动）');
    if (p.externalEvents.length) {
      lines.push('');
      lines.push('【外部事件】');
      lines.push(p.externalEvents.join('\n'));
    }
    if (p.activeBill) {
      lines.push('');
      lines.push('【正在国会审议】《' + p.activeBill.cn + '》');
    }
    if (p.pendingEvents.length) lines.push('【待处理的突发事件】' + p.pendingEvents.filter(Boolean).join('、'));
    if (p.crises.length) lines.push('【国际焦点】' + p.crises.join('、'));
    return lines;
  }

  function buildFeedRequest() {
    var p = payloadBase();
    var sys = global.AIPROMPT.system() +
      '\n\n【本轮任务限定】你不是裁决引擎，这一轮扮演**社交平台**：只生成民间发言，' +
      '不结算任何数值，不输出 effects / ledger / apCost。';
    var n = Math.max(8, Math.min(14, Number(cfg().pressPosts) || 12));
    var lines = contextLines(p);
    lines.push('');
    lines.push('【民间平台】' + p.platform.cn + '：' + p.platform.note);
    lines.push('互动数量级：' + p.platform.engagement + '；写 ' + n + ' 条普通人的发言。');
    lines.push('');
    lines.push(global.AIPROMPT.task('press'));
    lines.push('');
    lines.push('只输出 JSON。');
    return { system: sys, user: lines.join('\n') };
  }

  /* ------------------------------------------------------------------ *
   * 五、生成请求：单家媒体整版
   * ------------------------------------------------------------------ */
  function buildOutletRequest(name) {
    var g = G();
    var p = payloadBase();
    var def = outletDef(name) || { cn: name, en: '', slant: 'centrist', voice: '按自己的立场报道' };
    var prev = (ensure() || { outlets: {} }).outlets[name] || null;
    var sys = global.AIPROMPT.system() +
      '\n\n【本轮任务限定】你不是裁决引擎，这一轮扮演**一家媒体的编辑室**：' +
      '只写这一家这一期的版面，不结算任何数值，不输出 effects / ledger / apCost。';
    var lines = contextLines(p);
    lines.push('');
    lines.push('【本期媒体】' + def.cn + '（' + (def.en || '') + '）');
    lines.push('立场：' + def.slant + '　腔调：' + (def.voice || ''));
    lines.push('版头口号（可微调，不要改名）：' + (def.slogan || ''));
    lines.push('年份：' + p.year + '　（写作时注意时代：机构、人物、技术都要符合这一年）');
    if (prev && prev.week) {
      var prevHeads = [];
      (prev.sections || []).forEach(function (sec) {
        (sec.items || []).forEach(function (it) { if (it.h) prevHeads.push(it.h); });
      });
      if (prevHeads.length) {
        lines.push('');
        lines.push('【上一期已用过的标题（不要重复）】');
        lines.push(prevHeads.slice(0, 8).map(function (h) { return '· ' + h; }).join('\n'));
      }
    }
    lines.push('');
    lines.push(global.AIPROMPT.task('press_outlet'));
    lines.push('');
    lines.push('只输出 JSON。');
    return { system: sys, user: lines.join('\n') };
  }

  /* ------------------------------------------------------------------ *
   * 六、归一化
   * ------------------------------------------------------------------ */
  var TONES = ['support', 'criticize', 'mixed', 'neutral'];
  var STANCES = ['support', 'oppose', 'neutral'];

  function normTone(t) {
    var tone = String(t || '').toLowerCase();
    if (TONES.indexOf(tone) >= 0) return tone;
    if (/表|赞|支持|肯定|拥护/.test(String(t || ''))) return 'support';
    if (/批|反对|质疑|抨击|不满/.test(String(t || ''))) return 'criticize';
    if (/两极|分歧/.test(String(t || ''))) return 'mixed';
    return 'neutral';
  }

  function normSections(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (sec) {
      if (!sec || typeof sec !== 'object') return;
      var k = String(sec.k || sec.key || '').toLowerCase();
      var cn = sectionCN(k);
      if (!cn) {
        /* 模型可能只给中文板块名 */
        for (var i = 0; i < SECTIONS.length; i++) {
          if (SECTIONS[i].cn === String(sec.cn || sec.name || '')) { k = SECTIONS[i].k; cn = SECTIONS[i].cn; break; }
        }
      }
      if (!cn) return;
      var items = [];
      (Array.isArray(sec.items) ? sec.items : (sec.h ? [sec] : [])).slice(0, 2).forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        var h = clean(it.h || it.headline || it.title, 60);
        var body = clean(it.p || it.text || it.body, 260);
        if (!h && !body) return;
        if (!h) h = body.slice(0, 22);
        items.push({ h: h, p: body });
      });
      if (!items.length) return;
      out.push({ k: k, cn: cn, items: items });
    });
    /* 按固定顺序排，缺的板块不补 */
    out.sort(function (a, b) {
      var ia = -1, ib = -1;
      for (var i = 0; i < SECTIONS.length; i++) {
        if (SECTIONS[i].k === a.k) ia = i;
        if (SECTIONS[i].k === b.k) ib = i;
      }
      return ia - ib;
    });
    return out;
  }

  function applyOutlet(raw, name, source) {
    var s = ensure();
    var g = G();
    if (!s || !raw || typeof raw !== 'object') return false;
    var key = clean(raw.outlet || raw.name || name, 24) || name;
    if (!key) return false;
    var def = outletDef(key);
    var sections = normSections(raw.sections || raw['板块'] || []);
    /* 允许模型把内容写在顶层 items / lead 里 */
    if (!sections.length && (raw.lead || raw.headline)) {
      sections = normSections([{ k: 'lead', items: [{ h: raw.headline || raw.lead, p: raw.take || raw.text }] }]);
    }
    if (!sections.length) return false;
    s.outlets[key] = {
      name: key,
      en: clean(raw.en || (def && def.en) || '', 50),
      slant: clean(raw.slant || (def && def.slant) || 'centrist', 16),
      tone: normTone(raw.tone),
      focus: clean(raw.focus, 10) || '国内',
      slogan: clean(raw.slogan || (def && def.slogan) || '', 60),
      week: weekLabel(), abs: weekAbs(), at: global.AI.nowText(),
      source: source === 'offline' ? 'offline' : 'ai',
      sections: sections
    };
    if (s.order.indexOf(key) < 0) s.order.push(key);
    if (!s.selected) s.selected = key;
    s.week = weekLabel();
    s.abs = weekAbs();
    s.updatedAt = global.AI.nowText();
    if (source !== 'offline' && !s.source) s.source = 'ai';
    return true;
  }

  function normPosts(list, platformID) {
    var plat = PLATFORMS[platformID] || PLATFORMS.forum;
    var out = [];
    (Array.isArray(list) ? list : []).slice(0, 18).forEach(function (p, i) {
      if (!p || typeof p !== 'object') return;
      var text = clean(p.text || p.content, 200);
      if (!text) return;
      var stance = String(p.stance || '').toLowerCase();
      if (stance === 'mock' || stance === '嘲讽') stance = 'oppose';
      if (STANCES.indexOf(stance) < 0) {
        stance = /反对|骂|烂|下台|失败|讽|梗|乐|哈哈/.test(String(p.stance || '')) ? 'oppose'
               : /支持|赞|挺|好/.test(String(p.stance || '')) ? 'support' : 'neutral';
      }
      out.push({
        name: clean(p.name || p.user, 24) || ('用户' + (1000 + i)),
        handle: clean(p.handle, 24).replace(/^@?/, '@') || ('@user' + (1000 + i)),
        loc: clean(p.loc || p.state, 6).toUpperCase(),
        stance: stance,
        text: text,
        likes: Math.round(clampN(p.likes, 0, plat.likes || 0)),
        reposts: Math.round(clampN(p.reposts || p.shares || 0, 0, plat.reposts || 0)),
        replies: Math.round(clampN(p.replies || p.comments || 0, 0, plat.replies || 0)),
        views: Math.round(clampN(p.views || 0, 0, plat.views || 0)),
        verified: !!p.verified,
        time: clean(p.time, 12) || '刚刚'
      });
    });
    return out;
  }

  function moodOf(posts) {
    var m = { support: 0, oppose: 0, neutral: 0 };
    posts.forEach(function (p) {
      var k = (p.stance === 'mock') ? 'oppose' : p.stance;
      if (m[k] != null) m[k]++;
    });
    return m;
  }

  function applyFeed(raw, source) {
    var s = ensure();
    if (!s || !raw || typeof raw !== 'object') return false;
    var feed = raw.feed && typeof raw.feed === 'object' ? raw.feed : raw;
    var g = G();
    var plat = platformOf(g ? g.y : 2000);
    var posts = normPosts(feed.posts || feed['民间'] || [], plat.id);
    if (!posts.length) return false;
    s.posts = posts;
    s.platform = plat.id;
    s.year = g ? g.y : 0;
    s.mood = moodOf(posts);
    s.week = weekLabel();
    s.abs = weekAbs();
    s.updatedAt = global.AI.nowText();
    s.summary = clean(raw.summary || raw['总体'], 80);
    s.source = source === 'offline' ? 'offline' : 'ai';
    return true;
  }

  /* 兼容旧调用：一次给 media 数组 + feed 的返回 */
  function apply(raw, source) {
    if (!raw || typeof raw !== 'object') return false;
    var ok = false;
    if (Array.isArray(raw.media) && raw.media.length) {
      raw.media.forEach(function (m) {
        if (!m || typeof m !== 'object') return;
        var name = m.outlet || m.name;
        if (!name) return;
        var payload = m.sections ? m : {
          outlet: name, tone: m.tone, focus: m.focus, en: m.en, slant: m.slant,
          sections: [{ k: 'lead', cn: '头条', items: [{ h: m.headline || '', p: m.take || '' }] }]
        };
        if (applyOutlet(payload, name, source)) ok = true;
      });
    }
    if (raw.feed || raw.posts || raw['民间']) {
      if (applyFeed(raw, source)) ok = true;
    }
    return ok;
  }

  /* ------------------------------------------------------------------ *
   * 七、离线兜底（不花 token 也有版面）
   * ------------------------------------------------------------------ */
  var SEC_HEAD = {
    lead: {
      support: ['白宫在{焦点}上交出一份成绩单', '{焦点}：政府称方向正确'],
      criticize: ['{焦点}：白宫仍在回避代价', '专家警告{焦点}政策难以为继'],
      mixed: ['{焦点}：一场没有赢家的争论', '围绕{焦点}的分歧还在扩大'],
      neutral: ['{焦点}：本周发生了什么', '{焦点}进展一览']
    },
    domestic: {
      support: ['州府与街头：秩序正在恢复', '地方官员称联邦支援到位'],
      criticize: ['州长们开始公开抱怨', '治安与无家可归问题仍在恶化'],
      mixed: ['同一条街，两种美国', '地方反应分裂'],
      neutral: ['国内一周：五个州的动向', '各州政策速览']
    },
    economy: {
      support: ['就业数据好于预期', '中小企业称订单回流'],
      criticize: ['物价仍在吃掉工资涨幅', '制造业岗位继续外流'],
      mixed: ['增长与通胀的拉锯', '华尔街与主街看法相反'],
      neutral: ['本周经济数据一览', '利率、油价与就业']
    },
    world: {
      support: ['盟友称赞华盛顿的协调', '海外驻军获得新的授权'],
      criticize: ['盟友开始怀疑美国的承诺', '对手在试探底线'],
      mixed: ['两条战线，两种压力', '海外局势进入僵持'],
      neutral: ['国际一周：三个热点', '全球要闻速览']
    },
    policy: {
      support: ['总统的行政令开始落地', '白宫称政策已见效'],
      criticize: ['这项政策的账单还没算清', '法院可能叫停这项命令'],
      mixed: ['政策的两难：快与稳', '支持者与批评者各说各话'],
      neutral: ['本周政策清单', '总统签了什么、改了什么']
    },
    opinion: {
      support: ['社论：把这件事做到底', '我们需要一个不退缩的白宫'],
      criticize: ['社论：代价被藏起来了', '这不是治国，是表演'],
      mixed: ['社论：对了一半', '方向可以，方法不行'],
      neutral: ['社论：先把事实说清楚', '关于这周，我们知道的与不知道的']
    }
  };
  var PARA = {
    support: [
      '本报记者走访了三个州，受访者普遍认为方向是对的，真正的考验在执行。',
      '官员表示数据将在数周内公布，白宫对结果保持乐观。',
      '支持者强调，拖延的代价比争议更大，现在需要的是把事情做完。'
    ],
    criticize: [
      '批评者指出，成本被推迟到下一个财年，账单迟早要有人付。',
      '多位专家提醒，这项安排在法律上站不住脚，诉讼几乎不可避免。',
      '地方官员抱怨，联邦的承诺没有配套资金，压力全落在州一级。'
    ],
    mixed: [
      '同一件事，两党给出了完全不同的因果：一边说是必要之举，一边说是越权。',
      '民调显示选民在方向上分裂，在具体做法上更加分裂。',
      '支持与反对各有道理，真正的问题是没有人愿意承担时间成本。'
    ],
    neutral: [
      '以下是目前可以确认的事实：时间、票数、以及各方的公开表态。',
      '相关机构尚未回应置评请求，更多细节预计在下周公布。',
      '数据来自公开文件与三名要求匿名的官员。'
    ]
  };
  var POST_TPL = {
    support: [
      '我不管别人怎么说，油价降了、工作还在，这就够了。',
      '终于有人在做实事。我们这条街去年关了三家店，今年开了两家。',
      '媒体天天唱衰，可我的税单确实少了一点。',
      '支持总统把这件事顶下去，别被华盛顿那帮人拖死。'
    ],
    oppose: [
      '说得好听，我孩子的医保保费又涨了。谁负责？',
      '街上帐篷越来越多，白宫还在发推。',
      '我投过他，现在只想说：把钱花在本地，别花在海外。',
      '又是一轮口号。工资没涨，房租涨了三成。',
      '一定是隔壁州的错。',
      '各位别吵了，股市明天会告诉我们答案（然后继续跌）。',
      '恭喜，我们又创下了一个“史上最”。',
      '建议把国会山改成景区收门票，至少能还点债。'
    ],
    neutral: [
      '有没有人能给我一个不带立场的解释？我真的是来查资料的。',
      '两边都在喊，我只想知道下周汽油多少钱。',
      '看了三条新闻，三个说法，算了，去上班。',
      '我关心的是学区、路面和治安，别的先放放。'
    ]
  };
  var NAMES = [
    ['迈克尔', 'Mike'], ['莎拉', 'Sarah'], ['詹姆斯', 'James'], ['艾米', 'Amy'],
    ['罗伯特', 'Robert'], ['琳达', 'Linda'], ['大卫', 'David'], ['凯伦', 'Karen'],
    ['何塞', 'Jose'], ['玛丽亚', 'Maria'], ['丹', 'Dan'], ['格雷格', 'Greg'],
    ['泰勒', 'Tyler'], ['布列塔尼', 'Brittany'], ['阿卜杜勒', 'Abdul'], ['林', 'Lin']
  ];
  var STATE_IDS = ['OH', 'PA', 'MI', 'WI', 'FL', 'TX', 'CA', 'NY', 'GA', 'NC', 'AZ', 'NV', 'IA', 'MO', 'WA', 'MA'];
  var FOCUS = ['国内', '经济', '外交', '政策', '司法', '社会'];

  function toneFor(def, appr, party) {
    var bullish = /liberal/.test(def.slant) ? (party === 'D')
                : /conservative|populist/.test(def.slant) ? (party === 'R')
                : null;
    var score = (appr - 50) / 25 + (bullish === true ? 0.6 : bullish === false ? -0.7 : 0) +
                (Math.random() - 0.5) * 0.6;
    return score > 0.7 ? 'support' : score < -0.5 ? 'criticize'
         : (Math.abs(score) < 0.35 ? 'neutral' : 'mixed');
  }

  function offlineOutlet(name, source) {
    var g = G();
    var def = outletDef(name) || { cn: name, en: '', slant: 'centrist', slogan: '' };
    var appr = g && g.pres ? g.pres.appr : 50;
    var party = g && g.pres ? g.pres.party : null;
    var tone = toneFor(def, appr, party);
    var focus = pick(FOCUS);
    var sections = SECTIONS.map(function (sec) {
      var head = pick(SEC_HEAD[sec.k][tone]).replace('{焦点}', focus === '国内' ? '国内局势' : focus + '议题');
      var p1 = pick(PARA[tone]);
      var p2 = sec.k === 'lead'
        ? '本报记者就' + focus + '议题采访了白宫与国会双方，双方都要求对方先让步。'
        : (sec.k === 'opinion' ? '以上代表本报编辑部立场。' : '');
      return { k: sec.k, cn: sec.cn, items: [{ h: head, p: (p1 + (p2 ? p2 : '')).slice(0, 180) }] };
    });
    return applyOutlet({
      outlet: name, tone: tone, focus: focus, slogan: def.slogan || '',
      sections: sections
    }, name, source || 'offline') ? ensure().outlets[name] : null;
  }

  function offlineFeed() {
    var g = G();
    var y = g ? g.y : 2000;
    var plat = platformOf(y);
    var appr = g && g.pres ? g.pres.appr : 50;
    var n = Math.max(8, Math.min(14, Number(cfg().pressPosts) || 12));
    var sup = Math.round(n * Math.max(0.1, Math.min(0.7, appr / 100)));
    var opp = Math.round(n * Math.max(0.1, Math.min(0.6, (100 - appr) / 100 * 0.8)));
    var posts = [];
    for (var i = 0; i < n; i++) {
      var stance = i < sup ? 'support' : (i < sup + opp ? 'oppose' : 'neutral');
      var nm = pick(NAMES);
      var en = plat.id === 'forum' ? (nm[1].toLowerCase() + '_' + (1980 + Math.floor(Math.random() * 27)))
                                   : nm[1] + ' ' + pick(['S.', 'M.', 'K.', 'R.']);
      var scale = { forum: [0, 0, 0, 1200], facebook: [220, 8, 14, 0], twitter: [420, 60, 30, 0], x: [1800, 220, 90, 42000] }[plat.id];
      posts.push({
        name: plat.id === 'forum' ? en : nm[0] + '·' + nm[1].charAt(0),
        handle: '@' + nm[1].toLowerCase() + Math.floor(Math.random() * 90),
        loc: pick(STATE_IDS),
        stance: stance,
        text: pick(POST_TPL[stance]),
        likes: scale[0] ? Math.round(scale[0] * (0.2 + Math.random() * 2.4)) : 0,
        reposts: scale[1] ? Math.round(scale[1] * (0.1 + Math.random() * 2)) : 0,
        replies: scale[2] ? Math.round(scale[2] * (0.1 + Math.random() * 2)) : Math.round(Math.random() * 18),
        views: scale[3] ? Math.round(scale[3] * (0.2 + Math.random() * 2)) : 0,
        verified: plat.id === 'x' ? Math.random() < 0.3 : false,
        time: pick(['刚刚', '12分钟前', '1小时前', '3小时前', '昨天'])
      });
    }
    return applyFeed({ feed: { platform: plat.id, posts: posts }, summary: '本地规则生成' }, 'offline')
      ? ensure() : null;
  }

  /* 兼容：一次生成信息流 + 全部媒体（离线） */
  function offline() {
    var s = offlineFeed();
    var g = G();
    roster(g ? g.y : 2000).forEach(function (o) { offlineOutlet(o.cn, 'offline'); });
    return ensure();
  }

  /* ------------------------------------------------------------------ *
   * 八、生成流程（供 hooks / UI 调用）
   * ------------------------------------------------------------------ */
  function toast(msg) { try { if (typeof showToast === 'function') showToast(msg); } catch (e) {} }

  function refreshFeed(manual) {
    var ui = global.AIUI;
    if (!global.AI || global.AI.STAT.busy) {
      if (manual) toast('正在处理另一个请求，稍后再刷新。');
      return;
    }
    if (!cfg().enabled) return;
    var built;
    try { built = buildFeedRequest(); } catch (e) { return; }
    ui.startBusy('刷新信息流');
    global.AICLIENT.chat(built.system, built.user, {
      maxTokens: Math.max(1000, Number(cfg().maxTokens) || 1200),
      temperature: 0.85
    }).then(function (res) {
      var raw = global.AICLIENT.extractJson(res.text);
      if (!applyFeed(raw, 'ai')) throw new Error('返回结构不对');
      if (manual) toast('民间信息流已更新。');
    }).catch(function (e) {
      if (!ensure().posts.length) { try { offlineFeed(); } catch (e2) {} }
      if (manual) ui.state.error = '信息流生成失败：' + (e && e.message ? e.message : e);
    }).then(function () {
      ui.endBusy();
      if (typeof render === 'function') render();
      /* 信息流好了，顺手把当前这家的版面补上（只补空的，避免多花钱） */
      try {
        var s = ensure();
        if (s && s.selected && !s.outlets[s.selected] && cfg().enabled) {
          setTimeout(function () {
            if (!global.AI.STAT.busy) refreshOutlet(s.selected, false);
          }, 60);
        }
      } catch (e) {}
    });
  }

  function refreshOutlet(name, manual) {
    var ui = global.AIUI;
    if (!global.AI || global.AI.STAT.busy) {
      if (manual) toast('正在处理另一个请求，稍后再生成。');
      return;
    }
    if (!cfg().enabled) return;
    name = name || (ensure() || {}).selected;
    if (!name) return;
    var built;
    try { built = buildOutletRequest(name); } catch (e) { return; }
    ui.startBusy('生成「' + name + '」版面');
    global.AICLIENT.chat(built.system, built.user, {
      maxTokens: Math.max(1600, Number(cfg().maxTokens) || 1200),
      temperature: 0.8
    }).then(function (res) {
      var raw = global.AICLIENT.extractJson(res.text);
      if (!applyOutlet(raw, name, 'ai')) throw new Error('返回结构不对');
      if (manual) toast('《' + name + '》版面已更新。');
    }).catch(function (e) {
      if (!ensure().outlets[name]) { try { offlineOutlet(name, 'offline'); } catch (e2) {} }
      if (manual) ui.state.error = '《' + name + '》生成失败：' + (e && e.message ? e.message : e);
    }).then(function () {
      ui.endBusy();
      if (typeof render === 'function') render();
    });
  }

  /* 逐家生成全部媒体（串行，避免并发把接口打爆） */
  function refreshAllOutlets(manual) {
    var ui = global.AIUI;
    if (!global.AI || global.AI.STAT.busy) {
      if (manual) toast('正在处理另一个请求，稍后再生成。');
      return;
    }
    if (!cfg().enabled) return;
    var g = G();
    var names = roster(g ? g.y : 2000).map(function (o) { return o.cn; });
    if (!names.length) return;
    var i = 0;
    ui.startBusy('生成媒体 0/' + names.length);
    function step() {
      if (i >= names.length) {
        ui.endBusy();
        if (manual) toast('全部媒体版面已更新。');
        if (typeof render === 'function') render();
        return;
      }
      var nm = names[i++];
      global.AI.STAT.busyLabel = '生成媒体 ' + i + '/' + names.length + '：' + nm;
      if (typeof render === 'function') render();
      var built;
      try { built = buildOutletRequest(nm); } catch (e) { step(); return; }
      global.AICLIENT.chat(built.system, built.user, {
        maxTokens: Math.max(1600, Number(cfg().maxTokens) || 1200),
        temperature: 0.8
      }).then(function (res) {
        var raw = global.AICLIENT.extractJson(res.text);
        if (!applyOutlet(raw, nm, 'ai')) throw new Error('结构不对');
      }).catch(function () {
        if (!ensure().outlets[nm]) { try { offlineOutlet(nm, 'offline'); } catch (e2) {} }
      }).then(step);
    }
    step();
  }

  /* 兼容旧名：刷新＝刷新信息流 */
  function refresh(manual) { refreshFeed(manual); }

  function reset() {
    var g = G();
    if (g) g.aiPress = blank();
  }

  global.AIPRESS = {
    PLATFORMS: PLATFORMS,
    OUTLETS: OUTLETS,
    SECTIONS: SECTIONS,
    platformOf: platformOf,
    roster: roster,
    outletDef: outletDef,
    sectionCN: sectionCN,
    ensure: ensure,
    blank: blank,
    current: current,
    has: has,
    stale: stale,
    outletNames: outletNames,
    selectedOutlet: selectedOutlet,
    buildFeedRequest: buildFeedRequest,
    buildOutletRequest: buildOutletRequest,
    buildRequest: buildOutletRequest,       /* 兼容旧名 */
    applyFeed: applyFeed,
    applyOutlet: applyOutlet,
    apply: apply,
    offline: offline,
    offlineFeed: offlineFeed,
    offlineOutlet: offlineOutlet,
    refresh: refresh,
    refreshFeed: refreshFeed,
    refreshOutlet: refreshOutlet,
    refreshAllOutlets: refreshAllOutlets,
    reset: reset,
    moodOf: moodOf,
    normPosts: normPosts,
    weekLabel: weekLabel
  };
})(window);
