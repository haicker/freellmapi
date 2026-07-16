import type { Db } from '../types.js';

/**
 * Convert the legacy rank (1 = smartest) into a direct intelligence score
 * (100 = smartest). The transform is its own inverse, which keeps down() exact.
 */
function flipIntelligenceScores(db: Db): void {
  db.prepare(`
    UPDATE models
       SET intelligence_rank = 101 - intelligence_rank
     WHERE intelligence_rank BETWEEN 1 AND 100
  `).run();
}

export function up(db: Db): void {
  flipIntelligenceScores(db);
}

export function down(db: Db): void {
  flipIntelligenceScores(db);
}
