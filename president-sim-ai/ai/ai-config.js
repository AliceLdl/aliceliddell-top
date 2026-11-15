/* ============================================================================
   ai-config.js — 配置中心 / 持久化 / 运行状态 / 通用工具
   《总统模拟器 · AI 版》扩展层第 1 块
   ----------------------------------------------------------------------------
   本文件不碰游戏引擎，只负责：
     · 默认配置与读取/写入 localStorage
     · 各家 API 的预设（地址 + 默认模型）
     · 运行时状态（是否正在请求、最后一次请求的诊断信息、累计 token）
     · 一小把不会与引擎重名的工具函数（AI.num / AI.round / AI.uid ...）
   ========================================================================== */
(function (global) {
  'use strict';

  var CFG_KEY = 'psim.ai.cfg.v1';
  var HIST_KEY = 'psim.ai.hist.v1';

  /* ------------------------------------------------------------------ *
   * 默认配置
   * ------------------------------------------------------------------ */
  var DEFAULTS = {
    enabled: true,                 /* 关闭后行动台会退回原版按钮 */
    provider: 'openai',            /* openai | anthropic | gemini | custom */
    baseUrl: 'https://api.deepseek.com/v1',
    /* 不预置模型：必须「拉取列表」后选一个，避免写死过时的模型名 */
    model: '',
    apiKey: '',
    temperature: 0.75,
    maxTokens: 1200,
    timeoutMs: 90000,
    /* 上下文深度：lite=只给核心数字 / standard=完整局势 / deep=再加各州与日志 */
    contextLevel: 'standard',
    /* 叙事风格：documentary=白宫纪事 / news=通讯社快讯 / novel=政治小说 */
    style: 'documentary',
    /* 引擎对 AI 给出的数值施加 ±22% 的随机扰动（保持推演的不确定性） */
    variance: true,
    /* 在自由输入框下方保留原版内置行动/选项（默认关闭） */
    showClassic: false,
    /* 数值上限倍率：0.6 保守 / 1.0 标准 / 1.5 宽松 */
    strict: 1.0,
    /* 上帝模式：只改提示词（AI 一律判成功、不写任何阻力）。行动点照常消耗、数值上限照旧 */
    godMode: false,
    /* 大模型能看到的「前情提要」，你自己写，会随每次请求发送 */
    memory: '',
    /* 自定义请求头（custom 协议用），JSON 字符串 */
    customHeaders: '',
    /* 提示词覆写：{system:'', national:'', campaign:'', event:'', shock:'', crisis:''} */
    promptOverrides: {},
    /* 请求日志最多保留多少条 */
    maxHistory: 40,
    /* 叙事账本：每 N 次裁决让模型整体整理一次（1~50） */
    maintainEvery: 5,
    /* 自动整理（关掉就只能手动点「整理态势」） */
    maintainAuto: true,
    /* 把态势简报与内部档案塞进提示词（关掉能省 token，但 AI 会失忆） */
    ledgerInPrompt: true,
    /* 舆论场：每 N 周自动换一版（1~12）；关掉就只能手动刷新 */
    pressEvery: 2,
    pressAuto: true,
    /* 民间发言条数（8~14） */
    pressPosts: 12,
    /* 自动拉取到的模型列表缓存：{"provider|baseUrl": {at, models:[id…]}} */
    modelLists: {},
    /* 调试：把请求/响应打到控制台 */
    verbose: false
  };

  /* ------------------------------------------------------------------ *
   * 服务商预设（只填接口地址，不预置任何模型）
   * 说明：只要对方兼容 OpenAI 的 /chat/completions，都可以直接用 openai 协议。
   * 模型一律靠「拉取列表」从接口实时获取，避免预设里写死过时的模型名。
   * ------------------------------------------------------------------ */
  var PROVIDERS = [
    { id: 'openai',    cn: 'OpenAI 兼容（通用）', baseUrl: 'https://api.openai.com/v1',
      note: '任何兼容 /chat/completions 的服务都能用：DeepSeek、Kimi、智谱、Qwen、SiliconFlow、OpenRouter、OneAPI…' },
    { id: 'deepseek',  cn: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1',
      note: '性价比高，中文政治叙事表现好，支持 JSON 输出。' },
    { id: 'moonshot',  cn: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1',
      note: '8k 上下文够用；长上下文模型拉取后可自己挑。' },
    { id: 'zhipu',     cn: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      note: '免费额度较大，适合反复试玩。' },
    { id: 'qwen',      cn: '阿里通义 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      note: 'DashScope 的 OpenAI 兼容模式。' },
    { id: 'silicon',   cn: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1',
      note: '国内直连，聚合多家模型。' },
    { id: 'openrouter',cn: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
      note: '一个 key 调多家模型，需要能访问外网。' },
    { id: 'anthropic', cn: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com',
      note: '走 /v1/messages 协议，浏览器直连已自动加 CORS 头。' },
    { id: 'gemini',    cn: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      note: '走 generateContent，key 用 ?key= 传递。' },
    { id: 'proxy',     cn: '本地代理（推荐用于 CORS 受限时）', baseUrl: 'http://127.0.0.1:8787/v1',
      note: '先运行 node ai/proxy.js，再把上游地址与 key 写进代理配置。' },
    { id: 'custom',    cn: '自定义（手工填地址）', baseUrl: '',
      note: '自己填完整 base URL；协议仍按上面选的 openai / anthropic / gemini 处理。' }
  ];

  /* ------------------------------------------------------------------ *
   * 运行时状态（不进 localStorage，每次刷新重置）
   * ------------------------------------------------------------------ */
  var STAT = {
    busy: false,
    busyLabel: '',
    startedAt: 0,
    last: null,            /* 最近一次请求的诊断信息 */
    error: null,
    count: 0,
    tokensIn: 0,
    tokensOut: 0,
    lastApplied: null      /* 最近一次结算摘要（界面展示用） */
  };

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */
  function num(v, fb) {
    var n = Number(v);
    return isFinite(n) ? n : (fb == null ? 0 : fb);
  }
  function round(v, d) {
    var p = Math.pow(10, d == null ? 2 : d);
    return Math.round(num(v) * p) / p;
  }
  function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, num(v))); }
  function esc(s) {
    if (typeof global.h === 'function') { try { return global.h(s); } catch (e) {} }
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function uid() {
    return 'ai' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  }
  function nowText() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function safe(fn, fb) {
    try { return fn(); } catch (e) {
      if (global.console && console.warn) console.warn('[AI] ' + (e && e.message ? e.message : e));
      return fb;
    }
  }
  function isPresident() {
    if (typeof global.playerIsPresident === 'function') {
      try { return !!global.playerIsPresident(); } catch (e) {}
    }
    var g = global.AIG ? global.AIG.g() : null;
    return !!(g && g.pres && g.pres.isPlayer);
  }
  function inCampaign() {
    if (typeof global.isCampaignMode === 'function') {
      try { return !!global.isCampaignMode(); } catch (e) {}
    }
    var g = global.AIG ? global.AIG.g() : null;
    return !!(g && (g.phase === 'primary' || g.phase === 'general'));
  }
  function gameReady() {
    var g = global.AIG ? global.AIG.g() : null;
    return !!(g && g.phase && g.phase !== 'setup');
  }

  /* ------------------------------------------------------------------ *
   * 配置读写
   * ------------------------------------------------------------------ */
  var CFG = null;

  function merge(base, patch) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    for (k in (patch || {})) {
      if (patch[k] === undefined) continue;
      out[k] = patch[k];
    }
    return out;
  }

  function load() {
    var raw = null;
    try { raw = global.localStorage ? localStorage.getItem(CFG_KEY) : null; } catch (e) {}
    var saved = null;
    if (raw) { try { saved = JSON.parse(raw); } catch (e) { saved = null; } }
    CFG = merge(DEFAULTS, saved || {});
    /* 类型兜底：手改 localStorage 写坏时不至于炸 */
    CFG.temperature = clampN(CFG.temperature, 0, 2);
    CFG.maxTokens = Math.round(clampN(CFG.maxTokens, 200, 8000));
    CFG.timeoutMs = Math.round(clampN(CFG.timeoutMs, 5000, 300000));
    CFG.strict = clampN(CFG.strict, 0.4, 2);
    CFG.maxHistory = Math.round(clampN(CFG.maxHistory, 5, 200));
    CFG.maintainEvery = Math.round(clampN(CFG.maintainEvery, 1, 50));
    CFG.pressEvery = Math.round(clampN(CFG.pressEvery, 1, 12));
    CFG.pressPosts = Math.round(clampN(CFG.pressPosts, 8, 14));
    if (!CFG.promptOverrides || typeof CFG.promptOverrides !== 'object') CFG.promptOverrides = {};
    if (!CFG.modelLists || typeof CFG.modelLists !== 'object') CFG.modelLists = {};
    if (['lite', 'standard', 'deep'].indexOf(CFG.contextLevel) < 0) CFG.contextLevel = 'standard';
    if (['documentary', 'news', 'novel'].indexOf(CFG.style) < 0) CFG.style = 'documentary';
    global.AICFG = CFG;
    return CFG;
  }

  function save() {
    try {
      if (global.localStorage) localStorage.setItem(CFG_KEY, JSON.stringify(CFG));
      return true;
    } catch (e) {
      STAT.error = '配置无法写入 localStorage：' + (e && e.message ? e.message : e);
      return false;
    }
  }

  function set(patch) { CFG = merge(CFG, patch); global.AICFG = CFG; save(); return CFG; }

  function reset() {
    CFG = merge(DEFAULTS, {});
    global.AICFG = CFG;
    save();
    return CFG;
  }

  function providerPreset(id) {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].id === id) return PROVIDERS[i];
    return PROVIDERS[0];
  }

  /* 应用某个服务商预设（保留用户自己的 key 与温度等） */
  function usePreset(id) {
    var p = providerPreset(id);
    var patch = { provider: (id === 'deepseek' || id === 'moonshot' || id === 'zhipu' ||
                             id === 'qwen' || id === 'silicon' || id === 'openrouter' ||
                             id === 'opencode' || id === 'proxy' || id === 'openai') ? 'openai' : id };
    if (p.baseUrl) patch.baseUrl = p.baseUrl;
    if (p.model) patch.model = p.model;
    if (id === 'proxy') patch.provider = 'openai';
    return set(patch);
  }

  /* ------------------------------------------------------------------ *
   * 模型列表缓存（自动拉取用）
   * 键 = 协议|接口地址：换服务商/换地址就自然读到另一份缓存
   * ------------------------------------------------------------------ */
  function modelKey() {
    var base = String(CFG.baseUrl || '').trim().replace(/\/+$/, '');
    return (CFG.provider || 'openai') + '|' + base;
  }
  function modelList() {
    var e = CFG.modelLists ? CFG.modelLists[modelKey()] : null;
    return (e && Array.isArray(e.models) && e.models.length) ? e : null;
  }
  function setModelList(models, at) {
    var list = [];
    (models || []).forEach(function (m) {
      var id = String(m && m.id != null ? m.id : m || '').trim();
      if (id && list.indexOf(id) < 0) list.push(id);
    });
    list = list.slice(0, 300);
    if (!CFG.modelLists || typeof CFG.modelLists !== 'object') CFG.modelLists = {};
    CFG.modelLists[modelKey()] = { at: at || nowText(), models: list };
    /* 只保留最近 20 组，避免 localStorage 无限膨胀 */
    var keys = Object.keys(CFG.modelLists);
    if (keys.length > 20) {
      keys.sort(function (a, b) {
        return String(CFG.modelLists[a].at || '').localeCompare(String(CFG.modelLists[b].at || ''));
      });
      for (var i = 0; i < keys.length - 20; i++) delete CFG.modelLists[keys[i]];
    }
    save();
    return CFG.modelLists[modelKey()];
  }
  function clearModelLists() { CFG.modelLists = {}; save(); }

  /* ------------------------------------------------------------------ *
   * 请求历史（只存摘要，便于复盘 AI 判得对不对）
   * ------------------------------------------------------------------ */
  var HIST = [];

  function loadHistory() {
    try {
      var raw = global.localStorage ? localStorage.getItem(HIST_KEY) : null;
      HIST = raw ? (JSON.parse(raw) || []) : [];
      if (!Array.isArray(HIST)) HIST = [];
    } catch (e) { HIST = []; }
    return HIST;
  }
  function pushHistory(rec) {
    try {
      HIST.push(rec);
      while (HIST.length > (CFG.maxHistory || 40)) HIST.shift();
      if (global.localStorage) localStorage.setItem(HIST_KEY, JSON.stringify(HIST));
    } catch (e) {}
  }
  function history() { return HIST; }
  function clearHistory() {
    HIST = [];
    try { if (global.localStorage) localStorage.removeItem(HIST_KEY); } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   * 导出
   * ------------------------------------------------------------------ */
  global.AI = {
    CFG_KEY: CFG_KEY,
    DEFAULTS: DEFAULTS,
    PROVIDERS: PROVIDERS,
    STAT: STAT,
    num: num, round: round, clampN: clampN, esc: esc, uid: uid,
    nowText: nowText, safe: safe,
    isPresident: isPresident, inCampaign: inCampaign, gameReady: gameReady,
    load: load, save: save, set: set, reset: reset,
    providerPreset: providerPreset, usePreset: usePreset,
    modelKey: modelKey, modelList: modelList,
    setModelList: setModelList, clearModelLists: clearModelLists,
    loadHistory: loadHistory, pushHistory: pushHistory,
    history: history, clearHistory: clearHistory
  };

  global.AICFG = load();
  global.AI.loadHistory();
})(window);
