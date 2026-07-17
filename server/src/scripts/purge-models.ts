import '../../env.js';
import path from 'path';
import { fileURLToPath } from 'url';

import { initDb, getDb, getDefaultDbPath } from '../db/index.js';
import type { Db } from '../db/types.js';

/**
 * purge-models — wipe every preset/discovered model row from the database.
 *
 * Existing databases created before the schema-only refactor contain hundreds
 * of preset model rows that were seeded by the former migration system. This
 * script deletes ALL rows from the model tables so the catalog starts empty,
 * matching the new "models arrive only via provider discovery" contract.
 *
 * It deletes, in dependency order:
 *   - profile_models     (FK → models, ON DELETE CASCADE but explicit for clarity)
 *   - fallback_config    (FK → models)
 *   - models             (the chat model rows)
 *   - media_models       (image/audio model rows)
 *   - embedding_models   (embedding model rows)
 *   - model_overrides    (per-model local edit overrides — orphaned without models)
 *   - catalog_model_tombstones (deletion tombstones — moot once everything is gone)
 *
 * It then re-seeds the Default profile from the (now empty) fallback chain.
 * It NEVER touches api_keys, requests, settings, quirks, or sessions — those
 * survive the purge so the user keeps their keys, history, and configuration.
 *
 * Usage:
 *   npm run db:purge-models [--db <path>]
 *
 * Destructive and one-way — back up the database first.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function confirm(): boolean {
  process.stdout.write(
    '\n  This will DELETE every model row (models, fallback_config,\n' +
    '  profile_models, media_models, embedding_models, model_overrides,\n' +
    '  catalog_model_tombstones). api_keys, requests, and settings are kept.\n\n' +
    '  Type "yes" to confirm: ',
  );
  const answer = require('fs').readFileSync(0, 'utf8').trim().toLowerCase();
  return answer === 'yes' || answer === 'y';
}

function purge(db: Db): { models: number; media: number; embeddings: number } {
  const purgeAll = db.transaction(() => {
    // Child tables first (FKs).
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    const modelCount = (db.prepare('SELECT COUNT(*) AS c FROM models').get() as { c: number }).c;
    db.prepare('DELETE FROM models').run();
    const mediaCount = (db.prepare('SELECT COUNT(*) AS c FROM media_models').get() as { c: number }).c;
    db.prepare('DELETE FROM media_models').run();
    const embCount = (db.prepare('SELECT COUNT(*) AS c FROM embedding_models').get() as { c: number }).c;
    db.prepare('DELETE FROM embedding_models').run();
    db.prepare('DELETE FROM model_overrides').run();
    db.prepare('DELETE FROM catalog_model_tombstones').run();

    // Re-seed the Default profile from the (now empty) fallback chain so the
    // active profile still resolves cleanly. The profile row itself is kept.
    const active = db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'")
      .get() as { value: string } | undefined;
    if (active) {
      const profileId = parseInt(active.value, 10);
      db.prepare('DELETE FROM profile_models WHERE profile_id = ?').run(profileId);
    }

    return { models: modelCount, media: mediaCount, embeddings: embCount };
  });
  return purgeAll();
}

function main(): void {
  const dbPath = arg('db') ?? getDefaultDbPath();
  console.log(`Using database: ${dbPath}`);

  if (process.env.NODE_ENV === 'production' && !arg('force')) {
    console.error('Refusing to purge models in production. Pass --force to override.');
    process.exit(1);
  }

  if (!confirm()) {
    console.log('Aborted.');
    process.exit(0);
  }

  initDb(dbPath);
  const db = getDb();
  const counts = purge(db);

  console.log(
    `\nPurged ${counts.models} chat model(s), ${counts.media} media model(s), ` +
    `${counts.embeddings} embedding model(s).\nThe catalog is now empty. ` +
    `Add a provider key in the dashboard to discover models.`,
  );
}

main();
