-- TURN traffic of a calendar month (UTC), as the Cron Trigger last read
-- it from Cloudflare's analytics (src/turncap.ts).
CREATE TABLE turn_usage (
  month TEXT PRIMARY KEY,    -- "2026-11"
  bytes INTEGER NOT NULL,    -- egress + ingress since the month began
  checked INTEGER NOT NULL   -- ms since the epoch of the successful check
);
