import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3002;
const DB_URL = process.env.DB_URL || 'http://127.0.0.1:3001';
const TRACEROUTE_TARGET = process.env.TRACEROUTE_TARGET || '1.1.1.1';

app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));

// ── Rate Limiting ───────────────────────────────────────────────
const rateLimits = new Map();
const RATE_WINDOW = 60_000;       // 1 minute window
const MAX_TESTS_PER_MIN = 3;     // max 3 tests per minute per IP
const MAX_DOWNLOADS_PER_MIN = 200; // max 200 download chunks per minute (parallel streams)
const BLOCK_DURATION = 300_000;   // 5 min ban after abuse

function getClientIp(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').replace('::ffff:', '').trim();
}

function checkRate(ip, bucket, max) {
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  let entry = rateLimits.get(key);

  if (!entry || now - entry.windowStart > RATE_WINDOW) {
    entry = { count: 0, windowStart: now, blocked: false, blockUntil: 0 };
    rateLimits.set(key, entry);
  }

  if (entry.blocked && now < entry.blockUntil) {
    return false;
  }

  entry.count++;
  if (entry.count > max * 2) {
    entry.blocked = true;
    entry.blockUntil = now + BLOCK_DURATION;
    console.warn(`[RATE] Blocked ${ip} on ${bucket} for ${BLOCK_DURATION / 1000}s (${entry.count} requests)`);
    return false;
  }

  return entry.count <= max;
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now - entry.windowStart > RATE_WINDOW && (!entry.blocked || now > entry.blockUntil)) {
      rateLimits.delete(key);
    }
  }
}, 300_000);

// Global rate limit middleware for API
function rateLimit(bucket, max) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    if (!checkRate(ip, bucket, max)) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

app.use(express.static(path.join(__dirname, '../public')));

// Pre-generate large buffer (reusable, zero CPU per request)
const DOWNLOAD_BUFFER = crypto.randomBytes(1_000_000);

// ── Ping ────────────────────────────────────────────────────────
app.get('/api/ping', rateLimit('ping', 60), (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Connection': 'keep-alive' });
  res.send('');
});

// ── Download ────────────────────────────────────────────────────
app.get('/api/download', rateLimit('download', MAX_DOWNLOADS_PER_MIN), (req, res) => {
  const size = Math.min(parseInt(req.query.size) || 1_000_000, 25_000_000);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive'
  });
  let remaining = size;
  function sendChunk() {
    while (remaining > 0) {
      const len = Math.min(DOWNLOAD_BUFFER.length, remaining);
      const chunk = len === DOWNLOAD_BUFFER.length ? DOWNLOAD_BUFFER : DOWNLOAD_BUFFER.subarray(0, len);
      remaining -= len;
      if (!res.write(chunk)) {
        res.once('drain', sendChunk);
        return;
      }
    }
    res.end();
  }
  sendChunk();
});

// ── Upload ──────────────────────────────────────────────────────
app.post('/api/upload', rateLimit('upload', 200), (req, res) => {
  const bytes = req.body ? req.body.length : 0;
  res.json({ bytes });
});

// ── Traceroute ──────────────────────────────────────────────────
app.get('/api/traceroute', rateLimit('traceroute', 3), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `tracert -d -h 30 -w 2000 ${TRACEROUTE_TARGET}`
      : `traceroute -n -m 30 -w 2 ${TRACEROUTE_TARGET}`;
    const { stdout } = await execAsync(cmd, { timeout: 60000 });
    const hops = parseTraceroute(stdout, isWin);
    res.json({ target: TRACEROUTE_TARGET, hops });
  } catch (err) {
    res.status(500).json({ error: 'Traceroute failed', detail: err.message });
  }
});

function parseTraceroute(output, isWin) {
  const lines = output.split('\n');
  const hops = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const hopNum = parseInt(match[1]);
    const rest = match[2].trim();
    if (rest === '* * *') { hops.push({ hop: hopNum, ip: null, rtt: null }); continue; }
    if (isWin) {
      const parts = rest.split(/\s+/);
      const ip = parts[parts.length - 1];
      if (!ip || ip === '*') { hops.push({ hop: hopNum, ip: null, rtt: null }); continue; }
      const rtts = parts.slice(0, -1).filter(p => p !== 'ms' && p !== '*' && !isNaN(parseInt(p))).map(Number);
      hops.push({ hop: hopNum, ip: ip === '*' ? null : ip, rtt: rtts.length ? rtts.reduce((a, b) => a + b) / rtts.length : null });
    } else {
      const ipMatch = rest.match(/^(\d+\.\d+\.\d+\.\d+)/);
      const rtts = [...rest.matchAll(/([\d.]+)\s*ms/g)].map(m => parseFloat(m[1]));
      hops.push({ hop: hopNum, ip: ipMatch?.[1] || null, rtt: rtts.length ? rtts.reduce((a, b) => a + b) / rtts.length : null });
    }
  }
  return hops;
}

// ── IP lookup ───────────────────────────────────────────────────
async function lookupIp(ip) {
  try {
    const cleanIp = ip.replace('::ffff:', '');
    if (!cleanIp || cleanIp === '127.0.0.1' || cleanIp.startsWith('192.168.') || cleanIp.startsWith('10.') || cleanIp.startsWith('172.')) {
      return { isp: 'Local Network', city: 'Local', country: '', lat: null, lon: null };
    }
    const resp = await fetch(`http://ip-api.com/json/${cleanIp}?fields=isp,city,country,lat,lon`);
    if (resp.ok) return await resp.json();
  } catch {}
  return { isp: 'Unknown', city: 'Unknown', country: 'Unknown', lat: null, lon: null };
}

// ── Geo-lookup for hops ─────────────────────────────────────────
app.post('/api/geo-hops', rateLimit('geo', 5), async (req, res) => {
  const { ips } = req.body;
  if (!Array.isArray(ips)) return res.status(400).json({ error: 'ips array required' });
  const unique = [...new Set(ips.filter(Boolean))].slice(0, 30);
  const results = {};
  for (const ip of unique) {
    results[ip] = await lookupIp(ip);
  }
  res.json(results);
});

// ── Save result ─────────────────────────────────────────────────
app.post('/api/result', rateLimit('result', MAX_TESTS_PER_MIN), async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const ipInfo = await lookupIp(clientIp);

    const payload = {
      download_mbps: req.body.download_mbps,
      upload_mbps: req.body.upload_mbps,
      ping_ms: req.body.ping_ms,
      jitter_ms: req.body.jitter_ms,
      client_ip: clientIp,
      isp: ipInfo.isp || 'Unknown',
      server_ip: req.body.server_ip || null,
      user_agent: req.headers['user-agent'] || '',
      location: ipInfo.city && ipInfo.country ? `${ipInfo.city}, ${ipInfo.country}` : ipInfo.city || 'Unknown',
      connection_type: req.body.connection_type || null,
      downlink_hint: req.body.downlink_hint || null,
      rtt_hint: req.body.rtt_hint || null,
      duration_s: req.body.duration_s || null,
      download_bytes: req.body.download_bytes || null,
      upload_bytes: req.body.upload_bytes || null
    };

    console.log(`[SAVE] ${clientIp} | DL:${payload.download_mbps} UL:${payload.upload_mbps} Ping:${payload.ping_ms} → ${DB_URL}/speedtest_results`);

    const dbRes = await fetch(`${DB_URL}/speedtest_results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(payload)
    });

    if (!dbRes.ok) {
      const errText = await dbRes.text();
      console.error(`[SAVE FAIL] ${dbRes.status}: ${errText}`);
      return res.status(500).json({ error: 'DB save failed', status: dbRes.status, detail: errText });
    }

    const saved = await dbRes.json();
    console.log(`[SAVE OK] id:${saved[0]?.id}`);
    res.json({ saved: true, id: saved[0]?.id });
  } catch (err) {
    console.error(`[SAVE ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('{*path}', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  speed v1.1 | :${PORT} | DB: ${DB_URL} | trace: ${TRACEROUTE_TARGET}\n`);
});
