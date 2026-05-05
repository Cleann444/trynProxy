import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_BROWSER_URL = CF_ACCOUNT_ID
  ? `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-rendering/content`
  : null;

const BLOCKED_HEADERS = [
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

function rewriteLinks(html: string, targetUrl: string, proxyBase: string): string {
  const url = new URL(targetUrl);
  const origin = url.origin;
  const proxyPrefix = `${proxyBase}?url=`;

  function toProxiedUrl(href: string): string {
    try {
      const absolute = new URL(href, targetUrl).href;
      return proxyPrefix + encodeURIComponent(absolute);
    } catch {
      return href;
    }
  }

  // Rewrite <a> and <area> href to stay in proxy
  html = html.replace(
    /(<(?:a|area)\s[^>]*\bhref\s*=\s*)(["'])([^"']*)\2/gi,
    (match, pre, quote, href) => {
      if (
        href.startsWith("javascript:") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("#")
      ) {
        return match;
      }
      return `${pre}${quote}${toProxiedUrl(href)}${quote}`;
    }
  );

  // Resolve relative asset URLs to absolute
  html = html.replace(
    /(<(?:link|script|img|source|input|track)\s[^>]*\b(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi,
    (match, pre, quote, src) => {
      if (src.startsWith("data:") || src.startsWith("blob:") || src.startsWith("http")) return match;
      try {
        const absolute = new URL(src, targetUrl).href;
        return `${pre}${quote}${absolute}${quote}`;
      } catch {
        return match;
      }
    }
  );

  // Rewrite form actions
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

  // Inject base tag if missing
  if (!/<base\s/i.test(html)) {
    html = html.replace(/(<head[^>]*>)/i, `$1<base href="${origin}/">`);
  }

  return html;
}

function injectScript(html: string, finalUrl: string): string {
  const script = `<script>(function(){if(window.parent&&window.parent!==window){window.parent.postMessage({type:'proxy-url',url:${JSON.stringify(finalUrl)}},'*');}})();</script>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/(<\/head>)/i, script + "$1");
  }
  return script + html;
}

async function fetchWithCloudflare(targetUrl: string): Promise<string> {
  if (!CF_BROWSER_URL || !CF_API_TOKEN) {
    throw new Error("Cloudflare not configured");
  }

  const resp = await fetch(CF_BROWSER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: targetUrl,
      rejectResourceTypes: ["image", "media", "font"],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Cloudflare Browser Rendering error ${resp.status}: ${text}`);
  }

  const data = await resp.json() as { success: boolean; result?: string; errors?: { message: string }[] };
  if (!data.success || typeof data.result !== "string") {
    const errMsg = data.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
    throw new Error(`Cloudflare returned failure: ${errMsg}`);
  }

  return data.result;
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

  if (!CF_BROWSER_URL || !CF_API_TOKEN) {
    res.status(503).json({ error: "Cloudflare Browser Rendering is not configured." });
    return;
  }

  let html = "";
  const finalUrl = targetUrl;

  try {
    html = await fetchWithCloudflare(targetUrl);
    req.log.info({ targetUrl }, "Fetched via Cloudflare Browser Rendering");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    req.log.error({ err, targetUrl }, "Cloudflare fetch failed");
    res.status(502).json({ error: `Cloudflare failed to load page: ${message}` });
    return;
  }

  html = rewriteLinks(html, finalUrl, "/api/proxy");
  html = injectScript(html, finalUrl);

  res.set("Content-Type", "text/html; charset=utf-8");
  res.set("Access-Control-Allow-Origin", "*");
  res.set("X-Proxy-Final-Url", finalUrl);
  res.set("X-Proxy-Engine", "cloudflare-browser");
  for (const h of BLOCKED_HEADERS) {
    res.removeHeader(h);
  }
  res.send(html);
});

// Endpoint to check proxy status / config
router.get("/proxy/status", (_req, res): void => {
  res.json({
    cloudflare: !!CF_BROWSER_URL && !!CF_API_TOKEN,
    accountId: CF_ACCOUNT_ID ? CF_ACCOUNT_ID.slice(0, 6) + "…" : null,
  });
});

export default router;
