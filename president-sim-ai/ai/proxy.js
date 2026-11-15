/* ============================================================================
   proxy.js — 本地微型代理（可选，零依赖，只用 Node 内置模块）
   ----------------------------------------------------------------------------
   为什么需要它：
     浏览器直接调用别家 API 时，对方必须允许跨域（CORS）。多数国内厂商允许，
     少数不允许（例如 OpenCode / 一些企业内部网关）；另外把 API Key 写进浏览器
     localStorage 也不够安全。这个代理只跑在你自己的电脑上（127.0.0.1），
     由它替浏览器去请求上游。

   用法：
     1. 复制 proxy.config.example.json 为 proxy.config.json，填 upstream 与 key
        （环境变量 AI_PORT / AI_UPSTREAM / AI_API_KEY / AI_KEY_ENV / AI_AUTH_STYLE 优先）
     2. node ai/proxy.js
     3. 游戏里 AI 设置 → 「改用本地代理」按钮（或服务商预设选「本地代理」），
        接口地址会变成 http://127.0.0.1:8787/v1 ，Key 随便填（代理会替换成真的）

   认证风格 authStyle：
     auto      按上游地址猜（含 anthropic 或 sk-ant 开头的 key → x-api-key，其余 → Bearer）
     bearer    Authorization: Bearer <key>
     x-api-key 头（Anthropic 风格），同时补 anthropic-version
     none      不带任何认证头（内网无鉴权网关）
   ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const CONFIG_PATH = path.join(__dirname, 'proxy.config.json');

function loadConfig() {
  let cfg = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('proxy.config.json 解析失败：' + e.message);
  }
  /* key 的三种来源：环境变量里指定的变量名 > AI_API_KEY > 配置文件 */
  const keyEnv = String(process.env.AI_KEY_ENV || cfg.apiKeyEnv || '').trim();
  let key = '';
  if (keyEnv && process.env[keyEnv]) key = String(process.env[keyEnv]);
  if (!key) key = String(process.env.AI_API_KEY || cfg.apiKey || '');
  return {
    port: Number(process.env.AI_PORT || cfg.port || 8787),
    upstream: String(process.env.AI_UPSTREAM || cfg.upstream || 'https://api.deepseek.com/v1'),
    apiKey: key,
    apiKeyEnv: keyEnv,
    authStyle: String(process.env.AI_AUTH_STYLE || cfg.authStyle || 'auto').toLowerCase(),
    allowOrigin: String(cfg.allowOrigin || '*'),
    extraHeaders: cfg.extraHeaders || {}
  };
}

const CFG = loadConfig();
const UP = new URL(CFG.upstream);
const isHttps = UP.protocol === 'https:';
const transport = isHttps ? https : http;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CFG.allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function log(...a) {
  console.log('[' + new Date().toLocaleTimeString() + ']', ...a);
}

/* 认证头：按 authStyle 决定，auto 时看上游地址与 key 前缀 */
function authHeaders() {
  const key = CFG.apiKey;
  if (!key) return {};
  const style = CFG.authStyle === 'auto'
    ? ((/anthropic/i.test(CFG.upstream) || /^sk-ant/.test(key)) ? 'x-api-key' : 'bearer')
    : CFG.authStyle;
  if (style === 'none') return {};
  if (style === 'x-api-key') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  return { 'Authorization': 'Bearer ' + key };
}

/* 路径映射：本地 /v1/xxx → upstream 的 path 前缀 + /xxx */
function mapPath(rawUrl) {
  const parsed = url.parse(rawUrl);
  let sub = parsed.pathname || '';
  const upPath = (UP.pathname || '').replace(/\/$/, '');
  if (sub.indexOf('/v1/') === 0) sub = sub.slice(3);          /* 去掉本地 /v1 */
  if (upPath && sub.indexOf(upPath) === 0) sub = sub.slice(upPath.length);
  const targetPath = upPath + (sub || '/chat/completions').replace(/\/+/g, '/');
  return { targetPath, query: parsed.query ? ('?' + parsed.query) : '' };
}

function forward(req, res, body) {
  const { targetPath, query } = mapPath(req.url);
  const headers = Object.assign({}, authHeaders(), CFG.extraHeaders);
  if (body && body.length) {
    headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    headers['Content-Length'] = body.length;
  }
  for (const k in req.headers) {
    const lk = String(k).toLowerCase();
    if (lk.startsWith('x-') && !headers[k]) headers[lk] = req.headers[k];
  }
  if (!headers['User-Agent']) headers['User-Agent'] = 'president-sim-ai-proxy/1.0';

  const opts = {
    hostname: UP.hostname,
    port: UP.port || (isHttps ? 443 : 80),
    path: targetPath + query,
    method: req.method,
    headers
  };

  const t0 = Date.now();
  const upReq = transport.request(opts, upRes => {
    const out = [];
    upRes.on('data', c => out.push(c));
    upRes.on('end', () => {
      const buf = Buffer.concat(out);
      log(req.method, targetPath, '→', upRes.statusCode, buf.length + 'B', (Date.now() - t0) + 'ms');
      const h = { 'Content-Type': upRes.headers['content-type'] || 'application/json' };
      cors(res);
      res.writeHead(upRes.statusCode, h);
      res.end(buf);
    });
  });

  upReq.on('error', e => {
    log('上游错误：' + e.message);
    if (!res.headersSent) { cors(res); res.writeHead(502, { 'Content-Type': 'application/json' }); }
    res.end(JSON.stringify({ error: { message: '代理转发失败：' + e.message } }));
  });

  upReq.setTimeout(180000, () => upReq.destroy(new Error('上游超时')));
  if (body && body.length) upReq.write(body);
  upReq.end();
}

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  /* 健康检查：方便手动 curl / 游戏里排查代理是否起来了 */
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true, upstream: CFG.upstream, authStyle: CFG.authStyle,
      hasKey: !!CFG.apiKey, keyEnv: CFG.apiKeyEnv || '(未指定)',
      hint: 'POST /v1/chat/completions 与 GET /v1/models 都会被转发到 upstream'
    }));
  }

  /* GET：模型列表（/v1/models）直接透传，游戏里「拉取列表」能用 */
  if (req.method === 'GET') return forward(req, res, null);

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '只支持 GET / POST' } }));
  }

  if (!CFG.apiKey && CFG.authStyle !== 'none') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      error: { message: '代理没有配置上游 API Key（proxy.config.json 的 apiKey / apiKeyEnv，或环境变量 AI_API_KEY）' }
    }));
  }

  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 4 * 1024 * 1024) { req.destroy(); return; }   /* 防大包 */
    chunks.push(c);
  });
  req.on('end', () => forward(req, res, Buffer.concat(chunks)));
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log('=== 总统模拟器 AI 版 · 本地代理 ===');
  console.log('监听：  http://127.0.0.1:' + CFG.port + '/v1');
  console.log('上游：  ' + CFG.upstream);
  console.log('认证：  ' + CFG.authStyle + (CFG.apiKeyEnv ? ('（key 取自环境变量 ' + CFG.apiKeyEnv + '）') : ''));
  console.log('Key：   ' + (CFG.apiKey ? (CFG.apiKey.slice(0, 4) + '****' + CFG.apiKey.slice(-4)) : '（未配置）'));
  console.log('游戏里点「改用本地代理」，或把「接口地址」填成 http://127.0.0.1:' + CFG.port + '/v1 。');
  console.log('按 Ctrl+C 停止。');
});
