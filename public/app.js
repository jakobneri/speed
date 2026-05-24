// ================================================================
// Speed Test Client — nerifeige.com
// ================================================================

let running = false;
let map = null;

const $ = id => document.getElementById(id);
const startBtn    = $('start-btn');
const btnText     = $('btn-text');
const progressBar = $('test-progress');
const progressFill = $('test-progress-fill');

// ── Live Charts (Chart.js) ──────────────────────────────────────
const CHART_MAX_POINTS = 60;

const chartOpts = (color, unit, sugMax) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 0 },
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  scales: {
    x: { display: false },
    y: {
      display: true,
      beginAtZero: true,
      ...(sugMax ? { suggestedMax: sugMax } : {}),
      grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
      ticks: {
        font: { size: 9, family: 'monospace' },
        color: '#5a5a6a',
        maxTicksLimit: 3,
        callback: v => v + ' ' + unit
      }
    }
  },
  elements: {
    point: { radius: 0 },
    line: { borderWidth: 1.5, tension: 0.3 }
  }
});

function makeChart(canvasId, color, unit, sugMax) {
  return new Chart($(canvasId), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        borderColor: color,
        backgroundColor: color + '18',
        fill: true
      }]
    },
    options: chartOpts(color, unit, sugMax)
  });
}

const charts = {};
document.addEventListener('DOMContentLoaded', () => {
  charts.dl     = makeChart('chart-dl',     '#3b82f6', 'Mb/s');
  charts.ul     = makeChart('chart-ul',     '#a78bfa', 'Mb/s');
  charts.ping   = makeChart('chart-ping',   '#22c55e', 'ms');
  charts.jitter = makeChart('chart-jitter', '#f59e0b', 'ms', 15);
});

function pushChartPoint(chart, value) {
  const d = chart.data;
  d.labels.push('');
  d.datasets[0].data.push(value);
  if (d.labels.length > CHART_MAX_POINTS) {
    d.labels.shift();
    d.datasets[0].data.shift();
  }
  chart.update('none');
}

function resetChart(chart) {
  chart.data.labels = [];
  chart.data.datasets[0].data = [];
  chart.update('none');
}

// ── Helpers ─────────────────────────────────────────────────────
function setProgress(pct, cls) {
  progressFill.style.width = pct + '%';
  progressFill.className = 'test-progress-fill' + (cls ? ' ' + cls : '');
}

function setPhase(text) {
  $('gauge-phase').textContent = text;
}

// ── Ping measurement ────────────────────────────────────────────
async function measurePing(samples = 20) {
  // Warm-up: 3 pings to establish TCP/TLS keep-alive (not counted)
  for (let w = 0; w < 3; w++) {
    await fetch('/api/ping?_=' + Date.now(), { cache: 'no-store' });
  }

  const pings = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await fetch('/api/ping?_=' + Date.now(), { cache: 'no-store' });
    const rtt = performance.now() - t0;
    pings.push(rtt);

    $('live-ping-val').textContent = rtt.toFixed(1);
    pushChartPoint(charts.ping, rtt);
    if (i > 0) {
      const j = Math.abs(pings[i] - pings[i - 1]);
      $('live-jitter-val').textContent = j.toFixed(1);
      pushChartPoint(charts.jitter, j);
    }
    setProgress((i + 1) / samples * 100, 'ping');
  }
  const avg = pings.reduce((a, b) => a + b) / pings.length;
  return { avg, pings };
}

function calcJitter(pings) {
  if (pings.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < pings.length; i++) {
    sum += Math.abs(pings[i] - pings[i - 1]);
  }
  return sum / (pings.length - 1);
}

// ── Download measurement (parallel streams) ─────────────────────
async function measureDownload(durationMs = 10000) {
  const STREAMS = 6;
  const chunkSize = 25_000_000;
  let totalBytes = 0;
  let stop = false;
  const startTime = performance.now();
  let lastBytes = 0;
  let lastTime = startTime;
  const controller = new AbortController();

  // Each worker streams chunks via ReadableStream for progressive byte counting
  async function dlWorker() {
    while (!stop) {
      try {
        const resp = await fetch('/api/download?size=' + chunkSize + '&_=' + Math.random(), {
          cache: 'no-store',
          signal: controller.signal
        });
        const reader = resp.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done || stop) break;
            totalBytes += value.length;
          }
        } finally {
          reader.releaseLock();
        }
      } catch (e) {
        if (e.name === 'AbortError') break;
        if (!stop) await new Promise(r => setTimeout(r, 50));
      }
    }
  }

  // UI update timer — fires every 250ms for smooth chart
  const uiTimer = setInterval(() => {
    const now = performance.now();
    const elapsed = now - startTime;
    const intervalBytes = totalBytes - lastBytes;
    const intervalTime = (now - lastTime) / 1000;

    if (intervalBytes > 0 && intervalTime > 0.05) {
      const instantMbps = (intervalBytes * 8) / (intervalTime * 1_000_000);
      $('live-dl-val').textContent = instantMbps.toFixed(1);
      pushChartPoint(charts.dl, instantMbps);
      lastBytes = totalBytes;
      lastTime = now;
    }
    setProgress(Math.min(elapsed / durationMs * 100, 100), '');
  }, 250);

  // Launch all workers concurrently
  const workers = Array.from({ length: STREAMS }, () => dlWorker());

  // Stop after duration
  await new Promise(r => setTimeout(r, durationMs));
  stop = true;
  controller.abort();
  clearInterval(uiTimer);

  // Wait for in-flight requests to finish
  await Promise.allSettled(workers);

  const totalTime = (performance.now() - startTime) / 1000;
  const mbps = (totalBytes * 8) / (totalTime * 1_000_000);
  return { mbps, bytes: totalBytes, duration: totalTime };
}

// ── Upload measurement (parallel streams) ───────────────────────
async function measureUpload(durationMs = 10000) {
  const STREAMS = 4;
  const chunkSize = 2_000_000;
  let totalBytes = 0;
  let stop = false;
  const startTime = performance.now();
  let lastBytes = 0;
  let lastTime = startTime;
  const payload = new Uint8Array(chunkSize);
  const controller = new AbortController();

  async function ulWorker() {
    while (!stop) {
      try {
        const resp = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload,
          cache: 'no-store',
          signal: controller.signal
        });
        const result = await resp.json();
        if (!stop) totalBytes += result.bytes;
      } catch (e) {
        if (e.name === 'AbortError') break;
        if (!stop) await new Promise(r => setTimeout(r, 50));
      }
    }
  }

  // UI update timer
  const uiTimer = setInterval(() => {
    const now = performance.now();
    const elapsed = now - startTime;
    const intervalBytes = totalBytes - lastBytes;
    const intervalTime = (now - lastTime) / 1000;

    if (intervalBytes > 0 && intervalTime > 0.05) {
      const instantMbps = (intervalBytes * 8) / (intervalTime * 1_000_000);
      $('live-ul-val').textContent = instantMbps.toFixed(1);
      pushChartPoint(charts.ul, instantMbps);
      lastBytes = totalBytes;
      lastTime = now;
    }
    setProgress(Math.min(elapsed / durationMs * 100, 100), 'upload');
  }, 250);

  const workers = Array.from({ length: STREAMS }, () => ulWorker());

  await new Promise(r => setTimeout(r, durationMs));
  stop = true;
  controller.abort();
  clearInterval(uiTimer);

  await Promise.allSettled(workers);

  const totalTime = (performance.now() - startTime) / 1000;
  const mbps = (totalBytes * 8) / (totalTime * 1_000_000);
  return { mbps, bytes: totalBytes, duration: totalTime };
}

// ── Traceroute ──────────────────────────────────────────────────
async function runTraceroute() {
  setPhase('Traceroute');
  setProgress(50, 'traceroute');

  try {
    const resp = await fetch('/api/traceroute');
    if (!resp.ok) throw new Error('Traceroute failed');
    const data = await resp.json();
    const hops = data.hops || [];

    $('hop-count').textContent = hops.length + ' hops';
    setProgress(100, 'traceroute');

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

    $('map-section').style.display = '';
    renderMap(hops, geoData);
    renderHopList(hops, geoData);

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
  }).setView([48, 11], 5);

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
    const isEndpoint = hop.hop === 1 || hop.hop === hops[hops.length - 1]?.hop;

    const marker = L.circleMarker([geo.lat, geo.lon], {
      radius: isEndpoint ? 7 : 4,
      fillColor: color,
      color: 'rgba(255,255,255,0.3)',
      weight: 1,
      fillOpacity: 0.9
    }).addTo(map);

    const label = `Hop ${hop.hop}: ${hop.ip}` +
      (geo.city ? ` (${geo.city})` : '') +
      (hop.rtt != null ? ` — ${hop.rtt.toFixed(1)}ms` : '');
    marker.bindTooltip(label);

    points.push([geo.lat, geo.lon]);
  }

  if (points.length >= 2) {
    L.polyline(points, {
      color: '#3b82f6',
      weight: 2.5,
      opacity: 0.7,
      dashArray: '6 4'
    }).addTo(map);

    const bounds = L.latLngBounds(points).pad(0.2);
    map.fitBounds(bounds, { maxZoom: 7 });
  } else if (points.length === 1) {
    map.setView(points[0], 6);
  }

  setTimeout(() => map.invalidateSize(), 100);
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

  // Reset
  $('val-download').textContent = '--';
  $('val-upload').textContent = '--';
  $('val-ping').textContent = '--';
  $('val-jitter').textContent = '--';
  $('live-dl-val').textContent = '--';
  $('live-ul-val').textContent = '--';
  $('live-ping-val').textContent = '--';
  $('live-jitter-val').textContent = '--';
  Object.values(charts).forEach(resetChart);

  const testStart = performance.now();
  let results = {};

  try {
    // 1. Ping
    setPhase('Measuring Ping');
    const pingResult = await measurePing(20);
    results.ping_ms = parseFloat(pingResult.avg.toFixed(2));
    $('val-ping').textContent = results.ping_ms.toFixed(1);
    $('live-ping-val').textContent = results.ping_ms.toFixed(1);

    // 2. Jitter (already pushed live during ping)
    results.jitter_ms = parseFloat(calcJitter(pingResult.pings).toFixed(2));
    $('val-jitter').textContent = results.jitter_ms.toFixed(1);
    $('live-jitter-val').textContent = results.jitter_ms.toFixed(1);

    // 3. Download (6 parallel streams)
    setPhase('Download');
    const dlResult = await measureDownload(10000);
    results.download_mbps = parseFloat(dlResult.mbps.toFixed(2));
    results.download_bytes = dlResult.bytes;
    $('val-download').textContent = results.download_mbps.toFixed(1);
    $('live-dl-val').textContent = results.download_mbps.toFixed(1);

    // 4. Upload (4 parallel streams)
    setPhase('Upload');
    const ulResult = await measureUpload(10000);
    results.upload_mbps = parseFloat(ulResult.mbps.toFixed(2));
    results.upload_bytes = ulResult.bytes;
    $('val-upload').textContent = results.upload_mbps.toFixed(1);
    $('live-ul-val').textContent = results.upload_mbps.toFixed(1);

    // 5. Traceroute
    await runTraceroute();

    // Duration
    results.duration_s = parseFloat(((performance.now() - testStart) / 1000).toFixed(2));

    // Connection hints
    Object.assign(results, getConnectionInfo());

    // Save to DB
    try {
      const saveResp = await fetch('/api/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(results)
      });
      const saveData = await saveResp.json();
      if (!saveResp.ok) console.error('Save failed:', saveData);
      else console.log('Result saved:', saveData);
    } catch (e) {
      console.error('Save error:', e);
    }

    setPhase('Complete');

  } catch (err) {
    console.error('Test error:', err);
    setPhase('Error');
  }

  progressBar.classList.remove('active');
  setProgress(0, '');
  startBtn.disabled = false;
  startBtn.classList.remove('running');
  btnText.textContent = 'Retest';
  running = false;
}
