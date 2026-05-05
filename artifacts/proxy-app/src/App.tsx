import { useState, useRef, useCallback, useEffect } from "react";

type Theme = "dark" | "light";
type Status = "idle" | "loading" | "success" | "error";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}

function proxyUrl(url: string): string {
  return `${BASE}/api/proxy?url=${encodeURIComponent(url)}`;
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("proxy-theme") as Theme) ?? "dark";
    }
    return "dark";
  });
  const [inputUrl, setInputUrl] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [pageTitle, setPageTitle] = useState("");
  const [engine, setEngine] = useState<"cloudflare-browser" | "direct" | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("proxy-theme", theme);
  }, [theme]);

  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === "proxy-url" && typeof e.data.url === "string") {
        setCurrentUrl(e.data.url);
        setInputUrl(e.data.url);
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  const navigate = useCallback((url: string, pushHistory = true) => {
    if (!url) return;
    const normalized = normalizeUrl(url);
    setInputUrl(normalized);
    setCurrentUrl(normalized);
    setStatus("loading");
    setErrorMsg("");
    setPageTitle("");
    setEngine(null);

    if (pushHistory) {
      setHistory((prev) => {
        const newHist = prev.slice(0, historyIndex + 1);
        newHist.push(normalized);
        return newHist;
      });
      setHistoryIndex((prev) => prev + 1);
    }

    if (iframeRef.current) {
      iframeRef.current.src = proxyUrl(normalized);
    }
  }, [historyIndex]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(inputUrl);
  };

  const handleBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      navigate(history[newIndex], false);
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      navigate(history[newIndex], false);
    }
  };

  const handleRefresh = () => {
    if (currentUrl) navigate(currentUrl, false);
  };

  const handleHome = () => {
    setStatus("idle");
    setCurrentUrl("");
    setInputUrl("");
    setPageTitle("");
    if (iframeRef.current) iframeRef.current.src = "about:blank";
  };

  const handleIframeLoad = () => {
    if (!currentUrl) return;
    setStatus("success");
    try {
      const title = iframeRef.current?.contentDocument?.title;
      if (title) setPageTitle(title);
    } catch {}
    fetch(`${BASE}/api/proxy?url=${encodeURIComponent(currentUrl)}`, { method: "HEAD" })
      .then((r) => {
        const eng = r.headers.get("X-Proxy-Engine");
        if (eng === "cloudflare-browser" || eng === "direct") setEngine(eng);
      })
      .catch(() => {});
  };

  const handleIframeError = () => {
    setStatus("error");
    setErrorMsg("Failed to load the page. The site may block proxying.");
  };

  const dark = theme === "dark";

  const colors = {
    bg: dark ? "#0f1117" : "#f5f7fa",
    surface: dark ? "#1a1d27" : "#ffffff",
    surfaceAlt: dark ? "#22263a" : "#f0f2f5",
    border: dark ? "#2e3247" : "#dde1ea",
    text: dark ? "#e8eaf0" : "#1a1d27",
    textMuted: dark ? "#7b82a0" : "#6b7280",
    accent: "#4f7eff",
    accentHover: "#3a65e8",
    error: dark ? "#ff6b6b" : "#dc2626",
    success: dark ? "#4ade80" : "#16a34a",
    inputBg: dark ? "#111420" : "#ffffff",
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: colors.bg,
        color: colors.text,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "14px",
      }}
    >
      {/* Top bar */}
      <header
        style={{
          backgroundColor: colors.surface,
          borderBottom: `1px solid ${colors.border}`,
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          flexShrink: 0,
          boxShadow: dark ? "0 1px 6px rgba(0,0,0,0.4)" : "0 1px 4px rgba(0,0,0,0.06)",
        }}
      >
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <div
            style={{
              width: "28px",
              height: "28px",
              borderRadius: "8px",
              background: `linear-gradient(135deg, ${colors.accent}, #7c3aed)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "14px",
            }}
          >
            🌐
          </div>
          <span style={{ fontWeight: 700, fontSize: "13px", color: colors.accent, letterSpacing: "-0.02em" }}>
            WebProxy
          </span>
        </div>

        {/* Nav controls */}
        <div style={{ display: "flex", gap: "4px", flexShrink: 0 }}>
          {[
            { label: "←", title: "Back", action: handleBack, disabled: historyIndex <= 0 },
            { label: "→", title: "Forward", action: handleForward, disabled: historyIndex >= history.length - 1 },
            { label: "↺", title: "Refresh", action: handleRefresh, disabled: !currentUrl },
            { label: "⌂", title: "Home", action: handleHome, disabled: false },
          ].map((btn) => (
            <button
              key={btn.label}
              onClick={btn.action}
              disabled={btn.disabled}
              title={btn.title}
              style={{
                width: "30px",
                height: "30px",
                borderRadius: "6px",
                border: `1px solid ${colors.border}`,
                backgroundColor: colors.surfaceAlt,
                color: btn.disabled ? colors.textMuted : colors.text,
                cursor: btn.disabled ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "15px",
                transition: "all 0.15s ease",
                opacity: btn.disabled ? 0.4 : 1,
              }}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {/* URL input */}
        <form onSubmit={handleSubmit} style={{ flex: 1, display: "flex", gap: "8px" }}>
          <div style={{ flex: 1, position: "relative" }}>
            <div
              style={{
                position: "absolute",
                left: "10px",
                top: "50%",
                transform: "translateY(-50%)",
                color: status === "loading" ? colors.accent : status === "error" ? colors.error : status === "success" ? colors.success : colors.textMuted,
                fontSize: "12px",
                pointerEvents: "none",
                transition: "color 0.2s ease",
              }}
            >
              {status === "loading" ? "⟳" : status === "error" ? "✕" : status === "success" ? "🔒" : "🔗"}
            </div>
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              placeholder="Enter URL (e.g. https://example.com)"
              style={{
                width: "100%",
                height: "34px",
                borderRadius: "8px",
                border: `1.5px solid ${status === "error" ? colors.error : colors.border}`,
                backgroundColor: colors.inputBg,
                color: colors.text,
                padding: "0 12px 0 30px",
                fontSize: "13px",
                outline: "none",
                boxSizing: "border-box",
                transition: "border-color 0.15s ease",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = colors.accent;
                e.currentTarget.select();
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = status === "error" ? colors.error : colors.border;
              }}
            />
          </div>
          <button
            type="submit"
            style={{
              height: "34px",
              padding: "0 18px",
              borderRadius: "8px",
              border: "none",
              backgroundColor: colors.accent,
              color: "#fff",
              fontWeight: 600,
              fontSize: "13px",
              cursor: "pointer",
              flexShrink: 0,
              transition: "background-color 0.15s ease",
              letterSpacing: "0.01em",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = colors.accentHover)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = colors.accent)}
          >
            Go
          </button>
        </form>

        {/* Theme toggle */}
        <button
          onClick={() => setTheme(dark ? "light" : "dark")}
          title={dark ? "Switch to light mode" : "Switch to dark mode"}
          style={{
            width: "34px",
            height: "34px",
            borderRadius: "8px",
            border: `1px solid ${colors.border}`,
            backgroundColor: colors.surfaceAlt,
            color: colors.text,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "16px",
            flexShrink: 0,
          }}
        >
          {dark ? "☀️" : "🌙"}
        </button>
      </header>

      {/* Status bar */}
      {currentUrl && (
        <div
          style={{
            backgroundColor: colors.surfaceAlt,
            borderBottom: `1px solid ${colors.border}`,
            padding: "4px 16px",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "11px",
            color: colors.textMuted,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              display: "inline-block",
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor:
                status === "loading" ? "#f59e0b"
                : status === "error" ? colors.error
                : status === "success" ? colors.success
                : colors.textMuted,
              flexShrink: 0,
              animation: status === "loading" ? "pulse 1s infinite" : undefined,
            }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {status === "loading"
              ? `Connecting to ${currentUrl}…`
              : status === "error"
              ? errorMsg
              : pageTitle
              ? `${pageTitle} — ${currentUrl}`
              : currentUrl}
          </span>
          <span style={{ marginLeft: "auto", flexShrink: 0 }}>
            {status === "success" && "⚡ Cloudflare Browser Rendering"}
          </span>
        </div>
      )}

      {/* Main content */}
      <main style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {/* Iframe */}
        <iframe
          ref={iframeRef}
          src="about:blank"
          onLoad={handleIframeLoad}
          onError={handleIframeError}
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: currentUrl && status !== "error" ? "block" : "none",
            backgroundColor: "#fff",
          }}
          title="Proxy viewer"
        />

        {/* Loading overlay */}
        {status === "loading" && currentUrl && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundColor: dark ? "rgba(15,17,23,0.85)" : "rgba(245,247,250,0.85)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "16px",
            }}
          >
            <div
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "50%",
                border: `3px solid ${colors.border}`,
                borderTopColor: colors.accent,
                animation: "spin 0.8s linear infinite",
              }}
            />
            <div style={{ color: colors.textMuted, fontSize: "13px" }}>
              Fetching through proxy…
            </div>
          </div>
        )}

        {/* Error state */}
        {status === "error" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              padding: "24px",
            }}
          >
            <div style={{ fontSize: "48px" }}>⚠️</div>
            <div style={{ fontWeight: 700, fontSize: "18px", color: colors.text }}>
              Could not load page
            </div>
            <div style={{ color: colors.textMuted, textAlign: "center", maxWidth: "400px" }}>
              {errorMsg || "The site may block external proxies, use HTTPS-only content, or require JavaScript execution."}
            </div>
            <button
              onClick={handleRefresh}
              style={{
                marginTop: "8px",
                padding: "8px 20px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: colors.accent,
                color: "#fff",
                fontWeight: 600,
                cursor: "pointer",
                fontSize: "13px",
              }}
            >
              Try again
            </button>
          </div>
        )}

        {/* Idle / landing state */}
        {status === "idle" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "24px",
              padding: "24px",
            }}
          >
            <div
              style={{
                width: "72px",
                height: "72px",
                borderRadius: "20px",
                background: `linear-gradient(135deg, ${colors.accent}, #7c3aed)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "36px",
                boxShadow: `0 8px 24px ${dark ? "rgba(79,126,255,0.3)" : "rgba(79,126,255,0.2)"}`,
              }}
            >
              🌐
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 700, fontSize: "22px", marginBottom: "8px", letterSpacing: "-0.02em" }}>
                Web Proxy
              </div>
              <div style={{ color: colors.textMuted, fontSize: "14px", maxWidth: "360px", lineHeight: 1.6 }}>
                Enter any URL in the bar above to browse through the proxy. Links are automatically rewritten to stay within the proxy session.
              </div>
            </div>

            {/* Quick links */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", maxWidth: "480px" }}>
              {[
                "https://example.com",
                "https://wikipedia.org",
                "https://news.ycombinator.com",
                "https://httpbin.org",
              ].map((url) => (
                <button
                  key={url}
                  onClick={() => navigate(url)}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "20px",
                    border: `1px solid ${colors.border}`,
                    backgroundColor: colors.surfaceAlt,
                    color: colors.textMuted,
                    cursor: "pointer",
                    fontSize: "12px",
                    transition: "all 0.15s ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = colors.accent;
                    e.currentTarget.style.color = colors.accent;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = colors.border;
                    e.currentTarget.style.color = colors.textMuted;
                  }}
                >
                  {url.replace("https://", "")}
                </button>
              ))}
            </div>

            {/* Info box */}
            <div
              style={{
                padding: "14px 18px",
                borderRadius: "10px",
                backgroundColor: colors.surfaceAlt,
                border: `1px solid ${colors.border}`,
                maxWidth: "400px",
                width: "100%",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "8px", color: colors.text }}>
                How it works
              </div>
              <ul style={{ margin: 0, padding: "0 0 0 16px", color: colors.textMuted, fontSize: "12px", lineHeight: 1.8 }}>
                <li>Server-side fetching bypasses CORS restrictions</li>
                <li>Links are rewritten to route through the proxy</li>
                <li>Supports HTTP and HTTPS websites</li>
                <li>Some sites may block proxy access</li>
              </ul>
            </div>
          </div>
        )}
      </main>

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        * { box-sizing: border-box; }
        body { margin: 0; }
      `}</style>
    </div>
  );
}
