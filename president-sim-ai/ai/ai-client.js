/* ============================================================================
   ai-client.js — 接口客户端
   《总统模拟器 · AI 版》扩展层第 4 块
   ----------------------------------------------------------------------------
   支持四种协议：
     · openai     —— 任何兼容 /chat/completions 的服务（DeepSeek / Kimi / 智谱 /
                     Qwen / SiliconFlow / OpenRouter / OneAPI / 本地代理…）
     · anthropic  —— Claude 的 /v1/messages
     · gemini     —— Google 的 generateContent
     · custom     —— 仍按上面三种之一解析，只是地址与请求头完全由玩家填
   共同能力：超时、一次自动重试（429/5xx/网络错误）、宽松 JSON 解析、
   请求诊断信息（耗时 / 状态码 / token），以及可中断。
   ========================================================================== */
(function (global) {
  'use strict';

  var retryTimer = null;
  var currentAbort = null;

  function cfg() { return global.AICFG || {}; }

  function sleep(ms) {
    return new Promise(function (res) { retryTimer = setTimeout(res, ms); });
  }

  /* ------------------------------------------------------------------ *
   * URL 归一化
   * ------------------------------------------------------------------ */
  function joinUrl(base, path) {
    var b = String(base || '').trim();
    if (!b) return path;
    if (b.charAt(b.length - 1) === '/') b = b.slice(0, -1);
    if (path.charAt(0) !== '/') path = '/' + path;
    /* 玩家把完整端点粘进来时不要重复拼接 */
    if (/\/chat\/completions$/.test(b) && path.indexOf('/chat/completions') === 0) return b;
    if (/\/messages$/.test(b) && path.indexOf('/messages') === 0) return b;
    if (/generateContent$/.test(b)) return b;
    return b + path;
  }

  function endpointFor() {
    var c = cfg();
    var prov = c.provider || 'openai';
    if (prov === 'anthropic') {
      return joinUrl(c.baseUrl || 'https://api.anthropic.com', '/v1/messages');
    }
    if (prov === 'gemini') {
      var base = String(c.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
      if (/generateContent/.test(base)) return base;
      return base + '/models/' + encodeURIComponent(c.model || 'gemini-2.0-flash') +
             ':generateContent?key=' + encodeURIComponent(c.apiKey || '');
    }
    return joinUrl(c.baseUrl || 'https://api.openai.com/v1', '/chat/completions');
  }

  /* ------------------------------------------------------------------ *
   * 模型列表：自动拉取
   *   OpenAI 兼容：GET {base}/models        → {data:[{id…}]}
   *   Anthropic  ：GET {base}/v1/models     → {data:[{id, display_name…}]}
   *   Gemini     ：GET {base}/models?key=…  → {models:[{name:'models/…',supportedGenerationMethods}]}
   * ------------------------------------------------------------------ */
  function modelsEndpoint() {
    var c = cfg();
    var prov = c.provider || 'openai';
    var base = String(c.baseUrl || '').trim().replace(/\/+$/, '');
    base = base.replace(/\/chat\/completions$/, '').replace(/\/messages$/, '');
    if (prov === 'gemini') {
      base = base.replace(/\/models\/[^/]*(:generateContent)?$/, '');
      return base + '/models?key=' + encodeURIComponent(c.apiKey || '') + '&pageSize=200';
    }
    if (prov === 'anthropic') {
      return (/\/v1$/.test(base) ? base : base + '/v1') + '/models?limit=200';
    }
    return base + '/models';
  }

  /* 把各家返回的形状统一成 [{id, name}]，并按「像聊天模型的排前面」排序 */
  function parseModels(json, prov) {
    var seen = {}, list = [];
    function add(id, name) {
      id = String(id == null ? '' : id).trim().replace(/^models\//, '');
      if (!id || seen[id]) return;
      seen[id] = 1;
      list.push({ id: id, name: String(name || id) });
    }
    if (!json) return list;

    if (prov === 'gemini' && Array.isArray(json.models)) {
      json.models.forEach(function (m) {
        if (!m) return;
        var methods = m.supportedGenerationMethods;
        if (Array.isArray(methods) && methods.length &&
            methods.indexOf('generateContent') < 0) return;
        add(m.name || m.id, m.displayName || m.name);
      });
    } else if (Array.isArray(json.data)) {
      json.data.forEach(function (m) {
        if (typeof m === 'string') add(m, m);
        else if (m) add(m.id || m.name || m.model, m.display_name || m.displayName || m.id || m.name);
      });
    } else if (Array.isArray(json.models)) {
      json.models.forEach(function (m) {
        if (typeof m === 'string') add(m, m);
        else if (m) add(m.id || m.name || m.model, m.display_name || m.displayName || m.id || m.name);
      });
    } else if (Array.isArray(json)) {
      json.forEach(function (m) {
        if (typeof m === 'string') add(m, m);
        else if (m) add(m.id || m.name, m.display_name || m.displayName || m.id || m.name);
      });
    }

    function score(id) {
      var s = 0;
      if (/embed|whisper|tts|dall|moderation|rerank|image|audio|transcribe|speech|vision-preview/i.test(id)) s -= 10;
      if (/chat|instruct|gpt-4|gpt-3\.5|o1|o3|claude|deepseek|qwen|glm|moonshot|gemini|llama|mistral|grok|kimi/i.test(id)) s += 5;
      return s;
    }
    list.sort(function (a, b) {
      var d = score(b.id) - score(a.id);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    });
    return list;
  }

  function models() {
    var c = cfg();
    if (!c.baseUrl) return Promise.reject(new Error('还没有填写接口地址。'));
    if (!c.apiKey && !/127\.0\.0\.1|localhost/.test(String(c.baseUrl))) {
      return Promise.reject(new Error('还没有填写 API Key。'));
    }
    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('当前浏览器不支持 fetch。'));
    }
    var prov = c.provider || 'openai';
    var url = modelsEndpoint();
    var headers = {};
    if (prov === 'anthropic') {
      headers['x-api-key'] = c.apiKey || '';
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (prov !== 'gemini') {
      headers['Authorization'] = 'Bearer ' + (c.apiKey || '');
      if (prov === 'custom') {
        var extra = parseCustomHeaders();
        for (var k in extra) headers[k] = extra[k];
      }
    }

    var started = Date.now();
    var ctrl = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var timer = setTimeout(function () {
      if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    }, 25000);
    var init = { method: 'GET', headers: headers };
    if (ctrl) init.signal = ctrl.signal;

    return fetch(url, init).then(function (resp) {
      return resp.text().then(function (raw) {
        clearTimeout(timer);
        var ms = Date.now() - started;
        if (global.AICFG && AICFG.verbose && global.console) {
          console.log('[AI] models ' + resp.status + ' ' + ms + 'ms', raw.slice(0, 800));
        }
        if (!resp.ok) throw new Error(errorText(resp.status, raw));
        var json = null;
        try { json = JSON.parse(raw); } catch (e) {
          throw new Error('模型列表不是 JSON（可能是代理错误页）：' + raw.slice(0, 160));
        }
        if (json && json.error) {
          throw new Error('服务端报错：' + (json.error.message || JSON.stringify(json.error)).slice(0, 240));
        }
        var list = parseModels(json, prov);
        if (!list.length) throw new Error('接口没有返回任何可用模型。');
        return {
          models: list, ms: ms, at: global.AI.nowText(),
          endpoint: url.replace(/key=[^&]+/, 'key=***')
        };
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('拉取模型列表超时（25 秒）。');
      if (e && e.message && /Failed to fetch|NetworkError|Load failed/i.test(e.message)) {
        throw new Error('网络请求失败（该接口可能不允许浏览器直连，可改用 ai/proxy.js）。');
      }
      throw e;
    });
  }

  function parseCustomHeaders() {
    var raw = String(cfg().customHeaders || '').trim();
    if (!raw) return {};
    try {
      var o = JSON.parse(raw);
      var out = {};
      for (var k in o) if (typeof o[k] === 'string') out[k] = o[k];
      return out;
    } catch (e) { return {}; }
  }

  /* ------------------------------------------------------------------ *
   * 请求体 / 响应解析
   * ------------------------------------------------------------------ */
  function buildRequest(system, user, opts) {
    var c = cfg();
    var prov = c.provider || 'openai';
    var maxTok = (opts && opts.maxTokens) || c.maxTokens || 1200;
    var temp = (opts && opts.temperature != null) ? opts.temperature : c.temperature;
    var headers = { 'Content-Type': 'application/json' };
    var body = {};

    if (prov === 'anthropic') {
      headers['x-api-key'] = c.apiKey || '';
      headers['anthropic-version'] = '2023-06-01';
      /* 浏览器直连必须带这个头，否则 Anthropic 会拒绝 CORS */
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      body = {
        model: c.model,
        max_tokens: maxTok,
        temperature: temp,
        system: system,
        messages: [{ role: 'user', content: user }]
      };
    } else if (prov === 'gemini') {
      body = {
        contents: [{ role: 'user', parts: [{ text: system + '\n\n' + user }] }],
        generationConfig: {
          temperature: temp,
          maxOutputTokens: maxTok,
          responseMimeType: 'application/json'
        }
      };
    } else {
      headers['Authorization'] = 'Bearer ' + (c.apiKey || '');
      body = {
        model: c.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: temp,
        max_tokens: maxTok,
        stream: false,
        response_format: { type: 'json_object' }
      };
      if (prov === 'custom') {
        var extra = parseCustomHeaders();
        for (var k in extra) headers[k] = extra[k];
      }
    }
    return { headers: headers, body: body, prov: prov };
  }

  function readResponse(json, prov) {
    var text = '', usage = { input: 0, output: 0 };
    if (prov === 'anthropic') {
      var blocks = json && json.content;
      if (blocks && blocks.length) {
        for (var i = 0; i < blocks.length; i++) {
          if (blocks[i] && typeof blocks[i].text === 'string') text += blocks[i].text;
        }
      }
      if (json && json.usage) {
        usage.input = json.usage.input_tokens || 0;
        usage.output = json.usage.output_tokens || 0;
      }
    } else if (prov === 'gemini') {
      var cands = (json && json.candidates) || [];
      if (cands[0] && cands[0].content && cands[0].content.parts) {
        var parts = cands[0].content.parts;
        for (var j = 0; j < parts.length; j++) {
          if (parts[j] && typeof parts[j].text === 'string') text += parts[j].text;
        }
      }
      if (json && json.usageMetadata) {
        usage.input = json.usageMetadata.promptTokenCount || 0;
        usage.output = json.usageMetadata.candidatesTokenCount || 0;
      }
    } else {
      var ch = (json && json.choices) || [];
      if (ch[0]) {
        if (ch[0].message && typeof ch[0].message.content === 'string') text = ch[0].message.content;
        else if (typeof ch[0].text === 'string') text = ch[0].text;
      }
      if (json && json.usage) {
        usage.input = json.usage.prompt_tokens || 0;
        usage.output = json.usage.completion_tokens || 0;
      }
    }
    return { text: text, usage: usage };
  }

  function errorText(status, bodyText) {
    var brief = String(bodyText || '').replace(/\s+/g, ' ').slice(0, 320);
    return 'HTTP ' + status + '：' + (brief || '（服务端没有返回内容）');
  }

  /* ------------------------------------------------------------------ *
   * 主请求
   * ------------------------------------------------------------------ */
  function chat(system, user, opts) {
    opts = opts || {};
    var c = cfg();
    if (!c.baseUrl && !c.model) {
      return Promise.reject(new Error('还没有配置接口地址与模型，请先打开「AI 设置」。'));
    }
    if (!c.model) return Promise.reject(new Error('还没有填写模型名。'));
    if (!c.apiKey && !/127\.0\.0\.1|localhost/.test(String(c.baseUrl))) {
      return Promise.reject(new Error('还没有填写 API Key。'));
    }
    if (typeof fetch !== 'function') {
      return Promise.reject(new Error('当前浏览器不支持 fetch，请换用较新的 Chrome / Edge。'));
    }

    var req = buildRequest(system, user, opts);
    var url = endpointFor();
    var timeout = Math.max(5000, Number(c.timeoutMs) || 90000);
    var started = Date.now();
    var attempt = 0;

    function once() {
      attempt++;
      var ctrl = null;
      try {
        ctrl = new AbortController();
        currentAbort = ctrl;
      } catch (e) { ctrl = null; }

      var timer = setTimeout(function () {
        if (ctrl) { try { ctrl.abort(); } catch (e) {} }
      }, timeout);

      var init = { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) };
      if (ctrl) init.signal = ctrl.signal;

      return fetch(url, init).then(function (resp) {
        return resp.text().then(function (raw) {
          clearTimeout(timer);
          var ms = Date.now() - started;
          if (global.AICFG && AICFG.verbose && global.console) {
            console.log('[AI] ' + resp.status + ' ' + ms + 'ms', raw.slice(0, 800));
          }
          if (!resp.ok) {
            var err = new Error(errorText(resp.status, raw));
            err.status = resp.status;
            err.retryable = (resp.status === 429 || resp.status >= 500);
            /* 有的服务不支持 response_format：去掉重来一次 */
            if (resp.status === 400 && /response_format|json_object|format/i.test(raw) && !opts._noFormat) {
              err.retryable = true;
              err.dropFormat = true;
            }
            err.raw = raw;
            throw err;
          }
          var json = null;
          try { json = JSON.parse(raw); } catch (e) {
            throw new Error('服务端返回的不是 JSON（可能是代理错误页）：' + raw.slice(0, 200));
          }
          if (json && json.error) {
            throw new Error('服务端报错：' + (json.error.message || JSON.stringify(json.error)).slice(0, 240));
          }
          var got = readResponse(json, req.prov);
          if (!got.text || !String(got.text).trim()) {
            throw new Error('服务端返回了空内容。');
          }
          return {
            text: got.text,
            usage: got.usage,
            ms: ms,
            model: (c.model || ''),
            endpoint: url.replace(/key=[^&]+/, 'key=***'),
            attempts: attempt
          };
        });
      }).catch(function (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') {
          throw new Error('请求超时（' + Math.round(timeout / 1000) + ' 秒）。可在 AI 设置里调大超时时间。');
        }
        if (e && e.message && /Failed to fetch|NetworkError|Load failed/i.test(e.message)) {
          var hint = '网络请求失败。常见原因：① 该 API 不允许浏览器直连（CORS）→ 用 ai/proxy.js；' +
                     '② 地址写错；③ 需要代理才能访问。';
          var ne = new Error(hint);
          ne.network = true;
          throw ne;
        }
        throw e;
      });
    }

    function run() {
      return once().catch(function (e) {
        if (e && e.dropFormat && attempt < 2) {
          var saved = JSON.parse(JSON.stringify(req.body));
          if (saved.response_format) delete saved.response_format;
          var retryReq = buildRequest(system, user, opts);
          retryReq.body = saved;
          req = retryReq;
          return once();
        }
        if (e && e.retryable && attempt < 2) {
          return sleep(1400).then(once);
        }
        throw e;
      });
    }

    return run().then(function (res) {
      res.totalMs = Date.now() - started;
      currentAbort = null;
      return res;
    }).catch(function (e) {
      currentAbort = null;
      throw e;
    });
  }

  /* 去掉 JSON 里的 // 与 /* *\/ 注释（字符串内的不算）——模型有时会照着提示词
     里的注释写，严格 JSON.parse 会因此失败 */
  function stripComments(s) {
    var out = '', inStr = false, esc = false, i = 0;
    while (i < s.length) {
      var c = s.charAt(i), n = s.charAt(i + 1);
      if (inStr) {
        out += c;
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === '/' && n === '/') {
        i += 2;
        while (i < s.length && s.charAt(i) !== '\n') i++;
        continue;
      }
      if (c === '/' && n === '*') {
        i += 2;
        while (i < s.length && !(s.charAt(i) === '*' && s.charAt(i + 1) === '/')) i++;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 宽松 JSON 解析
   * ------------------------------------------------------------------ */
  function extractJson(text) {
    var s = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!s) throw new Error('模型返回空文本');
    /* 去掉 ```json ``` 围栏 */
    var fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence && fence[1]) s = fence[1].trim();
    /* 前后多余文字：截取第一个 { 到配对的 } */
    var start = s.indexOf('{');
    if (start < 0) throw new Error('返回内容里找不到 JSON 对象');
    var depth = 0, inStr = false, esc = false, end = -1;
    for (var i = start; i < s.length; i++) {
      var ch = s.charAt(i);
      if (inStr) {
        if (esc) { esc = false; }
        else if (ch === '\\') { esc = true; }
        else if (ch === '"') { inStr = false; }
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) {
      /* 可能被截断：补上右括号后再试 */
      var guess = s.slice(start);
      var opens = (guess.match(/{/g) || []).length;
      var closes = (guess.match(/}/g) || []).length;
      for (var k = 0; k < opens - closes; k++) guess += '}';
      s = guess;
    } else {
      s = s.slice(start, end + 1);
    }
    try {
      return JSON.parse(s);
    } catch (e1) {
      /* 尾逗号 / 全角标点 / 注释修复 */
      var fixed = s.replace(/,\s*([}\]])/g, '$1')
                   .replace(/[“”]/g, '"')
                   .replace(/：/g, ':');
      try { return JSON.parse(fixed); } catch (e2) {
        try { return JSON.parse(stripComments(fixed)); } catch (e3) {
          throw new Error('返回的 JSON 无法解析：' + String(e3.message).slice(0, 120));
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 连通性测试：要求模型只回一个极小的 JSON
   * ------------------------------------------------------------------ */
  function test() {
    var sys = '你是一个 JSON 测试端点。只输出 {"ok":true,"echo":"pong"}，不要任何其他文字。';
    var usr = 'ping';
    var t0 = Date.now();
    return chat(sys, usr, { maxTokens: 60, temperature: 0 }).then(function (res) {
      var parsed = null, err = null;
      try { parsed = extractJson(res.text); } catch (e) { err = e.message; }
      return {
        ok: !err && parsed && parsed.ok !== false,
        ms: Date.now() - t0,
        model: res.model,
        endpoint: res.endpoint,
        usage: res.usage,
        text: res.text.slice(0, 200),
        parseError: err,
        parsed: parsed
      };
    });
  }

  function abort() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (currentAbort) { try { currentAbort.abort(); } catch (e) {} currentAbort = null; }
  }

  global.AICLIENT = {
    chat: chat,
    test: test,
    models: models,
    parseModels: parseModels,
    modelsEndpoint: modelsEndpoint,
    abort: abort,
    extractJson: extractJson,
    endpointFor: endpointFor
  };
})(window);
