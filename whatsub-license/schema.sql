-- whatsub license server schema (Postgres dialect).
--
-- Apply with:
--   docker compose -f /opt/enghub/docker-compose.yml exec -T postgres \
--     psql -U whatsub_license_user -d whatsub_license < schema.sql
--
-- Ported from the old D1 SQLite schema. Differences:
--   - INTEGER PRIMARY KEY AUTOINCREMENT  →  BIGSERIAL PRIMARY KEY
--   - All ms timestamps stay BIGINT (matches the JS Date.now() the routes use)
--   - Foreign key enforced by default (no PRAGMA needed)

CREATE TABLE IF NOT EXISTS licenses (
    key          TEXT     PRIMARY KEY,
    max_devices  INTEGER  NOT NULL DEFAULT 3,
    created_at   BIGINT   NOT NULL,
    buyer_note   TEXT,
    email        TEXT
);

CREATE TABLE IF NOT EXISTS activations (
    id              BIGSERIAL  PRIMARY KEY,
    license_key     TEXT       NOT NULL REFERENCES licenses(key),
    fingerprint     TEXT       NOT NULL,
    device_label    TEXT,
    activated_at    BIGINT     NOT NULL,
    last_seen_at    BIGINT     NOT NULL,
    deactivated_at  BIGINT,

    UNIQUE (license_key, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_act_key      ON activations (license_key);
CREATE INDEX IF NOT EXISTS idx_act_active   ON activations (license_key, deactivated_at);
CREATE INDEX IF NOT EXISTS idx_lic_created  ON licenses    (created_at DESC);
