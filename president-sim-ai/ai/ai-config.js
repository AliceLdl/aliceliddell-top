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
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.75,
    maxTokens: 1200,
    timeoutMs: 90000,
    /* 上下文深度：lite=只给核心数字 / standard=完整局势 / deep=再加各州与日志 */
    contextLevel: 'standard',
    /* 叙事风格：documentary=白宫纪事 / news=通讯社快讯 / novel=政治小说 */
    style: 'documentary',
    /* 引擎对 AI 给出的数值施加 ±25% 的随机扰动（保持推演的不确定性） */
    variance: true,
    /* 接口不可用时，用本地规则裁决（原版数值表反推），保证还能玩 */
    offlineFallback: true,
    /* 在自由输入框下方保留原版内置行动/选项（默认关闭） */
    showClassic: false,
    /* 数值上限倍率：0.6 保守 / 1.0 标准 / 1.5 宽松 */
    strict: 1.0,
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
    /* 调试：把请求/响应打到控制台 */
    verbose: false
  };

  /* ------------------------------------------------------------------ *
   * 服务商预设（地址 + 默认模型 + 备注）
   * 说明：只要对方兼容 OpenAI 的 /chat/completions，都可以直接用 openai 协议。
   * ------------------------------------------------------------------ */
  var PROVIDERS = [
    { id: 'openai',    cn: 'OpenAI 兼容（通用）', baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini', fallback: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini', 'o1-mini'],
      note: '任何兼容 /chat/completions 的服务都能用：DeepSeek、Kimi、智谱、Qwen、SiliconFlow、OpenRouter、OneAPI…' },
    { id: 'deepseek',  cn: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat', fallback: ['deepseek-chat', 'deepseek-reasoner'],
      note: '性价比高，中文政治叙事表现好，支持 JSON 输出。' },
    { id: 'moonshot',  cn: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k', fallback: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      note: '8k 上下文够用；长上下文模型可换成 moonshot-v1-32k。' },
    { id: 'zhipu',     cn: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash', fallback: ['glm-4-flash', 'glm-4-air', 'glm-4-plus', 'glm-4-long'],
      note: 'glm-4-flash 免费额度大，适合反复试玩。' },
    { id: 'qwen',      cn: '阿里通义 Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus', fallback: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
      note: 'DashScope 的 OpenAI 兼容模式。' },
    { id: 'silicon',   cn: 'SiliconFlow 硅基流动', baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V3',
      fallback: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
      note: '国内直连，聚合多家模型。' },
    { id: 'openrouter',cn: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-3.5-sonnet',
      fallback: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-2.0-flash-001', 'deepseek/deepseek-chat'],
      note: '一个 key 调多家模型，需要能访问外网。' },
    { id: 'anthropic', cn: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      fallback: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
      note: '走 /v1/messages 协议，浏览器直连已自动加 CORS 头。' },
    { id: 'gemini',    cn: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.0-flash', fallback: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
      note: '走 generateContent，key 用 ?key= 传递。' },
    { id: 'proxy',     cn: '本地代理（推荐用于 CORS 受限时）', baseUrl: 'http://127.0.0.1:8787/v1',
      model: 'deepseek-chat', fallback: ['deepseek-chat', 'deepseek-reasoner'],
      note: '先运行 node ai/proxy.js，再把上游地址与 key 写进代理配置。' },
    { id: 'custom',    cn: '自定义（手工填地址）', baseUrl: '', model: '', fallback: [],
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
                             id === 'proxy' || id === 'openai') ? 'openai' : id };
    if (p.baseUrl) patch.baseUrl = p.baseUrl;
    if (p.model) patch.model = p.model;
    if (id === 'proxy') patch.provider = 'openai';
    return set(patch);
  }

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
    loadHistory: loadHistory, pushHistory: pushHistory,
    history: history, clearHistory: clearHistory
  };

  global.AICFG = load();
  global.AI.loadHistory();
})(window);
