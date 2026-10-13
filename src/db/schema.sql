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

-- ===========================================================================
-- Website intelligence: content, health and audience.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS websites (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,          -- origin, no trailing slash
  -- Public key embedded in the tracking snippet. Not a secret: it only
  -- authorises writing visits for this one site.
  tracking_key    TEXT NOT NULL UNIQUE,
  -- Set once the first beacon arrives, which proves the snippet is installed.
  verified_at     TEXT,
  monitor_enabled INTEGER NOT NULL DEFAULT 1,
  -- Optional string that must appear in the homepage HTML. Catches the case
  -- where the server returns 200 but the page is broken or empty.
  expected_text   TEXT,
  -- A visit to this path counts as a conversion.
  goal_path       TEXT,
  last_crawled_at TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (business_id, url)
);

CREATE TABLE IF NOT EXISTS pages (
  id               TEXT PRIMARY KEY,
  website_id       TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  path             TEXT NOT NULL,
  title            TEXT,
  meta_description TEXT,
  h1               TEXT,
  excerpt          TEXT,                  -- first ~600 chars of visible text
  word_count       INTEGER NOT NULL DEFAULT 0,
  status_code      INTEGER,
  internal_links   INTEGER NOT NULL DEFAULT 0,
  external_links   INTEGER NOT NULL DEFAULT 0,
  issues           TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  crawled_at       TEXT NOT NULL,
  UNIQUE (website_id, url)
);
CREATE INDEX IF NOT EXISTS idx_pages_site ON pages(website_id, crawled_at DESC);

CREATE TABLE IF NOT EXISTS health_checks (
  id                TEXT PRIMARY KEY,
  website_id        TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  checked_at        TEXT NOT NULL,
  ok                INTEGER NOT NULL,
  status_code       INTEGER,
  response_ms       INTEGER,
  ssl_days_left     INTEGER,
  -- 'up' | 'down' | 'broken' | 'slow' | 'content_missing'
  verdict           TEXT NOT NULL,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_health_site
  ON health_checks(website_id, checked_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id             TEXT PRIMARY KEY,
  website_id     TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  started_at     TEXT NOT NULL,
  resolved_at    TEXT,
  kind           TEXT NOT NULL,
  detail         TEXT,
  checks_failed  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_incidents_site
  ON incidents(website_id, started_at DESC);

-- One row per pageview. No IP address is ever stored: visitor_hash is a
-- daily-rotating salted digest, so a visitor cannot be followed across days.
CREATE TABLE IF NOT EXISTS visits (
  id              TEXT PRIMARY KEY,
  website_id      TEXT NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  occurred_at     TEXT NOT NULL,
  visitor_hash    TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  path            TEXT NOT NULL,
  referrer        TEXT,
  referrer_source TEXT,                  -- 'direct' | 'search' | 'social' | host
  country         TEXT,                  -- ISO-3166 alpha-2 where known
  region          TEXT,                  -- coarse region from tz or proxy
  timezone        TEXT,
  language        TEXT,
  device          TEXT,                  -- 'mobile' | 'tablet' | 'desktop'
  browser         TEXT,
  os              TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  -- Set to a content_items.id when the visit came from a post we published.
  content_item_id TEXT,
  is_entry        INTEGER NOT NULL DEFAULT 0,
  is_goal         INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_visits_site
  ON visits(website_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_business
  ON visits(business_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_session ON visits(session_id);
CREATE INDEX IF NOT EXISTS idx_visits_attribution
  ON visits(content_item_id) WHERE content_item_id IS NOT NULL;
