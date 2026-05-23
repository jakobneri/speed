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
const DB_URL = process.env.DB_URL || 'http://localhost:3001';
const TRACEROUTE_TARGET = process.env.TRACEROUTE_TARGET || '1.1.1.1';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Pre-generate random buffer (avoids crypto.randomBytes per request on Pi)
const DOWNLOAD_BUFFER = crypto.randomBytes(1_000_000);

// --- Ping endpoint ---
app.get('/api/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.send('');
});

// --- Download endpoint (serves pre-generated data, fast on Pi) ---
app.get('/api/download', (req, res) => {
  const size = Math.min(parseInt(req.query.size) || 1_000_000, 25_000_000);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'no-store'
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

// --- Upload endpoint ---
app.post('/api/upload', (req, res) => {
  const bytes = req.body ? req.body.length : 0;
  res.json({ bytes });
});

// --- Traceroute endpoint ---
app.get('/api/traceroute', async (req, res) => {
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

    if (isWin) {
      const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const hopNum = parseInt(match[1]);
      const rest = match[2].trim();
      const parts = rest.split(/\s+/);
      const ip = parts[parts.length - 1];
      if (!ip || ip === '*') {
        hops.push({ hop: hopNum, ip: null, rtt: null });
        continue;
      }
      const rtts = parts.slice(0, -1)
        .filter(p => p !== 'ms' && p !== '*' && !isNaN(parseInt(p)))
        .map(Number);
      const avgRtt = rtts.length > 0 ? rtts.reduce((a, b) => a + b) / rtts.length : null;
      hops.push({ hop: hopNum, ip: ip === '*' ? null : ip, rtt: avgRtt });
    } else {
      const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const hopNum = parseInt(match[1]);
      const rest = match[2].trim();
      if (rest === '* * *') {
        hops.push({ hop: hopNum, ip: null, rtt: null });
        continue;
      }
      const ipMatch = rest.match(/^(\d+\.\d+\.\d+\.\d+)/);
      const ip = ipMatch ? ipMatch[1] : null;
      const rtts = [...rest.matchAll(/([\d.]+)\s*ms/g)].map(m => parseFloat(m[1]));
      const avgRtt = rtts.length > 0 ? rtts.reduce((a, b) => a + b) / rtts.length : null;
      hops.push({ hop: hopNum, ip, rtt: avgRtt });
    }
  }
  return hops;
}

// --- IP info lookup ---
async function lookupIp(ip) {
  try {
    const cleanIp = ip.replace('::ffff:', '');
    if (cleanIp === '127.0.0.1' || cleanIp.startsWith('192.168.') || cleanIp.startsWith('10.') || cleanIp.startsWith('172.')) {
      return { isp: 'Local Network', city: 'Local', country: '', lat: null, lon: null };
    }
    const resp = await fetch(`http://ip-api.com/json/${cleanIp}?fields=isp,city,country,lat,lon`);
    if (resp.ok) return await resp.json();
  } catch {}
  return { isp: 'Unknown', city: 'Unknown', country: 'Unknown', lat: null, lon: null };
}

// --- Geo-lookup for traceroute hops ---
app.post('/api/geo-hops', async (req, res) => {
  const { ips } = req.body;
  if (!Array.isArray(ips)) return res.status(400).json({ error: 'ips array required' });

  const unique = [...new Set(ips.filter(Boolean))];
  const results = {};
  for (const ip of unique) {
    const info = await lookupIp(ip);
    results[ip] = { lat: info.lat, lon: info.lon, city: info.city, country: info.country };
  }
  res.json(results);
});

// --- Save result to cockpit DB ---
app.post('/api/result', async (req, res) => {
  try {
    const clientIp = (req.ip || '').replace('::ffff:', '');
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

    console.log('Saving result to DB:', DB_URL + '/speedtest_results');
    const dbRes = await fetch(`${DB_URL}/speedtest_results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify(payload)
    });

    if (!dbRes.ok) {
      const err = await dbRes.text();
      console.error('DB save failed:', dbRes.status, err);
      return res.status(500).json({ error: 'Failed to save result', detail: err });
    }

    const saved = await dbRes.json();
    console.log('Result saved, id:', saved[0]?.id);
    res.json({ saved: true, id: saved[0]?.id });
  } catch (err) {
    console.error('Result save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback
app.get('{*path}', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  speed test server | http://localhost:${PORT} | DB: ${DB_URL} | trace: ${TRACEROUTE_TARGET}\n`);
});
