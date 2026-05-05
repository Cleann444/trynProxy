import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

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

// Resource cache: url -> { body, contentType, ts }
const CACHE_TTL: Record<string, number> = {
  html: 30_000,
  css: 120_000,
  default: 300_000,
};

interface CacheEntry {
  body: Buffer;
  contentType: string;
  ts: number;
  kind: string;
}

const cache = new Map<string, CacheEntry>();

function getCached(url: string): CacheEntry | null {
  const entry = cache.get(url);
  if (!entry) return null;
  const ttl = CACHE_TTL[entry.kind] ?? CACHE_TTL.default;
  if (Date.now() - entry.ts > ttl) { cache.delete(url); return null; }
  return entry;
}

function setCache(url: string, body: Buffer, contentType: string, kind: string): void {
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
  cache.set(url, { body, contentType, ts: Date.now(), kind });
}

function proxyHref(href: string, base: string): string {
  try {
    const abs = new URL(href, base).href;
    return `/api/proxy?url=${encodeURIComponent(abs)}`;
  } catch {
    return href;
  }
}

function rewriteHtml(html: string, finalUrl: string): string {
  const origin = new URL(finalUrl).origin;

  // <a> and <area> stay in proxy
  html = html.replace(
    /(<(?:a|area)\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, href) => {
      if (/^(javascript:|mailto:|tel:|#)/i.test(href)) return m;
      return `${pre}${q}${proxyHref(href, finalUrl)}${q}`;
    }
  );

  // <form action> stays in proxy
  html = html.replace(
    /(<form\b[^>]*?\baction\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, action) => `${pre}${q}${proxyHref(action, finalUrl)}${q}`
  );

  // All src / href on resource tags → absolute (loaded by browser directly from origin)
  html = html.replace(
    /(<(?:script|img|source|track|input)\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, src) => {
      if (/^(data:|blob:|https?:|\/\/)/i.test(src)) return m;
      try { return `${pre}${q}${new URL(src, finalUrl).href}${q}`; } catch { return m; }
    }
  );
  html = html.replace(
    /(<link\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (m, pre, q, href) => {
      if (/^(data:|blob:|https?:|\/\/)/i.test(href)) return m;
      try { return `${pre}${q}${new URL(href, finalUrl).href}${q}`; } catch { return m; }
    }
  );

  // Ensure a <base> tag so relative URLs from inline JS resolve correctly
  if (!/<base\b/i.test(html)) {
    html = html.replace(/(<head\b[^>]*>)/i, `$1<base href="${origin}/">`);
  }

  // Inject parent-frame communication script
  const inject = `<script>(function(){try{if(window.parent&&window.parent!==window){window.parent.postMessage({type:'proxy-url',url:location.href},'*');}}catch(e){}})();</script>`;
  html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, inject + "</head>") : inject + html;

  return html;
}

function rewriteCss(css: string, finalUrl: string): string {
  // Resolve relative url() references in CSS to absolute
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, src) => {
    if (/^(data:|blob:|https?:|\/\/)/i.test(src)) return m;
    try { return `url(${q}${new URL(src, finalUrl).href}${q})`; } catch { return m; }
  });
}

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

router.get("/proxy", async (req, res): Promise<void> => {
  const rawUrl = req.query["url"];
  if (!rawUrl || typeof rawUrl !== "string") {
    res.status(400).json({ error: "Missing url query parameter" });
    return;
  }

  let targetUrl = rawUrl.trim();
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  try { new URL(targetUrl); } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  // Serve from cache
  const cached = getCached(targetUrl);
  if (cached) {
    for (const h of BLOCKED_RESPONSE_HEADERS) res.removeHeader(h);
    res.set("Content-Type", cached.contentType);
    res.set("Access-Control-Allow-Origin", "*");
    res.set("X-Proxy-Cache", "HIT");
    res.send(cached.body);
    return;
  }

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      redirect: "follow",
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err, targetUrl }, "Proxy fetch failed");
    res.status(502).json({ error: `Failed to reach ${targetUrl}: ${msg}` });
    return;
  }

  const finalUrl = response.url || targetUrl;
  const rawContentType = response.headers.get("content-type") ?? "application/octet-stream";
  const isHtml = rawContentType.includes("text/html");
  const isCss = rawContentType.includes("text/css");
  const isText = isHtml || isCss || rawContentType.includes("text/");

  let bodyBuffer: Buffer;
  try {
    bodyBuffer = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    req.log.error({ err, targetUrl }, "Failed to read response body");
    res.status(502).json({ error: "Failed to read response from target" });
    return;
  }

  let contentType = rawContentType;

  if (isHtml) {
    let html = bodyBuffer.toString("utf-8");
    html = rewriteHtml(html, finalUrl);
    bodyBuffer = Buffer.from(html, "utf-8");
    contentType = "text/html; charset=utf-8";
    setCache(targetUrl, bodyBuffer, contentType, "html");
  } else if (isCss) {
    let css = bodyBuffer.toString("utf-8");
    css = rewriteCss(css, finalUrl);
    bodyBuffer = Buffer.from(css, "utf-8");
    setCache(targetUrl, bodyBuffer, contentType, "css");
  } else {
    setCache(targetUrl, bodyBuffer, contentType, "default");
  }

  for (const h of BLOCKED_RESPONSE_HEADERS) res.removeHeader(h);
  res.set("Content-Type", contentType);
  res.set("Content-Length", String(bodyBuffer.length));
  res.set("Access-Control-Allow-Origin", "*");
  res.set("X-Proxy-Cache", "MISS");
  res.set("X-Proxy-Engine", "direct");
  if (!isText) {
    res.set("Cache-Control", "public, max-age=3600");
  }

  req.log.info({ targetUrl, finalUrl, status: response.status }, "Proxied");
  res.status(response.status).send(bodyBuffer);
});

router.get("/proxy/status", (_req, res): void => {
  res.json({ engine: "direct", cacheSize: cache.size });
});

export default router;
