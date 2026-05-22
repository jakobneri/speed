# Speed Test — Deployment auf dem Pi

## 1. Repo klonen

```bash
cd /home/archimedes
git clone https://github.com/jakobneri/speed.git
cd speed
npm install
```

## 2. Datenbank-Tabelle anlegen

```bash
# In den cockpit-db Container connecten
docker exec -it cockpit-db psql -U cockpit_user -d cockpit -f -
```

Dann den Inhalt von `setup.sql` einfuegen:

```bash
docker exec -i cockpit-db psql -U cockpit_user -d cockpit < setup.sql
```

Pruefen ob die Tabelle existiert:

```bash
docker exec -it cockpit-db psql -U cockpit_user -d cockpit -c "\dt speedtest_results"
```

## 3. Mit PM2 starten

```bash
cd /home/archimedes/speed
pm2 start server/index.js --name speed
pm2 save
```

Pruefen:

```bash
pm2 status
# speed sollte "online" sein

curl http://localhost:3002/api/ping
# Sollte leeren 200er zurueckgeben
```

## 4. Testen

```bash
# Schnelltest ob alles laeuft
curl -s http://localhost:3002/api/ping -w "\n%{http_code}\n"
# -> 200

curl -s http://localhost:3002/api/download?size=1000 -o /dev/null -w "%{http_code}\n"
# -> 200

# Traceroute testen (braucht traceroute installiert)
sudo apt install traceroute -y
curl -s http://localhost:3002/api/traceroute | head -c 200
```

## 5. Logs checken

```bash
pm2 logs speed --lines 20
```

## Updaten (spaeter)

```bash
cd /home/archimedes/speed
git pull
npm install
pm2 restart speed
```
