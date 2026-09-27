import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

const port = Number(process.env.PORT || 3000);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',').map((value) => value.trim()).filter(Boolean));
const apiKey = process.env.RESEND_API_KEY;
const recipient = process.env.CONTACT_TO;
const sender = process.env.CONTACT_FROM;
const windowMs = 60_000;
const limit = 5;
const requests = new Map();
const root = process.cwd();
const redisUrl = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

if (!apiKey || !recipient || !sender) {
  throw new Error('Set RESEND_API_KEY, CONTACT_TO, and CONTACT_FROM before starting the server.');
}
if (process.env.NODE_ENV === 'production' && (!redisUrl || !redisToken)) {
  throw new Error('Production requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for shared rate limiting.');
}

function send(res, status, body, headers = {}) {
  secureHeaders(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

function secureHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

async function servePage(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { return send(res, 400, { error: 'Invalid URL.' }); }
  if (pathname === '/') pathname = '/index.html';
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(root + sep) || pathname.split('/').some((part) => part.startsWith('.')) || !/\.(html|css|js|png|jpe?g|webp|svg|ico|pdf|woff2?)$/i.test(file)) {
    return send(res, 404, { error: 'Not found.' });
  }
  try {
    const content = await readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };
    secureHeaders(res);
    res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'cache-control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600' });
    return res.end(content);
  } catch { return send(res, 404, { error: 'Not found.' }); }
}

function cors(req, res) {
  const origin = req.headers.origin;
  const forwardedProto = req.headers['x-forwarded-proto']?.split(',')[0]?.trim() || 'http';
  let sameOrigin = false;
  try { sameOrigin = new URL(origin).origin === `${forwardedProto}://${req.headers.host}`; } catch { /* no Origin header */ }
  if (!origin || (!sameOrigin && !allowedOrigins.has(origin))) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  return true;
}

async function overRateLimit(ip) {
  if (!redisUrl || !redisToken) {
    const now = Date.now();
    const bucket = requests.get(ip);
    if (!bucket || now >= bucket.resetAt) { requests.set(ip, { count: 1, resetAt: now + windowMs }); return false; }
    return ++bucket.count > limit;
  }
  const key = `portfolio-contact:${createHash('sha256').update(ip).digest('hex')}`;
  const headers = { authorization: `Bearer ${redisToken}` };
  const result = await fetch(`${redisUrl}/incr/${key}`, { headers, signal: AbortSignal.timeout(3_000) });
  if (!result.ok) throw new Error('Rate limit service unavailable');
  const { result: count } = await result.json();
  if (count === 1) {
    const expiry = await fetch(`${redisUrl}/expire/${key}/${Math.ceil(windowMs / 1000)}`, { headers, signal: AbortSignal.timeout(3_000) });
    if (!expiry.ok) throw new Error('Rate limit expiry service unavailable');
  }
  return Number(count) > limit;
}

const server = createServer(async (req, res) => {
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('strict-transport-security', 'max-age=31536000');
  if (req.method === 'GET' && req.url !== '/healthz' && !req.url.startsWith('/api/')) return servePage(req, res);
  if (req.url === '/healthz' && req.method === 'GET') return send(res, 200, { status: 'ok' });
  if (req.url !== '/api/contact') return send(res, 404, { error: 'Not found.' });

  const origin = req.headers.origin;
  if (origin && !cors(req, res)) return send(res, 403, { error: 'Request origin is not allowed.' });
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' }, { allow: 'POST, OPTIONS' });

  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('application/json')) return send(res, 415, { error: 'Send a JSON request.' });

  const ip = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',').pop()?.trim() || req.socket.remoteAddress || 'unknown';
  let limited;
  try { limited = await overRateLimit(String(ip)); }
  catch (error) { console.error('Contact abuse protection unavailable:', error.message); return send(res, 503, { error: 'Contact service is temporarily unavailable.' }); }
  if (limited) return send(res, 429, { error: 'Too many messages. Please try again shortly.' }, { 'retry-after': '60' });

  if (Number(req.headers['content-length']) > 8_192) return send(res, 413, { error: 'Message is too large.' });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8_192) return send(res, 413, { error: 'Message is too large.' });
    chunks.push(chunk);
  }

  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'Invalid request.' }); }
  if (data && typeof data === 'object' && typeof data.website === 'string' && data.website.trim()) return send(res, 200, { ok: true });

  const name = typeof data?.name === 'string' ? data.name.trim() : '';
  const email = typeof data?.email === 'string' ? data.email.trim() : '';
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  if (name.length < 2 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || message.length < 10 || message.length > 5000) {
    return send(res, 400, { error: 'Enter a valid name, email address, and message (10–5000 characters).' });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: sender, to: [recipient], reply_to: email, subject: `Portfolio message from ${name}`, text: `Name: ${name}\nEmail: ${email}\n\n${message}` }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
    return send(res, 202, { ok: true, message: 'Message sent. Thank you for reaching out.' });
  } catch (error) {
    console.error('Contact delivery failed:', error.message);
    return send(res, 502, { error: 'We could not send your message right now. Please try again later.' });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Portfolio API listening on ${port}`));
