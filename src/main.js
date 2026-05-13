import { proxyFetch } from './crypto.js';

// ─── Config (injected at build time via Vite env vars) ────────────────────────
const WORKER_URL = import.meta.env.VITE_WORKER_URL || 'https://cbp-splash.up.railway.app/api/proxy';

// ─── State ────────────────────────────────────────────────────────────────────
let currentUrl  = '';
let history     = [];
let isLoading   = false;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const urlBar      = document.getElementById('url-bar');
const goBtn       = document.getElementById('go-btn');
const backBtn     = document.getElementById('back-btn');
const fwdBtn      = document.getElementById('fwd-btn');
const refreshBtn  = document.getElementById('refresh-btn');
const frame       = document.getElementById('proxy-frame');
const statusEl    = document.getElementById('status-msg');
const loadingBar  = document.getElementById('loading-bar');
const addrDisplay = document.getElementById('addr-display');

// ─── Navigation ───────────────────────────────────────────────────────────────
async function navigate(url) {
  if (!url) return;
  if (!url.startsWith('http')) url = 'https://' + url;

  setLoading(true);
  setStatus('Fetching & Decrypting…');

  try {
    const result = await proxyFetch(WORKER_URL, url);
    const { status, headers, bodyBase64, finalUrl } = result;

    const ct   = headers?.['content-type'] || '';
    const body = atob(bodyBase64);

    if (ct.includes('text/html')) {
      // Write into iframe
      const doc = frame.contentDocument || frame.contentWindow.document;
      doc.open();
      const baseUrl = finalUrl || url;
      const interceptScript = `
        <base href="${baseUrl}">
        <script>
          document.addEventListener('click', function(e) {
            const a = e.target.closest('a');
            if (a && a.href && !a.href.startsWith('javascript:')) {
              e.preventDefault();
              window.parent.postMessage({type: 'cbp-nav', url: a.href}, '*');
            }
          }, true);
          document.addEventListener('submit', function(e) {
            e.preventDefault();
            const form = e.target;
            if (form.method.toLowerCase() === 'get') {
              const u = new URL(form.action);
              const fd = new FormData(form);
              for (const [k, v] of fd) u.searchParams.append(k, v);
              window.parent.postMessage({type: 'cbp-nav', url: u.href}, '*');
            }
          }, true);
        </script>
      `;
      let outHtml = body;
      if (/<head[^>]*>/i.test(outHtml)) {
        outHtml = outHtml.replace(/(<head[^>]*>)/i, '$1\\n' + interceptScript);
      } else {
        outHtml = interceptScript + outHtml;
      }
      doc.write(outHtml);
      doc.close();
      currentUrl = baseUrl;
      urlBar.value = currentUrl;
      addrDisplay.textContent = currentUrl;
      history.push(currentUrl);
      setStatus(`${status} — ${ct}`);
    } else if (ct.includes('application/json') || ct.includes('text/')) {
      // Display as text
      const doc = frame.contentDocument || frame.contentWindow.document;
      doc.open();
      doc.write(`<pre style="font-family:monospace;padding:1rem;white-space:pre-wrap;">${escHtml(body)}</pre>`);
      doc.close();
      setStatus(`${status} — ${ct}`);
    } else {
      // Binary: offer download
      const blob = new Blob([Uint8Array.from(body, c => c.charCodeAt(0))], { type: ct });
      const a    = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = url.split('/').pop() || 'download';
      a.click();
      setStatus(`Downloaded: ${a.download}`);
    }
  } catch (e) {
    setStatus('Error: ' + e.message);
    const doc = frame.contentDocument || frame.contentWindow.document;
    doc.open();
    doc.write(`<div style="padding:2rem;font-family:sans-serif;color:#f55">
      <h2>Proxy Error</h2><p>${escHtml(e.message)}</p>
    </div>`);
    doc.close();
  } finally {
    setLoading(false);
  }
}

function setLoading(v) {
  isLoading = v;
  loadingBar.style.width = v ? '80%' : '100%';
  setTimeout(() => { if (!v) loadingBar.style.width = '0'; }, v ? 0 : 400);
  goBtn.disabled = v;
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function escHtml(str) {
  return str.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ─── Events ───────────────────────────────────────────────────────────────────
goBtn.addEventListener('click', () => navigate(urlBar.value.trim()));
urlBar.addEventListener('keydown', e => { if (e.key === 'Enter') navigate(urlBar.value.trim()); });

backBtn.addEventListener('click', () => {
  if (history.length > 1) { history.pop(); navigate(history[history.length - 1]); }
});
refreshBtn.addEventListener('click', () => { if (currentUrl) navigate(currentUrl); });
fwdBtn.addEventListener('click', () => {
  setStatus('Forward history not tracked.');
});

// Handle navigation messages from inside the iframe
window.addEventListener('message', e => {
  if (e.data?.type === 'cbp-nav' && e.data.url) {
    urlBar.value = e.data.url;
    navigate(e.data.url);
  }
});
