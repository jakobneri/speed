// ================================================================
// Speed Test Client — nerifeige.com (Cloudflare-style)
// ================================================================

let running = false;
const $ = id => document.getElementById(id);

// ── Charts ──────────────────────────────────────────────────────
const CHART_MAX = 80;

function makeChart(canvasId, color) {
  return new Chart($(canvasId), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        data: [],
        fill: true,
        backgroundColor: color + '20',
        borderColor: color,
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 2.5,
        pointBackgroundColor: color,
        pointBorderColor: 'transparent'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          display: true,
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
          ticks: {
            font: { size: 9, family: 'monospace' },
            color: '#555',
            maxTicksLimit: 3,
            callback: v => v.toFixed(0)
          }
        }
      }
    }
  });
}

const charts = {};
document.addEventListener('DOMContentLoaded', () => {
  charts.dl = makeChart('chart-dl', '#f59e0b');
  charts.ul = makeChart('chart-ul', '#a78bfa');
});

function pushChart(chart, value) {
  const d = chart.data;
  d.labels.push('');
  d.datasets[0].data.push(value);
  if (d.labels.length > CHART_MAX) { d.labels.shift(); d.datasets[0].data.shift(); }
  chart.update('none');
}

function resetChart(chart) {
  chart.data.labels = [];
  chart.data.datasets[0].data = [];
  while (chart.data.datasets.length > 1) chart.data.datasets.pop();
  chart.update('none');
}

function addPercentileLines(chart, p60, p90, color) {
  const n = chart.data.labels.length;
  chart.data.datasets.push({
    label: '90th',
    data: Array(n).fill(p90),
    borderColor: color + '55',
    borderDash: [5, 3],
    borderWidth: 1,
    fill: false,
    pointRadius: 0
  }, {
    label: '60th',
    data: Array(n).fill(p60),
    borderColor: color + '30',
    borderDash: [5, 3],
    borderWidth: 1,
    fill: false,
    pointRadius: 0
  });
  chart.update('none');
}

// ── Helpers ─────────────────────────────────────────────────────
function setPhase(t) { $('gauge-phase').textContent = t; }
function setProgress(p) { $('test-progress-fill').style.width = p + '%'; }

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] * (hi - i) + sorted[hi] * (i - lo);
}

function calcStats(vals) {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  return {
    min: s[0], q1: pct(s, 0.25), median: pct(s, 0.5),
    q3: pct(s, 0.75), max: s[s.length - 1],
    mean: vals.reduce((a, b) => a + b) / vals.length,
    p60: pct(s, 0.6), p90: pct(s, 0.9)
  };
}

function calcJitter(pings) {
  if (pings.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < pings.length; i++) s += Math.abs(pings[i] - pings[i - 1]);
  return s / (pings.length - 1);
}

function niceStep(max, target = 6) {
  if (max <= 0) return 1;
  const rough = max / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  for (const n of [1, 2, 5, 10]) { if (n * pow >= rough) return n * pow; }
  return pow * 10;
}

function fmtAxis(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v % 1 === 0 ? v.toFixed(0) : v.toFixed(1);
}

// ── Connection Info ─────────────────────────────────────────────
async function fetchConnectionInfo() {
  try {
    const r = await fetch('/api/info');
    if (!r.ok) return null;
    const info = await r.json();
    $('isp-name').textContent = info.isp || 'Unknown';
    $('client-ip').textContent = info.client_ip || '--';
    $('server-loc').textContent = info.server || 'nerifeige.com';
    const c = navigator.connection;
    $('conn-type').textContent = c ? (c.effectiveType || c.type || 'unknown').toUpperCase() : 'unknown';
    return info;
  } catch { return null; }
}

// ── Latency ─────────────────────────────────────────────────────
async function measureLatency(samples) {
  for (let i = 0; i < 3; i++) await fetch('/api/ping?_=' + Date.now(), { cache: 'no-store' });
  const pings = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await fetch('/api/ping?_=' + Date.now(), { cache: 'no-store' });
    pings.push(performance.now() - t);
  }
  return { avg: pings.reduce((a, b) => a + b) / pings.length, jitter: calcJitter(pings), pings };
}

// ── Single Download ─────────────────────────────────────────────
async function dlOne(size) {
  const t = performance.now();
  const r = await fetch('/api/download?size=' + size + '&_=' + Date.now(), { cache: 'no-store' });
  const d = await r.arrayBuffer();
  return (d.byteLength * 8) / ((performance.now() - t) / 1000 * 1e6);
}

// ── Multi-size Download ─────────────────────────────────────────
async function measureDownloadMulti(onProg) {
  const tests = [
    { size: 100_000,    count: 10, label: '100kB download test' },
    { size: 1_000_000,  count: 8,  label: '1MB download test' },
    { size: 10_000_000, count: 6,  label: '10MB download test' },
    { size: 25_000_000, count: 4,  label: '25MB download test' },
  ];
  const total = tests.reduce((s, t) => s + t.count, 0);
  let done = 0;
  const all = [], results = {};

  for (const t of tests) {
    // Skip 25MB if 10MB avg < 10 Mbps (slow connection)
    if (t.size === 25_000_000 && results['10MB download test']) {
      const prev = results['10MB download test'].speeds;
      if (prev.reduce((a, b) => a + b) / prev.length < 10) {
        done += t.count;
        continue;
      }
    }
    const speeds = [];
    for (let i = 0; i < t.count; i++) {
      setPhase('Download · ' + t.label + ' (' + (i + 1) + '/' + t.count + ')');
      const spd = await dlOne(t.size);
      speeds.push(spd);
      all.push(spd);
      pushChart(charts.dl, spd);
      $('val-download').textContent = spd.toFixed(1);
      done++;
      if (onProg) onProg(done / total);
    }
    results[t.label] = { speeds, size: t.size, count: t.count };
  }

  const big = [
    ...(results['10MB download test']?.speeds || []),
    ...(results['25MB download test']?.speeds || [])
  ];
  big.sort((a, b) => a - b);
  const headline = big.length ? pct(big, 0.9) : (all.length ? pct([...all].sort((a, b) => a - b), 0.9) : 0);
  return { results, headline, allSpeeds: all };
}

// ── Single Upload ───────────────────────────────────────────────
async function ulOne(payload) {
  const t = performance.now();
  const r = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: payload, cache: 'no-store'
  });
  const j = await r.json();
  return (j.bytes * 8) / ((performance.now() - t) / 1000 * 1e6);
}

// ── Multi-size Upload ───────────────────────────────────────────
async function measureUploadMulti(onProg) {
  const tests = [
    { size: 100_000,    count: 8, label: '100kB upload test' },
    { size: 1_000_000,  count: 6, label: '1MB upload test' },
    { size: 10_000_000, count: 4, label: '10MB upload test' },
  ];
  const total = tests.reduce((s, t) => s + t.count, 0);
  let done = 0;
  const all = [], results = {};

  for (const t of tests) {
    // Skip 10MB upload if 1MB avg < 5 Mbps
    if (t.size === 10_000_000 && results['1MB upload test']) {
      const prev = results['1MB upload test'].speeds;
      if (prev.reduce((a, b) => a + b) / prev.length < 5) {
        done += t.count;
        continue;
      }
    }
    const payload = new Uint8Array(t.size);
    const speeds = [];
    for (let i = 0; i < t.count; i++) {
      setPhase('Upload · ' + t.label + ' (' + (i + 1) + '/' + t.count + ')');
      const spd = await ulOne(payload);
      speeds.push(spd);
      all.push(spd);
      pushChart(charts.ul, spd);
      $('val-upload').textContent = spd.toFixed(1);
      done++;
      if (onProg) onProg(done / total);
    }
    results[t.label] = { speeds, size: t.size, count: t.count };
  }

  const big = [
    ...(results['1MB upload test']?.speeds || []),
    ...(results['10MB upload test']?.speeds || [])
  ];
  big.sort((a, b) => a - b);
  const headline = big.length ? pct(big, 0.9) : 0;
  return { results, headline, allSpeeds: all };
}

// ── Latency Under Load ──────────────────────────────────────────
async function measureLatencyUnderLoad(type) {
  const ctrl = new AbortController();
  let go = true;

  async function worker() {
    while (go) {
      try {
        if (type === 'download') {
          const r = await fetch('/api/download?size=10000000&_=' + Math.random(), { cache: 'no-store', signal: ctrl.signal });
          await r.arrayBuffer();
        } else {
          await fetch('/api/upload', {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
            body: new Uint8Array(2_000_000), cache: 'no-store', signal: ctrl.signal
          });
        }
      } catch (e) { if (e.name === 'AbortError') break; }
    }
  }

  const workers = Array.from({ length: 3 }, () => worker());
  await new Promise(r => setTimeout(r, 800));

  setPhase('Latency during ' + type);
  const pings = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    await fetch('/api/ping?_=' + Date.now(), { cache: 'no-store' });
    pings.push(performance.now() - t);
  }

  go = false;
  ctrl.abort();
  await Promise.allSettled(workers);
  return { avg: pings.reduce((a, b) => a + b) / pings.length, jitter: calcJitter(pings), pings };
}

// ── Packet Loss ─────────────────────────────────────────────────
async function measurePacketLoss(count) {
  setPhase('Packet Loss Test');
  let received = 0;
  const batch = 10, timeout = 3000;

  for (let b = 0; b < count / batch; b++) {
    const ps = [];
    for (let i = 0; i < batch; i++) {
      const c = new AbortController();
      const tm = setTimeout(() => c.abort(), timeout);
      ps.push(
        fetch('/api/ping?_=' + Date.now() + Math.random(), { cache: 'no-store', signal: c.signal })
          .then(() => { clearTimeout(tm); received++; })
          .catch(() => { clearTimeout(tm); })
      );
    }
    await Promise.all(ps);
    setProgress(93 + (b + 1) / (count / batch) * 7);
  }

  return { sent: count, received, loss: (count - received) / count * 100 };
}

// ── Quality Score ───────────────────────────────────────────────
function rateQuality(dl, ul, lat, jit, loss) {
  const streaming = (dl >= 25 && lat < 100 && loss < 1) ? 'Great' :
                    (dl >= 5 && lat < 200) ? 'Good' : 'Poor';
  const gaming = (lat < 30 && jit < 10 && loss < 0.5) ? 'Great' :
                 (lat < 75 && jit < 30 && loss < 2) ? 'Good' : 'Poor';
  const video = (ul >= 5 && lat < 50 && jit < 15 && loss < 0.5) ? 'Great' :
                (ul >= 1.5 && lat < 150 && jit < 30) ? 'Good' : 'Poor';
  return { streaming, gaming, video };
}

function showQuality(q) {
  for (const [k, v] of Object.entries(q)) {
    const id = k === 'streaming' ? 'q-streaming' : k === 'gaming' ? 'q-gaming' : 'q-video';
    const cls = v.toLowerCase();
    $(id).textContent = v;
    $(id).className = 'quality-rating ' + cls;
    $(id + '-dot').className = 'quality-dot ' + cls;
  }
  $('quality-section').style.display = '';
}

// ── Box Plot Rendering ──────────────────────────────────────────
function renderBoxPlot(container, label, values, maxScale, color) {
  const st = calcStats(values);
  if (!st) return;

  const step = niceStep(maxScale);
  const adjMax = Math.ceil(maxScale / step) * step || maxScale;
  const toP = v => Math.max(0, Math.min(v / adjMax * 100, 100));

  // Axis labels
  const labels = [];
  for (let v = 0; v <= adjMax; v += step) labels.push(v);
  const axisHtml = labels.map((v, i) => {
    const left = toP(v).toFixed(1);
    const tx = i === 0 ? 'translateX(0)' : i === labels.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)';
    return '<span style="left:' + left + '%;transform:' + tx + '">' + fmtAxis(v) + '</span>';
  }).join('');

  // Dots with vertical jitter
  const dots = values.map(v => {
    const y = (Math.random() - 0.5) * 10;
    return '<div class="bp-dot" style="left:' + toP(v).toFixed(2) + '%;top:calc(50% + ' + y.toFixed(0) + 'px);background:' + color + '"></div>';
  }).join('');

  const wL = toP(st.min), wW = toP(st.max) - wL;
  const bL = toP(st.q1), bW = Math.max(toP(st.q3) - bL, 0.5);

  const row = document.createElement('div');
  row.className = 'bp-row';
  row.innerHTML =
    '<div class="bp-label">' + label + ' (' + values.length + '/' + values.length + ')</div>' +
    '<div class="bp-chart">' +
      '<div class="bp-axis">' + axisHtml + '</div>' +
      '<div class="bp-track">' +
        '<div class="bp-whisker" style="left:' + wL.toFixed(2) + '%;width:' + wW.toFixed(2) + '%"></div>' +
        '<div class="bp-box" style="left:' + bL.toFixed(2) + '%;width:' + bW.toFixed(2) + '%;background:' + color + '"></div>' +
        '<div class="bp-median" style="left:' + toP(st.median).toFixed(2) + '%"></div>' +
        dots +
      '</div>' +
    '</div>';
  container.appendChild(row);
}

function renderAllMeasurements(dlR, ulR, unloaded, dlLat, ulLat) {
  const allDl = Object.values(dlR.results).flatMap(r => r.speeds);
  const allUl = Object.values(ulR.results).flatMap(r => r.speeds);
  const allLat = [...unloaded.pings, ...(dlLat?.pings || []), ...(ulLat?.pings || [])];

  const dlMax = allDl.length ? Math.max(...allDl) * 1.15 : 100;
  const ulMax = allUl.length ? Math.max(...allUl) * 1.15 : 50;
  const latMax = allLat.length ? Math.max(...allLat) * 1.15 : 200;

  const dc = $('dl-measurements'); dc.innerHTML = '';
  for (const [l, d] of Object.entries(dlR.results)) renderBoxPlot(dc, l, d.speeds, dlMax, '#f59e0b');

  const uc = $('ul-measurements'); uc.innerHTML = '';
  for (const [l, d] of Object.entries(ulR.results)) renderBoxPlot(uc, l, d.speeds, ulMax, '#a78bfa');

  const lc = $('latency-measurements'); lc.innerHTML = '';
  renderBoxPlot(lc, 'Unloaded latency', unloaded.pings, latMax, '#22c55e');
  if (dlLat) renderBoxPlot(lc, 'Latency during download', dlLat.pings, latMax, '#22c55e');
  if (ulLat) renderBoxPlot(lc, 'Latency during upload', ulLat.pings, latMax, '#22c55e');

  $('measurements-section').style.display = '';
}

// ── Main Test ───────────────────────────────────────────────────
async function startTest() {
  if (running) return;
  running = true;

  const btn = $('start-btn');
  btn.disabled = true;
  btn.classList.add('running');
  $('btn-text').textContent = 'Testing...';
  $('test-progress').classList.add('active');
  $('quality-section').style.display = 'none';
  $('measurements-section').style.display = 'none';
  $('packet-loss-section').style.display = 'none';
  $('measured-at').textContent = '';

  ['val-download','val-upload','val-ping','val-jitter','val-packet-loss',
   'val-dl-latency','val-ul-latency','val-dl-jitter','val-ul-jitter'
  ].forEach(id => $(id).textContent = '--');
  Object.values(charts).forEach(resetChart);

  const t0 = performance.now();

  try {
    // 1. Connection info
    setPhase('Getting connection info...');
    await fetchConnectionInfo();
    setProgress(2);

    // 2. Unloaded latency
    setPhase('Measuring latency');
    const unloaded = await measureLatency(20);
    $('val-ping').textContent = unloaded.avg.toFixed(1);
    $('val-jitter').textContent = unloaded.jitter.toFixed(1);
    setProgress(8);

    // 3. Download tests
    const dlR = await measureDownloadMulti(p => setProgress(8 + p * 35));
    $('val-download').textContent = dlR.headline.toFixed(1);
    const dlSt = calcStats(dlR.allSpeeds);
    if (dlSt) {
      addPercentileLines(charts.dl, dlSt.p60, dlSt.p90, '#f59e0b');
      $('dl-percentiles').innerHTML =
        '<span>60th: ' + dlSt.p60.toFixed(1) + ' Mbps</span>' +
        '<span>90th: ' + dlSt.p90.toFixed(1) + ' Mbps</span>';
    }

    // 4. Latency during download
    setProgress(46);
    const dlLat = await measureLatencyUnderLoad('download');
    $('val-dl-latency').textContent = dlLat.avg.toFixed(1);
    $('val-dl-jitter').textContent = dlLat.jitter.toFixed(1);
    setProgress(53);

    // 5. Upload tests
    const ulR = await measureUploadMulti(p => setProgress(53 + p * 30));
    $('val-upload').textContent = ulR.headline.toFixed(1);
    const ulSt = calcStats(ulR.allSpeeds);
    if (ulSt) {
      addPercentileLines(charts.ul, ulSt.p60, ulSt.p90, '#a78bfa');
      $('ul-percentiles').innerHTML =
        '<span>60th: ' + ulSt.p60.toFixed(1) + ' Mbps</span>' +
        '<span>90th: ' + ulSt.p90.toFixed(1) + ' Mbps</span>';
    }

    // 6. Latency during upload
    setProgress(86);
    const ulLat = await measureLatencyUnderLoad('upload');
    $('val-ul-latency').textContent = ulLat.avg.toFixed(1);
    $('val-ul-jitter').textContent = ulLat.jitter.toFixed(1);
    setProgress(93);

    // 7. Packet loss
    const pktLoss = await measurePacketLoss(100);
    $('val-packet-loss').textContent = pktLoss.loss.toFixed(1);
    $('pkt-sent').textContent = pktLoss.sent;
    $('pkt-received').textContent = pktLoss.received;
    $('pkt-bar').style.width = (pktLoss.received / pktLoss.sent * 100).toFixed(1) + '%';
    $('pkt-bar-label').textContent = 'Received ' + (pktLoss.received / pktLoss.sent * 100).toFixed(0) + '%';
    $('packet-loss-section').style.display = '';
    setProgress(100);

    // Quality
    showQuality(rateQuality(dlR.headline, ulR.headline, unloaded.avg, unloaded.jitter, pktLoss.loss));

    // Measurements (box plots)
    renderAllMeasurements(dlR, ulR, unloaded, dlLat, ulLat);

    // Timestamp
    $('measured-at').textContent = 'Measured at ' + new Date().toLocaleTimeString();

    // Save to DB
    const dur = (performance.now() - t0) / 1000;
    const conn = navigator.connection || {};
    try {
      await fetch('/api/result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          download_mbps: +dlR.headline.toFixed(2),
          upload_mbps: +ulR.headline.toFixed(2),
          ping_ms: +unloaded.avg.toFixed(2),
          jitter_ms: +unloaded.jitter.toFixed(2),
          connection_type: conn.effectiveType || null,
          downlink_hint: conn.downlink || null,
          rtt_hint: conn.rtt || null,
          duration_s: +dur.toFixed(2),
          download_bytes: Object.values(dlR.results).reduce((s, r) => s + r.speeds.length * r.size, 0),
          upload_bytes: Object.values(ulR.results).reduce((s, r) => s + r.speeds.length * r.size, 0)
        })
      });
    } catch (e) { console.error('Save error:', e); }

    setPhase('Complete');

  } catch (err) {
    console.error('Test error:', err);
    setPhase('Error');
  }

  $('test-progress').classList.remove('active');
  setProgress(0);
  btn.disabled = false;
  btn.classList.remove('running');
  $('btn-text').textContent = 'Retest';
  running = false;
}
