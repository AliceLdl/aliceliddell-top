/* ============================================================================
   proxy.js — 本地微型代理（可选，零依赖，只用 Node 内置模块）
   ----------------------------------------------------------------------------
   为什么需要它：
     浏览器直接调用别家 API 时，对方必须允许跨域（CORS）。多数国内厂商允许，
     少数不允许；另外把 API Key 写进浏览器 localStorage 也不够安全。
     这个代理只跑在你自己的电脑上（127.0.0.1），由它替浏览器去请求上游。

   用法：
     1. 复制 proxy.config.example.json 为 proxy.config.json，填 upstream 与 apiKey
        （也可以直接用环境变量 AI_API_KEY / AI_UPSTREAM / AI_PORT）
     2. node ai/proxy.js
     3. 游戏里 AI 设置 → 服务商预设 → 「本地代理」，或把接口地址填成
        http://127.0.0.1:8787/v1 ，Key 随便填（代理会替换成真的）
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
  return {
    port: Number(process.env.AI_PORT || cfg.port || 8787),
    upstream: String(process.env.AI_UPSTREAM || cfg.upstream || 'https://api.deepseek.com/v1'),
    apiKey: String(process.env.AI_API_KEY || cfg.apiKey || ''),
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

const server = http.createServer((req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  /* 健康检查：游戏里「测试连接」不会走到这里，但方便手动 curl */
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true, upstream: CFG.upstream, hasKey: !!CFG.apiKey,
      hint: 'POST /v1/chat/completions 会被转发到 upstream'
    }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '只支持 POST' } }));
  }

  if (!CFG.apiKey) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: '代理没有配置上游 API Key（proxy.config.json 或 AI_API_KEY）' } }));
  }

  /* 路径映射：去掉本地 /v1 前缀后拼到 upstream 上 */
  const parsed = url.parse(req.url);
  let sub = parsed.pathname || '';
  const upPath = (UP.pathname || '').replace(/\/$/, '');
  if (sub.indexOf('/v1/') === 0) sub = sub.slice(3);
  if (upPath && sub.indexOf(upPath) === 0) sub = sub.slice(upPath.length);
  const targetPath = upPath + (sub || '/chat/completions').replace(/\/+/g, '/');
  const query = parsed.query ? ('?' + parsed.query) : '';

  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > 4 * 1024 * 1024) { req.destroy(); return; }   /* 防大包 */
    chunks.push(c);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const headers = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Content-Length': body.length
    };
    /* 本地 Key 若填了非空值，也接受，但一律用配置里的真 Key 覆盖 */
    const clientAuth = req.headers['authorization'] || req.headers['x-api-key'] || '';
    if (/anthropic/i.test(CFG.upstream) || /x-api-key/i.test(clientAuth)) {
      headers['x-api-key'] = CFG.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = 'Bearer ' + CFG.apiKey;
    }
    for (const k in CFG.extraHeaders) headers[k] = CFG.extraHeaders[k];

    const opts = {
      hostname: UP.hostname,
      port: UP.port || (isHttps ? 443 : 80),
      path: targetPath + query,
      method: 'POST',
      headers
    };

    const t0 = Date.now();
    const upstreamReq = transport.request(opts, upRes => {
      const out = [];
      upRes.on('data', c => out.push(c));
      upRes.on('end', () => {
        const buf = Buffer.concat(out);
        log(req.method, targetPath, '→', upRes.statusCode, buf.length + 'B', (Date.now() - t0) + 'ms');
        res.writeHead(upRes.statusCode, {
          'Content-Type': upRes.headers['content-type'] || 'application/json'
        });
        res.end(buf);
      });
    });

    upstreamReq.on('error', e => {
      log('上游错误：' + e.message);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '代理转发失败：' + e.message } }));
    });

    upstreamReq.setTimeout(180000, () => upstreamReq.destroy(new Error('上游超时')));
    upstreamReq.write(body);
    upstreamReq.end();
  });
});

server.listen(CFG.port, '127.0.0.1', () => {
  console.log('=== 总统模拟器 AI 版 · 本地代理 ===');
  console.log('监听：  http://127.0.0.1:' + CFG.port + '/v1');
  console.log('上游：  ' + CFG.upstream);
  console.log('Key：   ' + (CFG.apiKey ? (CFG.apiKey.slice(0, 4) + '****' + CFG.apiKey.slice(-4)) : '（未配置！）'));
  console.log('游戏里把「接口地址」填成 http://127.0.0.1:' + CFG.port + '/v1 ，Key 随便填。');
  console.log('按 Ctrl+C 停止。');
});
