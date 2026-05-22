# Cockpit-Erweiterung: Speed Test Logs Subpage

## Kontext

Neben dem bestehenden Cockpit (`C:\dev\cockpit`, repo `jakobneri/cockpit`) läuft ein selbstgebauter Speedtest auf `speed.nerifeige.com` (repo `jakobneri/speed`, Port 3002). Der Speedtest speichert Ergebnisse direkt in die Cockpit-PostgreSQL-DB via PostgREST (Port 3001).

## Was existiert bereits in der DB

Tabelle `speedtest_results` mit folgenden Spalten:

```sql
id              SERIAL PRIMARY KEY
download_mbps   NUMERIC(10,2)
upload_mbps     NUMERIC(10,2)
ping_ms         NUMERIC(10,2)
jitter_ms       NUMERIC(10,2)
client_ip       TEXT
isp             TEXT
server_ip       TEXT
user_agent      TEXT
location        TEXT            -- Geo-Location (Stadt, Land)
connection_type TEXT            -- WiFi/4G/ethernet etc.
downlink_hint   NUMERIC(10,2)  -- Navigator.connection.downlink
rtt_hint        NUMERIC(10,2)  -- Navigator.connection.rtt
duration_s      NUMERIC(10,2)
download_bytes  BIGINT
upload_bytes    BIGINT
tested_at       TIMESTAMPTZ DEFAULT NOW()
```

Die Traceroute-Hops werden NICHT im Cockpit angezeigt (nur im Speedtest-Frontend auf einer Weltkarte).

## Aufgabe

### 1. Neuer Nav-Link in der Sidebar

In `index.html` einen neuen Nav-Link "Speed" hinzufügen (zwischen "Compute" und "About"):

```html
<a href="#" onclick="showSpeedDashboard(); return false;" id="nav-speed" class="nav-link">Speed</a>
```

### 2. Neue View `view-speed` in `index.html`

Neue `<main id="view-speed">` Section nach dem gleichen Muster wie `view-pi` oder `view-info`. Inhalt:

- **Header**: "Speed Tests" + Subtitle "Logged speed test results"
- **Statistik-Karten** (3 Karten im `nodes-grid`):
  - Durchschnittliche Download-Speed (alle Tests)
  - Durchschnittliche Upload-Speed
  - Durchschnittlicher Ping
- **Chart**: Speed-Verlauf über Zeit (Download + Upload als Linien, Chart.js, gleicher Stil wie `cpuChart`/`ramChart`)
- **Tabelle** der letzten 50 Tests:
  - Spalten: Zeitpunkt, Download (Mbit/s), Upload (Mbit/s), Ping (ms), Jitter (ms), ISP, IP, Location
  - Gleicher Stil wie `.technical-table` / `.history-table`

### 3. Neuer API-Endpoint in `server/index.js`

```js
app.get('/api/speedlogs', async (req, res) => {
  // Holt die letzten 50 Speedtest-Ergebnisse von PostgREST
  // GET ${DB_URL}/speedtest_results?order=tested_at.desc&limit=50
});
```

### 4. Frontend-Logik in `src/main.js`

- `showSpeedDashboard()` Funktion (analog zu `showPiDashboard()`)
- Fetch von `/api/speedlogs`, Tabelle rendern, Chart updaten
- Durchschnitte berechnen und in Stat-Karten anzeigen

### 5. Design

- Exakt gleicher Stil wie bestehende Views (Control v8 dark theme)
- Gleiche Card-Klassen: `.card.glass`, `.nodes-grid`, `.node-card`
- Chart.js mit gleichen Farben/Optionen wie bestehende Charts

### Referenz-Dateien

- `index.html` — Sidebar-Navigation, View-Struktur, bestehende Templates
- `src/main.js` — Frontend-Logik, `showOverview()`, `showPiDashboard()` als Referenz
- `src/style.css` — Alle CSS-Klassen
- `server/index.js` — API-Endpoints, PostgREST-Proxy-Pattern (`DB_URL`)
