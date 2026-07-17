import crypto from 'crypto';
import type { Db } from './types.js';
import { initEncryptionKey } from '../lib/crypto.js';

/**
 * Schema bootstrap — the single source of truth for the database structure.
 *
 * This replaced the migration system (server/src/db/migrations/ + migrate/).
 * The database schema is declared here as the FINAL state: every table, column
 * and index the application needs is created with `IF NOT EXISTS`, and every
 * column added by a former migration is backfilled with an idempotent
 * `ALTER TABLE ADD COLUMN`. On boot `initDb()` calls `initSchema()` once — new
 * databases are built to spec, existing databases are brought up to spec.
 *
 * NO MODEL DATA is seeded here. The catalog starts empty. Models arrive only
 * when a provider key is added — `discoverAndSaveModels()` pulls the provider's
 * `/v1/models` list and inserts the rows. Routing considers ONLY rows that
 * exist with `enabled = 1`; a model that was never pulled, or was deleted, can
 * never be routed.
 */
export function initSchema(db: Db): void {
  createTables(db);
  initEncryptionKey(db);
  ensureUnifiedKey(db);
  ensureDefaultProfile(db);
  seedQuirks(db);
}

// ── Tables ──────────────────────────────────────────────────────────────────

function createTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      intelligence_rank INTEGER NOT NULL,
      speed_rank INTEGER NOT NULL,
      size_label TEXT NOT NULL DEFAULT '',
      rpm_limit INTEGER,
      rpd_limit INTEGER,
      tpm_limit INTEGER,
      tpd_limit INTEGER,
      context_window INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      encrypted_key TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('request', 'tokens')),
      tokens INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rate_limit_cooldowns (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS fallback_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_db_id INTEGER NOT NULL REFERENCES models(id),
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(model_db_id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '#6366f1',
      type TEXT NOT NULL DEFAULT 'custom',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      auto_sort TEXT,
      layout_config TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      model_db_id INTEGER NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      UNIQUE(profile_id, model_db_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS request_hourly (
      hour TEXT PRIMARY KEY,
      total_requests INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS catalog_model_tombstones (
      kind TEXT NOT NULL DEFAULT 'chat',
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS model_overrides (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS embedding_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      max_input_tokens INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      key_id INTEGER,
      quota_label TEXT NOT NULL DEFAULT '',
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS media_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      modality TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      key_id INTEGER,
      quota_label TEXT NOT NULL DEFAULT '',
      UNIQUE(platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS quirks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL DEFAULT 'info',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS quirk_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quirk_id INTEGER NOT NULL REFERENCES quirks(id) ON DELETE CASCADE,
      platform TEXT,
      model_glob TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
    CREATE INDEX IF NOT EXISTS idx_requests_key_id ON requests(key_id);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_usage_lookup ON rate_limit_usage(platform, model_id, key_id, kind, created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_cooldowns_expires ON rate_limit_cooldowns(expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_api_keys_platform ON api_keys(platform);
    CREATE INDEX IF NOT EXISTS idx_request_hourly_hour ON request_hourly(hour);
    CREATE INDEX IF NOT EXISTS idx_catalog_model_tombstones_platform_model ON catalog_model_tombstones(platform, model_id);
    CREATE INDEX IF NOT EXISTS idx_quirk_targets_quirk ON quirk_targets(quirk_id);
  `);

  // Idempotent column adds — each column introduced by a former migration is
  // re-asserted here so an existing DB (built before this file existed) is
  // brought to the final schema on the next boot. SQLite's ALTER TABLE ADD
  // COLUMN has no IF NOT EXISTS, so we PRAGMA-check first.
  ensureColumn(db, 'models', 'key_id', 'INTEGER');
  ensureColumn(db, 'models', 'supports_tools', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'models', 'paid_input_per_m', 'REAL');
  ensureColumn(db, 'models', 'paid_output_per_m', 'REAL');
  ensureColumn(db, 'embedding_models', 'key_id', 'INTEGER');
  ensureColumn(db, 'media_models', 'key_id', 'INTEGER');
  ensureColumn(db, 'api_keys', 'base_url', 'TEXT');
  ensureColumn(db, 'requests', 'key_id', 'INTEGER');
  ensureColumn(db, 'requests', 'ttfb_ms', 'INTEGER');
  ensureColumn(db, 'requests', 'requested_model', 'TEXT');
  ensureColumn(db, 'requests', 'request_type', "TEXT NOT NULL DEFAULT 'chat'");
  ensureColumn(db, 'requests', 'client_ip', 'TEXT');
  ensureColumn(db, 'requests', 'client_user_agent', 'TEXT');
}

function ensureColumn(db: Db, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some(col => col.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

// ── Unified API key ──────────────────────────────────────────────────────────

function ensureUnifiedKey(db: Db): void {
  const existing = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'")
    .get() as { value: string } | undefined;
  if (!existing) {
    const key = `freellmapi-${crypto.randomBytes(24).toString('hex')}`;
    db.prepare("INSERT INTO settings (key, value) VALUES ('unified_api_key', ?)").run(key);
    console.log(`\n  Your unified API key: ${key}\n`);
  }
}

// ── Default profile ─────────────────────────────────────────────────────────

function ensureDefaultProfile(db: Db): void {
  // Convert any legacy built-in profiles to custom.
  db.prepare("UPDATE profiles SET type = 'custom' WHERE type = 'builtin'").run();

  const hasDefault = db.prepare("SELECT COUNT(*) as cnt FROM profiles WHERE type = 'default'")
    .get() as { cnt: number };
  if (hasDefault.cnt > 0) {
    db.prepare("UPDATE profiles SET emoji = '⚙️' WHERE type = 'default' AND emoji != '⚙️'").run();
    return;
  }

  const minOrder = (db.prepare('SELECT COALESCE(MIN(sort_order), 0) AS mn FROM profiles')
    .get() as { mn: number }).mn;
  const targetOrder = Math.min(-1, minOrder - 1);
  const result = db.prepare(
    "INSERT INTO profiles (name, emoji, color, type, sort_order) VALUES ('Default', '⚙️', '#6366f1', 'default', ?)",
  ).run(targetOrder);
  const profileId = result.lastInsertRowid as number;

  // Seed profile models from fallback_config (empty when no models exist yet).
  db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    SELECT ?, model_db_id, priority, enabled
    FROM fallback_config
    ORDER BY priority ASC
  `).run(profileId);

  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('active_profile_id', ?)
    ON CONFLICT(key) DO NOTHING
  `).run(String(profileId));

  console.log('Created Default profile');
}

// ── Quirks seed ──────────────────────────────────────────────────────────────
//
// Quirks are provider/model NOTES (not models themselves). They are inert when
// no matching model exists, so seeding them is safe and lets them light up the
// moment a matching model is pulled from a provider. The curated set is
// upserted on every boot (reset-then-insert the selectors) so edits in code
// take effect immediately; operator-added quirks (unknown slugs) are untouched.

type QuirkSeverity = 'info' | 'warning' | 'blocker';

interface QuirkSeed {
  slug: string;
  title: string;
  body: string;
  severity: QuirkSeverity;
  targets: Array<{ platform?: string; modelGlob?: string }>;
}

const QUIRK_SEEDS: QuirkSeed[] = [
  {
    slug: 'keyless-anonymous',
    title: 'No API key required',
    body: 'Routes anonymously — the catalog ships a keyless sentinel row and calls work with no account or key.',
    severity: 'info',
    targets: [{ platform: 'kilo' }, { platform: 'llm7' }, { platform: 'ovh' }],
  },
  {
    slug: 'ovh-anon-trickle',
    title: 'Anonymous tier is 2 req/min',
    body: 'OVH AI Endpoints anonymous mode is documented at 2 req/min per IP per model (observed even stricter across models). The 400 req/min authenticated tier requires a Public Cloud project with a payment method. Treat as a breadth/fallback tier, not a throughput tier.',
    severity: 'warning',
    targets: [{ platform: 'ovh' }],
  },
  {
    slug: 'or-free-cap-account-wide',
    title: 'Daily :free cap is account-wide',
    body: 'OpenRouter\'s :free daily cap (50/day, or 1000/day once you have ever bought $10 of credits) is shared across ALL :free models on the account, not per model. Per-row rpd values here are therefore optimistic; the router\'s cooldown handling absorbs the shared 429s.',
    severity: 'info',
    targets: [{ platform: 'openrouter', modelGlob: '*:free' }],
  },
  {
    slug: 'cloudflare-key-format',
    title: 'Key is account_id:token',
    body: 'Cloudflare Workers AI authenticates with a combined credential in the form "account_id:token", not a bare token.',
    severity: 'info',
    targets: [{ platform: 'cloudflare' }],
  },
  {
    slug: 'nvidia-rate-limited',
    title: 'Recurring free, 40 RPM, eval-only ToS',
    body: 'NVIDIA NIM uses a recurring per-account rate limit (40 RPM default, varies by model). The trial ToS still scopes usage to evaluation/prototyping, not production.',
    severity: 'info',
    targets: [{ platform: 'nvidia' }],
  },
  {
    slug: 'nim-gemma-hung',
    title: 'NIM gemma route hangs',
    body: 'The NVIDIA NIM gemma endpoint is listed but hangs (capacity starvation plus an upstream FlashAttention bug). Probe with a 120s timeout before re-enabling.',
    severity: 'blocker',
    targets: [{ platform: 'nvidia', modelGlob: '*gemma*' }],
  },
];

function seedQuirks(db: Db): void {
  const now = Date.now();
  const upsertQuirk = db.prepare(`
    INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms)
    VALUES (@slug, @title, @body, @severity, @now, @now)
    ON CONFLICT(slug) DO UPDATE SET
      title = excluded.title,
      body = excluded.body,
      severity = excluded.severity,
      updated_at_ms = excluded.updated_at_ms
  `);
  const getId = db.prepare('SELECT id FROM quirks WHERE slug = ?');
  const clearTargets = db.prepare('DELETE FROM quirk_targets WHERE quirk_id = ?');
  const addTarget = db.prepare(
    'INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES (?, ?, ?)',
  );

  const apply = db.transaction(() => {
    for (const s of QUIRK_SEEDS) {
      upsertQuirk.run({ slug: s.slug, title: s.title, body: s.body, severity: s.severity, now });
      const { id } = getId.get(s.slug) as { id: number };
      clearTargets.run(id);
      for (const t of s.targets) addTarget.run(id, t.platform ?? null, t.modelGlob ?? null);
    }
  });
  apply();
}
