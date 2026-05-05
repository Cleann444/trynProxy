import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function rewriteLinks(html: string, targetUrl: string, proxyBase: string): string {
  const url = new URL(targetUrl);
  const origin = url.origin;
  const base = `${url.protocol}//${url.host}`;

  const proxyPrefix = `${proxyBase}?url=`;

  function toProxiedUrl(href: string): string {
    try {
      const absolute = new URL(href, targetUrl).href;
      return proxyPrefix + encodeURIComponent(absolute);
    } catch {
      return href;
    }
  }

  html = html.replace(
    /(<(?:a|area)\s[^>]*\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (match, pre, quote, href) => {
      if (href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) {
        return match;
      }
      return `${pre}${quote}${toProxiedUrl(href)}${quote}`;
    }
  );

  html = html.replace(
    /(<(?:link|script|img|source|input|track)\s[^>]*\b(?:src|href|action)\s*=\s*)(["'])([^"']*)\2/gi,
    (match, pre, quote, src) => {
      if (src.startsWith("data:") || src.startsWith("blob:")) return match;
      try {
        const absolute = new URL(src, targetUrl).href;
        return `${pre}${quote}${absolute}${quote}`;
      } catch {
        return match;
      }
    }
  );

  html = html.replace(
    /(<form\s[^>]*\baction\s*=\s*)(["'])([^"']*)\2/gi,
    (match, pre, quote, action) => {
      try {
        const absolute = new URL(action, targetUrl).href;
        return `${pre}${quote}${proxyPrefix}${encodeURIComponent(absolute)}${quote}`;
      } catch {
        return match;
      }
    }
  );

  if (!/<base\s/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1<base href="${origin}/">`);
  }

  return html;
}

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

  try {
    new URL(targetUrl);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  req.log.info({ targetUrl }, "Proxying request");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "identity",
        "Cache-Control": "no-cache",
      },
    });

    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") ?? "text/html";
    const finalUrl = response.url || targetUrl;

    if (!contentType.includes("text/html")) {
      const buffer = await response.arrayBuffer();
      res.set("Content-Type", contentType);
      res.set("Access-Control-Allow-Origin", "*");
      res.send(Buffer.from(buffer));
      return;
    }

    let html = await response.text();

    const proxyBase = "/api/proxy";
    html = rewriteLinks(html, finalUrl, proxyBase);

    const injectedScript = `
<script>
(function() {
  window.__proxyFinalUrl = ${JSON.stringify(finalUrl)};
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'proxy-url', url: ${JSON.stringify(finalUrl)} }, '*');
  }
})();
</script>`;
    html = html.replace(/(<\/head>)/i, injectedScript + "$1");
    if (!html.includes("</head>")) {
      html = injectedScript + html;
    }

    res.set("Content-Type", "text/html; charset=utf-8");
    res.set("Access-Control-Allow-Origin", "*");
    res.set("X-Proxy-Final-Url", finalUrl);
    res.set("X-Frame-Options", "ALLOWALL");
    res.removeHeader("Content-Security-Policy");
    res.send(html);
  } catch (err: unknown) {
    clearTimeout(timeout);
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err, targetUrl }, "Proxy fetch failed");

    if (message.includes("abort") || message.includes("AbortError")) {
      res.status(504).json({ error: "Request timed out" });
      return;
    }
    res.status(502).json({ error: `Failed to fetch: ${message}` });
  }
});

export default router;
