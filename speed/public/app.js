// ================================================================
// Speed Test Client — nerifeige.com
// ================================================================

const CIRCUMFERENCE = 2 * Math.PI * 88; // gauge circle r=88
let running = false;
let map = null;

// ── DOM refs ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const gaugeValue  = $('gauge-value');
const gaugeLabel  = $('gauge-label');
const gaugePhase  = $('gauge-phase');
const gaugeFill   = $('gauge-fill');
const startBtn    = $('start-btn');
const btnText     = $('btn-text');
const progressBar = $('test-progress');
const progressFill = $('test-progress-fill');

// ── Gauge helpers ───────────────────────────────────────────────
function setGauge(fraction, cls) {
  const offset = CIRCUMFERENCE * (1 - Math.min(1, fraction));
  gaugeFill.style.strokeDashoffset = offset;
  gaugeFill.className.baseVal = 'gauge-fill' + (cls ? ' ' + cls : '');
}

function setProgress(pct, cls) {
  progressFill.style.width = pct + '%';
  progressFill.className = 'test-progress-fill' + (cls ? ' ' + cls : '');
}

function setPhase(text) {
  gaugePhase.textContent = text;
}

// ── Ping measurement ────────────────────────────────────────────
async function measurePing(samples = 20) {
  const pings = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await fetch('/api/ping?_=' + Date.now(), { cache: 'no-store' });
    const rtt = performance.now() - t0;
    pings.push(rtt);

    gaugeValue.textContent = rtt.toFixed(1);
    gaugeLabel.textContent = 'ms';
    setGauge(Math.min(rtt / 100, 1), 'ping');
    setProgress((i + 1) / samples * 100, 'ping');
  }
  const avg = pings.reduce((a, b) => a + b) / pings.length;
  return { avg, pings };
}

// ── Jitter measurement ──────────────────────────────────────────
function calcJitter(pings) {
  if (pings.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < pings.length; i++) {
    sum += Math.abs(pings[i] - pings[i - 1]);
  }
  return sum / (pings.length - 1);
}

// ── Download measurement ────────────────────────────────────────
async function measureDownload(durationMs = 10000) {
  const chunkSize = 4_000_000;
  let totalBytes = 0;
  const startTime = performance.now();
  let lastUpdate = startTime;

  while (performance.now() - startTime < durationMs) {
    const resp = await fetch('/api/download?size=' + chunkSize + '&_=' + Date.now(), {
      cache: 'no-store'
    });
    const data = await resp.arrayBuffer();
    totalBytes += data.byteLength;

    const elapsed = (performance.now() - startTime) / 1000;
    const mbps = (totalBytes * 8) / (elapsed * 1_000_000);

    if (performance.now() - lastUpdate > 100) {
      gaugeValue.textContent = mbps.toFixed(1);
      gaugeLabel.textContent = 'Mbit/s';
      setGauge(Math.min(mbps / 100, 1), '');
      setProgress(Math.min((performance.now() - startTime) / durationMs * 100, 100), '');
      lastUpdate = performance.now();
    }
  }

  const totalTime = (performance.now() - startTime) / 1000;
  const mbps = (totalBytes * 8) / (totalTime * 1_000_000);
  return { mbps, bytes: totalBytes, duration: totalTime };
}

// ── Upload measurement ──────────────────────────────────────────
async function measureUpload(durationMs = 10000) {
  const chunkSize = 2_000_000;
  let totalBytes = 0;
  const startTime = performance.now();
  let lastUpdate = startTime;
  const payload = new Uint8Array(chunkSize);

  while (performance.now() - startTime < durationMs) {
    const resp = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
      cache: 'no-store'
    });
    const result = await resp.json();
    totalBytes += result.bytes;

    const elapsed = (performance.now() - startTime) / 1000;
    const mbps = (totalBytes * 8) / (elapsed * 1_000_000);

    if (performance.now() - lastUpdate > 100) {
      gaugeValue.textContent = mbps.toFixed(1);
      gaugeLabel.textContent = 'Mbit/s';
      setGauge(Math.min(mbps / 100, 1), 'upload');
      setProgress(Math.min((performance.now() - startTime) / durationMs * 100, 100), 'upload');
      lastUpdate = performance.now();
    }
  }

  const totalTime = (performance.now() - startTime) / 1000;
  const mbps = (totalBytes * 8) / (totalTime * 1_000_000);
  return { mbps, bytes: totalBytes, duration: totalTime };
}

// ── Traceroute ──────────────────────────────────────────────────
async function runTraceroute() {
  setPhase('Traceroute');
  gaugeValue.textContent = '...';
  gaugeLabel.textContent = 'tracing';
  setGauge(0.5, 'traceroute');
  setProgress(50, 'traceroute');

  try {
    const resp = await fetch('/api/traceroute');
    if (!resp.ok) throw new Error('Traceroute failed');
    const data = await resp.json();
    const hops = data.hops || [];

    $('hop-count').textContent = hops.length + ' hops';
    gaugeValue.textContent = hops.length;
    gaugeLabel.textContent = 'hops';
    setGauge(1, 'traceroute');
    setProgress(100, 'traceroute');

    // Get geo data for hop IPs
    const ips = hops.map(h => h.ip).filter(Boolean);
    let geoData = {};
    if (ips.length > 0) {
      try {
        const geoResp = await fetch('/api/geo-hops', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ips })
        });
        if (geoResp.ok) geoData = await geoResp.json();
      } catch {}
    }

    renderMap(hops, geoData);
    renderHopList(hops, geoData);
    $('map-section').style.display = '';

    return hops;
  } catch (err) {
    console.error('Traceroute error:', err);
    return [];
  }
}

function renderMap(hops, geoData) {
  if (map) { map.remove(); map = null; }

  map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([30, 0], 2);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OSM &copy; CARTO',
    subdomains: 'abcd'
  }).addTo(map);

  const points = [];

  for (const hop of hops) {
    if (!hop.ip || !geoData[hop.ip]) continue;
    const geo = geoData[hop.ip];
    if (geo.lat == null || geo.lon == null) continue;

    const rttClass = hop.rtt == null ? '' : hop.rtt < 20 ? 'fast' : hop.rtt < 80 ? 'mid' : 'slow';
    const color = rttClass === 'fast' ? '#22c55e' : rttClass === 'mid' ? '#f59e0b' : '#ef4444';
    const radius = hop.hop === 1 ? 6 : hop.hop === hops.length ? 6 : 4;

    const marker = L.circleMarker([geo.lat, geo.lon], {
      radius,
      fillColor: color,
      color: 'rgba(255,255,255,0.2)',
      weight: 1,
      fillOpacity: 0.9
    }).addTo(map);

    const label = `Hop ${hop.hop}: ${hop.ip}` +
      (geo.city ? ` (${geo.city})` : '') +
      (hop.rtt != null ? ` — ${hop.rtt.toFixed(1)}ms` : '');
    marker.bindTooltip(label, { className: 'hop-tooltip' });

    points.push([geo.lat, geo.lon]);
  }

  if (points.length >= 2) {
    L.polyline(points, {
      color: '#3b82f6',
      weight: 2,
      opacity: 0.6,
      dashArray: '6 4'
    }).addTo(map);

    map.fitBounds(L.latLngBounds(points).pad(0.3));
  }
}

function renderHopList(hops, geoData) {
  const container = $('hop-list');
  container.innerHTML = '';

  for (const hop of hops) {
    const geo = hop.ip && geoData[hop.ip] ? geoData[hop.ip] : {};
    const rttClass = hop.rtt == null ? '' : hop.rtt < 20 ? 'fast' : hop.rtt < 80 ? 'mid' : 'slow';
    const loc = geo.city && geo.country ? `${geo.city}, ${geo.country}` : '';

    const el = document.createElement('div');
    el.className = 'hop-item';
    el.innerHTML =
      `<span class="hop-num">${hop.hop}</span>` +
      `<span class="hop-ip">${hop.ip || '* * *'}</span>` +
      `<span class="hop-location">${loc}</span>` +
      `<span class="hop-rtt ${rttClass}">${hop.rtt != null ? hop.rtt.toFixed(1) + ' ms' : '--'}</span>`;
    container.appendChild(el);
  }
}

// ── Connection info ─────────────────────────────────────────────
function getConnectionInfo() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return {};
  return {
    connection_type: conn.effectiveType || conn.type || null,
    downlink_hint: conn.downlink || null,
    rtt_hint: conn.rtt || null
  };
}

// ── Main test sequence ──────────────────────────────────────────
async function startTest() {
  if (running) return;
  running = true;
  startBtn.disabled = true;
  startBtn.classList.add('running');
  btnText.textContent = 'Testing...';
  progressBar.classList.add('active');
  $('map-section').style.display = 'none';

  // Reset values
  $('val-download').textContent = '--';
  $('val-upload').textContent = '--';
  $('val-ping').textContent = '--';
  $('val-jitter').textContent = '--';

  const testStart = performance.now();
  let results = {};

  try {
    // 1. Ping
    setPhase('Measuring Ping');
    const pingResult = await measurePing(20);
    results.ping_ms = parseFloat(pingResult.avg.toFixed(2));
    $('val-ping').textContent = results.ping_ms.toFixed(1);

    // 2. Jitter
    results.jitter_ms = parseFloat(calcJitter(pingResult.pings).toFixed(2));
    $('val-jitter').textContent = results.jitter_ms.toFixed(1);

    // 3. Download
    setPhase('Download');
    const dlResult = await measureDownload(10000);
    results.download_mbps = parseFloat(dlResult.mbps.toFixed(2));
    results.download_bytes = dlResult.bytes;
    $('val-download').textContent = results.download_mbps.toFixed(1);

    // 4. Upload
    setPhase('Upload');
    const ulResult = await measureUpload(10000);
    results.upload_mbps = parseFloat(ulResult.mbps.toFixed(2));
    results.upload_bytes = ulResult.bytes;
    $('val-upload').textContent = results.upload_mbps.toFixed(1);

    // 5. Traceroute (runs parallel-ish, after main test)
    await runTraceroute();

    // Duration
    results.duration_s = parseFloat(((performance.now() - testStart) / 1000).toFixed(2));

    // Connection hints
    const connInfo = getConnectionInfo();
    Object.assign(results, connInfo);

    // Save to DB (silent, no UI feedback)
    fetch('/api/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results)
    }).catch(() => {});

    // Final gauge state
    setPhase('Complete');
    gaugeValue.textContent = results.download_mbps.toFixed(0);
    gaugeLabel.textContent = 'Mbit/s';
    setGauge(Math.min(results.download_mbps / 100, 1), '');

  } catch (err) {
    console.error('Test error:', err);
    setPhase('Error');
    gaugeValue.textContent = '!';
    gaugeLabel.textContent = 'failed';
  }

  progressBar.classList.remove('active');
  setProgress(0, '');
  startBtn.disabled = false;
  startBtn.classList.remove('running');
  btnText.textContent = 'Retest';
  running = false;
}
