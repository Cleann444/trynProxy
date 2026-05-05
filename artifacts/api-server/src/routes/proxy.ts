import { Router, type IRouter, type Request, type Response } from "express";

const router: IRouter = Router();

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

// Headers we should NOT forward from the client to the target
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "cookie",         // can't forward — they're for our domain, not the target
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "connection",
  "transfer-encoding",
  "te",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
]);

// Simple LRU-style cache (GET only, HTML + CSS)
interface CacheEntry { body: Buffer; contentType: string; ts: number; kind: string }
const CACHE_TTL: Record<string, number> = { html: 30_000, css: 120_000, default: 300_000 };
const cache = new Map<string, CacheEntry>();

function getCached(url: string): CacheEntry | null {
  const e = cache.get(url);
  if (!e) return null;
  if (Date.now() - e.ts > (CACHE_TTL[e.kind] ?? CACHE_TTL.default)) { cache.delete(url); return null; }
  return e;
}
function setCache(url: string, body: Buffer, contentType: string, kind: string) {
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
  cache.set(url, { body, contentType, ts: Date.now(), kind });
}

// ── Rewriting helpers ─────────────────────────────────────────────────────────

function toAbs(href: string, base: string): string {
  try { return new URL(href, base).href; } catch { return href; }
}

function proxiedHref(href: string, base: string): string {
  if (/^(javascript:|mailto:|tel:|#)/i.test(href)) return href;
  return `/api/proxy?url=${encodeURIComponent(toAbs(href, base))}`;
}

function rewriteHtml(html: string, finalUrl: string, originalOrigin: string): string {
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
      if (/^(data:|blob:|https?:|\/\/)/i.test(src)) return m;
      return `${pre}${q}${toAbs(src, finalUrl)}${q}`;
    }
  );
  html = html.replace(
    /(<link\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, href) => {
      if (/^(data:|blob:|https?:|\/\/)/i.test(href)) return m;
      return `${pre}${q}${toAbs(href, finalUrl)}${q}`;
    }
  );

  // Inject <base> so inline relative URLs resolve to original origin
  if (!/<base\b/i.test(html)) {
    html = html.replace(/(<head\b[^>]*>)/i, `$1<base href="${originalOrigin}/">`);
  }

  // Inject the network intercept script (fetch + XHR override)
  const interceptScript = buildInterceptScript(originalOrigin);
  html = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${interceptScript}</head>`)
    : interceptScript + html;

  return html;
}

function rewriteCss(css: string, finalUrl: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, src) => {
    if (/^(data:|blob:|https?:|\/\/)/i.test(src)) return m;
    try { return `url(${q}${toAbs(src, finalUrl)}${q})`; } catch { return m; }
  });
}

function buildInterceptScript(originalOrigin: string): string {
  // Injected verbatim into the page — overrides fetch and XHR so all
  // network calls from the proxied page are routed through /api/proxy
  return `<script>
(function(){
  var __OO__ = ${JSON.stringify(originalOrigin)};
  var __PB__ = '/api/proxy';

  function rw(url) {
    if (!url || typeof url !== 'string') return url;
    var u = url;
    if (u.startsWith('//')) u = location.protocol + u;
    else if (u.startsWith('/')) u = __OO__ + u;
    else if (!/^https?:/i.test(u)) { try { u = new URL(u, __OO__).href; } catch(e){ return url; } }
    if (u.startsWith(location.origin + '/api/proxy')) return url; // already proxied
    if (u.startsWith(location.origin)) return url;               // same-origin (our own assets)
    return __PB__ + '?url=' + encodeURIComponent(u);
  }

  // --- fetch override ---
  var _fetch = window.fetch.bind(window);
  window.fetch = function(resource, opts) {
    try {
      if (resource instanceof Request) {
        var rw2 = rw(resource.url);
        if (rw2 !== resource.url) resource = new Request(rw2, resource);
      } else {
        resource = rw(String(resource));
      }
    } catch(e){}
    return _fetch(resource, opts);
  };

  // --- XMLHttpRequest override ---
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    var args = Array.prototype.slice.call(arguments);
    try { args[1] = rw(String(args[1])); } catch(e){}
    return _open.apply(this, args);
  };

  // --- Notify parent frame of current URL ---
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({type:'proxy-url', url: __OO__}, '*');
    }
  } catch(e){}
})();
</script>`;
}

// ── Fetch helper ──────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
};

async function proxyRequest(req: Request, res: Response, targetUrl: string): Promise<void> {
  const method = req.method.toUpperCase();
  const cached = method === "GET" ? getCached(targetUrl) : null;

  if (cached) {
    for (const h of BLOCKED_RESPONSE_HEADERS) res.removeHeader(h);
    res.set("Content-Type", cached.contentType);
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.set("Access-Control-Allow-Headers", "*");
    res.set("X-Proxy-Cache", "HIT");
    res.send(cached.body);
    return;
  }

  // Build forwarded headers
  const forwardHeaders: Record<string, string> = { ...BASE_HEADERS };
  for (const [key, val] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase()) && typeof val === "string") {
      forwardHeaders[key] = val;
    }
  }

  // Set Accept based on method context if not already present
  if (!forwardHeaders["accept"]) {
    forwardHeaders["accept"] = method === "GET"
      ? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      : "application/json, */*";
  }

  let body: BodyInit | undefined;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && req.body) {
    const ct = (req.headers["content-type"] ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      body = JSON.stringify(req.body);
    } else if (ct.includes("application/x-www-form-urlencoded")) {
      body = new URLSearchParams(req.body as Record<string, string>).toString();
    } else if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
    }
  }

  let response: globalThis.Response;
  try {
    response = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: `Failed to reach target: ${msg}` });
    return;
  }

  const finalUrl = response.url || targetUrl;
  const rawCT = response.headers.get("content-type") ?? "application/octet-stream";
  const isHtml = rawCT.includes("text/html");
  const isCss = rawCT.includes("text/css");

  let bodyBuffer = Buffer.from(await response.arrayBuffer());
  let contentType = rawCT;

  if (isHtml) {
    const originalOrigin = new URL(finalUrl).origin;
    let html = bodyBuffer.toString("utf-8");
    html = rewriteHtml(html, finalUrl, originalOrigin);
    bodyBuffer = Buffer.from(html, "utf-8");
    contentType = "text/html; charset=utf-8";
    if (method === "GET") setCache(targetUrl, bodyBuffer, contentType, "html");
  } else if (isCss) {
    let css = bodyBuffer.toString("utf-8");
    css = rewriteCss(css, finalUrl);
    bodyBuffer = Buffer.from(css, "utf-8");
    if (method === "GET") setCache(targetUrl, bodyBuffer, rawCT, "css");
  } else if (method === "GET") {
    setCache(targetUrl, bodyBuffer, rawCT, "default");
  }

  for (const h of BLOCKED_RESPONSE_HEADERS) res.removeHeader(h);
  res.set("Content-Type", contentType);
  res.set("Content-Length", String(bodyBuffer.length));
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("X-Proxy-Cache", "MISS");
  res.status(response.status).send(bodyBuffer);
}

// ── Routes ────────────────────────────────────────────────────────────────────

function parseTarget(req: Request, res: Response): string | null {
  const rawUrl = req.query["url"];
  if (!rawUrl || typeof rawUrl !== "string") {
    res.status(400).json({ error: "Missing url query parameter" });
    return null;
  }
  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }
  try { new URL(targetUrl); } catch {
    res.status(400).json({ error: "Invalid URL" });
    return null;
  }
  return targetUrl;
}

router.options("/proxy", (_req, res): void => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "*");
  res.sendStatus(204);
});

router.get("/proxy", async (req, res): Promise<void> => {
  const t = parseTarget(req, res); if (!t) return;
  await proxyRequest(req as unknown as Request, res, t);
});

router.post("/proxy", async (req, res): Promise<void> => {
  const t = parseTarget(req, res); if (!t) return;
  await proxyRequest(req as unknown as Request, res, t);
});

router.put("/proxy", async (req, res): Promise<void> => {
  const t = parseTarget(req, res); if (!t) return;
  await proxyRequest(req as unknown as Request, res, t);
});

router.patch("/proxy", async (req, res): Promise<void> => {
  const t = parseTarget(req, res); if (!t) return;
  await proxyRequest(req as unknown as Request, res, t);
});

router.delete("/proxy", async (req, res): Promise<void> => {
  const t = parseTarget(req, res); if (!t) return;
  await proxyRequest(req as unknown as Request, res, t);
});

router.get("/proxy/status", (_req, res): void => {
  res.json({ engine: "transparent-proxy", cacheSize: cache.size });
});

export default router;
