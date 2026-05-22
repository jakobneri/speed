-- Speed Test Results Table (for cockpit PostgreSQL)
CREATE TABLE IF NOT EXISTS speedtest_results (
    id              SERIAL PRIMARY KEY,
    download_mbps   NUMERIC(10,2),
    upload_mbps     NUMERIC(10,2),
    ping_ms         NUMERIC(10,2),
    jitter_ms       NUMERIC(10,2),
    client_ip       TEXT,
    isp             TEXT,
    server_ip       TEXT,
    user_agent      TEXT,
    location        TEXT,
    connection_type TEXT,
    downlink_hint   NUMERIC(10,2),
    rtt_hint        NUMERIC(10,2),
    duration_s      NUMERIC(10,2),
    download_bytes  BIGINT,
    upload_bytes    BIGINT,
    tested_at       TIMESTAMPTZ DEFAULT NOW()
);

GRANT ALL ON speedtest_results TO cockpit_user;
GRANT USAGE, SELECT ON SEQUENCE speedtest_results_id_seq TO cockpit_user;
