// Vercel Serverless Function: /api/proxy
// Handles GET/POST/PUT/PATCH/DELETE ?url=<target> — fetches target, rewrites HTML links to stay in-proxy

const BLOCKED_RESPONSE_HEADERS = [
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "permissions-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "x-content-type-options",
];

const STRIP_REQUEST_HEADERS = new Set([
  "host", "origin", "referer", "cookie",
  "x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip",
  "connection", "transfer-encoding", "te", "upgrade",
  "proxy-authorization", "proxy-connection",
]);

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
};

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL = { html: 30000, css: 120000, default: 300000 };

function getCached(url) {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.ts > (CACHE_TTL[e.kind] ?? CACHE_TTL.default)) { cache.delete(url); return null; }
  return e;
}
function setCache(url, body, contentType, kind) {
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
  cache.set(url, { body, contentType, ts: Date.now(), kind });
}

function toAbs(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

function proxiedHref(href, base) {
  if (/^(javascript:|mailto:|tel:|#)/i.test(href)) return href;
  return `/api/proxy?url=${encodeURIComponent(toAbs(href, base))}`;
}

function rewriteHtml(html, finalUrl, originalOrigin) {
  // <a> / <area> links stay inside proxy
  html = html.replace(
    /(<(?:a|area)\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, href) => /^(javascript:|mailto:|tel:|#)/i.test(href) ? m : `${pre}${q}${proxiedHref(href, finalUrl)}${q}`
  );

  // <form action> stays inside proxy
  html = html.replace(
    /(<form\b[^>]*?\baction\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, action) => `${pre}${q}${proxiedHref(action, finalUrl)}${q}`
  );

  // Resolve relative src attributes to absolute so browser loads them from origin
  html = html.replace(
    /(<(?:script|img|source|track|input|iframe)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, src) => {
      if (/^(data:|blob:|https?:\/\/)/i.test(src)) return m;
      return `${pre}${q}${toAbs(src, finalUrl)}${q}`;
    }
  );
  html = html.replace(
    /(<link\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, href) => {
      if (/^(data:|blob:|https?:\/\/)/i.test(href)) return m;
      return `${pre}${q}${toAbs(href, finalUrl)}${q}`;
    }
  );

  // Inject <base> so inline relative URLs resolve to original origin
  if (!/&lt;base\b/i.test(html)) {
    html = html.replace(/(<head\b[^>]*>)/i, `$1<base href="${originalOrigin}/">`);
  }

  // Inject the network intercept script (fetch + XHR override)
  const interceptScript = buildInterceptScript(originalOrigin);
  html = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${interceptScript}</head>`)
    : interceptScript + html;

  return html;
}

function rewriteCss(css, finalUrl) {
  return css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi, (m, q, src) => {
    if (/^(data:|blob:|https?:\/\/)/i.test(src)) return m;
    try { return `url(${q}${toAbs(src, finalUrl)}${q})`; } catch { return m; }
  });
}

function buildInterceptScript(originalOrigin) {
  return `<script>
(function(){
  var __OO__ = ${JSON.stringify(originalOrigin)};
  var __PB__ = '/api/proxy';

  function rwHttp(url) {
    if (!url || typeof url !== 'string') return url;
    var u = url;
    if (u.startsWith('//')) u = location.protocol + u;
    else if (u.startsWith('/')) u = __OO__ + u;
    else if (!/^https?:/i.test(u)) { try { u = new URL(u, __OO__).href; } catch(e){ return url; } }
    if (u.startsWith(location.origin + '/api/proxy')) return url;
    if (u.startsWith(location.origin)) return url;
    return __PB__ + '?url=' + encodeURIComponent(u);
  }

  var _fetch = window.fetch.bind(window);
  window.fetch = function(resource, opts) {
    try {
      if (resource instanceof Request) {
        var rw2 = rwHttp(resource.url);
        if (rw2 !== resource.url) resource = new Request(rw2, resource);
      } else {
        resource = rwHttp(String(resource));
      }
    } catch(e){}
    return _fetch(resource, opts);
  };

  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = rwHttp(String(args[1])); } catch(e){}
    return _open.apply(this, args);
  };

  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({type:'proxy-url', url: __OO__}, '*');
    }
  } catch(e){}
})();
</script>`;
}

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(204).end();
  }

  const rawUrl = req.query?.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }
  try { new URL(targetUrl); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const method = req.method || 'GET';

  // Check cache for GET requests
  if (method === 'GET') {
    const cached = getCached(targetUrl);
    if (cached) {
      for (const h of BLOCKED_RESPONSE_HEADERS) {
        try { res.removeHeader(h); } catch {}
      }
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Proxy-Cache', 'HIT');
      return res.send(cached.body);
    }
  }

  // Build forwarded headers
  const forwardHeaders = { ...BASE_HEADERS };
  for (const [key, val] of Object.entries(req.headers || {})) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase()) && typeof val === 'string') {
      forwardHeaders[key] = val;
    }
  }
  if (!forwardHeaders['accept']) {
    forwardHeaders['accept'] = method === 'GET'
      ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      : 'application/json, */*';
  }

  let body = undefined;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && req.body) {
    const ct = (req.headers?.['content-type'] ?? '').toLowerCase();
    if (ct.includes('application/json')) {
      body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      body = new URLSearchParams(req.body).toString();
    } else if (typeof req.body === 'string') {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
    }
  }

  let response;
  try {
    response = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    return res.status(502).json({ error: `Failed to reach target: ${err.message}` });
  }

  const finalUrl = response.url || targetUrl;
  const rawCT = response.headers.get('content-type') ?? 'application/octet-stream';
  const isHtml = rawCT.includes('text/html');
  const isCss = rawCT.includes('text/css');

  let bodyBuffer = Buffer.from(await response.arrayBuffer());
  let contentType = rawCT;

  if (isHtml) {
    const originalOrigin = new URL(finalUrl).origin;
    let html = bodyBuffer.toString('utf-8');
    html = rewriteHtml(html, finalUrl, originalOrigin);
    bodyBuffer = Buffer.from(html, 'utf-8');
    contentType = 'text/html; charset=utf-8';
    if (method === 'GET') setCache(targetUrl, bodyBuffer, contentType, 'html');
  } else if (isCss) {
    let css = bodyBuffer.toString('utf-8');
    css = rewriteCss(css, finalUrl);
    bodyBuffer = Buffer.from(css, 'utf-8');
    if (method === 'GET') setCache(targetUrl, bodyBuffer, rawCT, 'css');
  } else if (method === 'GET') {
    setCache(targetUrl, bodyBuffer, rawCT, 'default');
  }

  for (const h of BLOCKED_RESPONSE_HEADERS) {
    try { res.removeHeader(h); } catch {}
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(bodyBuffer.length));
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('X-Proxy-Cache', 'MISS');
  res.status(response.status).send(bodyBuffer);
}
