// crypto.js – ECDH key exchange (no shared secret needed)
// Frontend generates an ephemeral key pair per request, server has a static key pair.

let serverPubKey = null; // CryptoKey
let pubkeyBaseUrl = null;

/**
 * Fetch the server's ECDH public key. Called automatically on first request.
 */
async function ensureServerKey(workerUrl) {
  if (serverPubKey) return;
  const base = workerUrl.replace(/\/api\/proxy\/?$/, '');
  pubkeyBaseUrl = base;
  const res = await fetch(`${base}/api/pubkey`);
  if (!res.ok) throw new Error('Failed to fetch server public key');
  const { publicKey } = await res.json();
  const raw = Uint8Array.from(atob(publicKey), c => c.charCodeAt(0));
  serverPubKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []
  );
}

/**
 * Invalidate cached server key (call on decryption failure to handle server restarts).
 */
function resetServerKey() {
  serverPubKey = null;
}

/**
 * Derive AES-256-GCM key from ECDH shared secret.
 */
async function deriveAESKey(privateKey) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: serverPubKey }, privateKey, 256
  );
  const hash = await crypto.subtle.digest('SHA-256', bits);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * Encrypt request: returns Uint8Array = [65-byte pubkey][12-byte IV][ciphertext+tag]
 */
async function encryptRequest(data) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const clientPubRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', keyPair.publicKey)
  );
  const aesKey = await deriveAESKey(keyPair.privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(data));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain);
  const cipherBytes = new Uint8Array(cipher);

  // [clientPub 65] [iv 12] [ciphertext+tag]
  const out = new Uint8Array(clientPubRaw.length + iv.length + cipherBytes.length);
  out.set(clientPubRaw, 0);
  out.set(iv, clientPubRaw.length);
  out.set(cipherBytes, clientPubRaw.length + iv.length);
  return { body: out, aesKey };
}

/**
 * Decrypt response: input is Uint8Array = [12-byte IV][ciphertext+tag]
 */
async function decryptResponseBytes(encBytes, aesKey) {
  const iv = encBytes.slice(0, 12);
  const ciphertext = encBytes.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * Send an encrypted proxy request. No secret needed — uses ECDH key exchange.
 */
export async function proxyFetch(workerUrl, target, method = 'GET', headers = {}, bodyBase64) {
  await ensureServerKey(workerUrl);

  const requestData = { method, target, headers, bodyBase64 };
  const { body, aesKey } = await encryptRequest(requestData);

  const res = await fetch(`${workerUrl}`, {
    method: 'POST',
    body: body,
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  if (!res.ok) {
    const text = await res.text();
    // If 400 decryption error, server may have restarted — reset key and retry once
    if (res.status === 400 && text.includes('Decryption')) {
      resetServerKey();
      await ensureServerKey(workerUrl);
      const retry = await encryptRequest(requestData);
      const res2 = await fetch(`${workerUrl}`, {
        method: 'POST',
        body: retry.body,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (!res2.ok) throw new Error(`Proxy error ${res2.status}: ${await res2.text()}`);
      const encResp = new Uint8Array(await res2.arrayBuffer());
      return decryptResponseBytes(encResp, retry.aesKey);
    }
    throw new Error(`Proxy error ${res.status}: ${text}`);
  }

  const encryptedResponse = new Uint8Array(await res.arrayBuffer());
  return decryptResponseBytes(encryptedResponse, aesKey);
}
