// Migration: Remove Pollinations provider
// Created: 2026-07-17
//
// DOWN: irreversible - the Pollinations provider is permanently removed from
// the Platform type and provider registry; re-adding it would require
// re-registering the provider and re-seeding its model/catalog data.

import type { Db } from '../types.js';

/**
 * Pollinations (text.pollinations.ai) was a keyless anonymous-tier chat
 * provider. Its legacy text API was deprecated for authenticated users, and
 * the anonymous tier is queue-limited to 1 concurrent request serving a single
 * model (openai-fast). The provider is being removed; this migration purges
 * every database row that references platform = 'pollinations' so the schema
 * stays consistent with the code.
 *
 * Order matters: fallback_config has a non-cascading FK to models(id), so it
 * must be cleaned before the models rows are deleted. profile_models cascades
 * automatically, but we delete explicitly for clarity. Runtime tables
 * (rate_limit_*, provider_quota_*) are cleaned for hygiene. The
 * 'pollinations-degraded' quirk is dropped entirely (targets cascade), and the
 * pollinations target is removed from the 'keyless-anonymous' quirk.
 */
export function up(db: Db): void {
  const apply = db.transaction(() => {
    // 1. fallback_config — FK RESTRICT, must delete before models.
    db.prepare(`
      DELETE FROM fallback_config
      WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'pollinations')
    `).run();

    // 2. profile_models — has ON DELETE CASCADE, but delete explicitly.
    db.prepare(`
      DELETE FROM profile_models
      WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'pollinations')
    `).run();

    // 3. models — the chat model rows (e.g. openai-fast).
    db.prepare("DELETE FROM models WHERE platform = 'pollinations'").run();

    // 4. api_keys — the keyless sentinel row(s).
    db.prepare("DELETE FROM api_keys WHERE platform = 'pollinations'").run();

    // 5. media_models — image/audio model rows (if any were configured).
    db.prepare("DELETE FROM media_models WHERE platform = 'pollinations'").run();

    // 6. embedding_models — unlikely but clean for completeness.
    db.prepare("DELETE FROM embedding_models WHERE platform = 'pollinations'").run();

    // 7. Runtime tables — orphaned rate-limit / quota entries.
    db.prepare("DELETE FROM rate_limit_usage WHERE platform = 'pollinations'").run();
    db.prepare("DELETE FROM rate_limit_cooldowns WHERE platform = 'pollinations'").run();
    db.prepare("DELETE FROM provider_quota_state WHERE platform = 'pollinations'").run();
    db.prepare("DELETE FROM provider_quota_observations WHERE platform = 'pollinations'").run();

    // 8. Quirks — drop the pollinations-specific quirk (targets cascade via
    //    FK ON DELETE CASCADE on quirk_targets.quirk_id), and remove the
    //    pollinations target from the 'keyless-anonymous' quirk.
    db.prepare("DELETE FROM quirks WHERE slug = 'pollinations-degraded'").run();
    db.prepare("DELETE FROM quirk_targets WHERE platform = 'pollinations'").run();
  });
  apply();
}

export function down(db: Db): void {
  throw new Error('irreversible migration: Pollinations provider removed from codebase');
}
