import type { Db } from '../types.js';

/**
 * Remove the monthly token budget concept and the provider quota tracking system.
 *
 * - Drops the monthly_token_budget column from the models table (free-tier
 *   token-allowance label, e.g. '~120M'). The tagline-driven budget parsing
 *   and the headroom guardrail that it fed are both gone.
 * - Drops the provider_quota_state and provider_quota_observations tables —
 *   the dynamic quota-observability ("额度跟踪") system that recorded per-key
 *   rate-limit headers and Retry-After signals.
 */
export function up(db: Db): void {
  db.prepare("ALTER TABLE models DROP COLUMN monthly_token_budget").run();
  db.prepare("DROP TABLE IF EXISTS provider_quota_state").run();
  db.prepare("DROP TABLE IF EXISTS provider_quota_observations").run();
}

export function down(db: Db): void {
  db.prepare("ALTER TABLE models ADD COLUMN monthly_token_budget TEXT NOT NULL DEFAULT ''").run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS provider_quota_state (
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, key_id, quota_pool_key, metric)
    )
  `).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_quota_state_platform ON provider_quota_state(platform, key_id, updated_at)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_quota_state_reset_at ON provider_quota_state(reset_at)").run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS provider_quota_observations (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      provider_account_id TEXT,
      model_id TEXT,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      status_code INTEGER,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      retry_after_ms INTEGER,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      raw_json TEXT,
      endpoint TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_provider_quota_observations_lookup ON provider_quota_observations(platform, key_id, quota_pool_key, metric, observed_at DESC)").run();
}
