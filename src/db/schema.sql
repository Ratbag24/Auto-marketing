-- Autopilot Marketing schema.
-- Deliberately small: seven tables carry the whole product.

CREATE TABLE IF NOT EXISTS businesses (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  website         TEXT,
  one_liner       TEXT NOT NULL,   -- what you sell, one sentence
  audience        TEXT NOT NULL,   -- who you sell to
  tone            TEXT NOT NULL,   -- how you want to sound
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  -- 'auto' publishes without review; 'review' holds everything in a queue.
  approval_mode   TEXT NOT NULL DEFAULT 'auto'
                  CHECK (approval_mode IN ('auto', 'review')),
  autopilot       INTEGER NOT NULL DEFAULT 1,  -- per-business kill switch
  weekly_volume   INTEGER NOT NULL DEFAULT 10, -- target content items per week
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- A brand profile is generated once from the five onboarding fields and reused
-- for every planning run. This is what makes "minimal input" possible.
CREATE TABLE IF NOT EXISTS brand_profiles (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL,
  positioning     TEXT NOT NULL,
  value_props     TEXT NOT NULL,   -- JSON string[]
  segments        TEXT NOT NULL,   -- JSON {name, pains, hooks}[]
  pillars         TEXT NOT NULL,   -- JSON {name, description}[]
  voice           TEXT NOT NULL,   -- JSON {guidelines[], avoid[]}
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_brand_business
  ON brand_profiles(business_id, version DESC);

CREATE TABLE IF NOT EXISTS channel_accounts (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  handle          TEXT,            -- list id, @handle, page id, org urn
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  UNIQUE (business_id, channel)
);

CREATE TABLE IF NOT EXISTS content_items (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan_run_id     TEXT,
  channel         TEXT NOT NULL,
  pillar          TEXT NOT NULL,
  subject         TEXT,            -- email subject line; null elsewhere
  body            TEXT NOT NULL,
  hashtags        TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  cta             TEXT,
  scheduled_at    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('draft','scheduled','publishing',
                                    'published','failed','skipped')),
  -- 'live' once really sent; 'simulated' when the channel had no credentials.
  delivery        TEXT,
  external_id     TEXT,
  published_at    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_due
  ON content_items(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_items_business
  ON content_items(business_id, scheduled_at DESC);

-- One row per collection sweep per item, so performance is a time series
-- rather than a single mutable counter.
CREATE TABLE IF NOT EXISTS metrics (
  id              TEXT PRIMARY KEY,
  content_item_id TEXT NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL,
  captured_at     TEXT NOT NULL,
  impressions     INTEGER NOT NULL DEFAULT 0,
  clicks          INTEGER NOT NULL DEFAULT 0,
  opens           INTEGER NOT NULL DEFAULT 0,
  reactions       INTEGER NOT NULL DEFAULT 0,
  shares          INTEGER NOT NULL DEFAULT 0,
  comments        INTEGER NOT NULL DEFAULT 0,
  conversions     INTEGER NOT NULL DEFAULT 0,
  simulated       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_metrics_item
  ON metrics(content_item_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_metrics_business
  ON metrics(business_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS plan_runs (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','succeeded','failed')),
  items_created   INTEGER NOT NULL DEFAULT 0,
  strategy_note   TEXT,            -- the model's rationale, shown in the UI
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_runs_business
  ON plan_runs(business_id, started_at DESC);

-- Append-only audit log. Every publish, failure and plan lands here.
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  business_id     TEXT,
  level           TEXT NOT NULL DEFAULT 'info'
                  CHECK (level IN ('info','warn','error')),
  type            TEXT NOT NULL,
  message         TEXT NOT NULL,
  data            TEXT,            -- JSON
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_recent
  ON events(created_at DESC);
