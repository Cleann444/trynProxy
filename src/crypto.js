// crypto.js – matches the Worker's encryption (AES-GCM, SHA-256, binary)
const WORKER_URL = 'https://cbp-v2.ooogeust22.workers.dev/api/proxy';
const SECRET = 'EgucmYfFNGwb5xonPr3UIWTdszRLayXthq12897eC46VMDOk'; // must match worker's SECRET

async function getKey(epoch) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${SECRET}:${epoch}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptObject(obj, epoch) {
  const plain = JSON.stringify(obj);
  const plainBytes = new TextEncoder().encode(plain);
  const key = await getKey(epoch);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plainBytes);
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.length);
  return result;
}

async function decryptResponse(encryptedBytes, epoch) {
  const iv = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12);
  const key = await getKey(epoch);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  const json = new TextDecoder().decode(decrypted);
  return JSON.parse(json);
}

export async function proxyFetch(workerUrl, secret, target, method = 'GET', headers = {}, bodyBase64) {
  // secret is ignored – we use the hardcoded SECRET for simplicity. In production, use the passed secret.
  const epoch = Math.floor(Date.now() / 600000);
  const requestObj = { method, target, headers, bodyBase64 };
  const encrypted = await encryptObject(requestObj, epoch);
  const response = await fetch(workerUrl, { method: 'POST', body: encrypted, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Worker error ${response.status}: ${text}`);
  }
  const encryptedResponse = new Uint8Array(await response.arrayBuffer());
  const responseObj = await decryptResponse(encryptedResponse, epoch);
  // responseObj contains { status, headers, bodyBase64, finalUrl? }
  return responseObj;
}
