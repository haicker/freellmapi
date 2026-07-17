import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import { getDb } from '../db/index.js';
import { resolveProvider, getAllProviders } from '../providers/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import { parseKeysFromFile, stripJsoncComments, stripTrailingCommas } from '../lib/key-parser.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import { checkKeyHealth } from '../services/health.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const keysRouter = Router();

// Active providers — must match providers/index.ts registrations + shared/types.ts Platform.
// Moonshot and MiniMax direct integrations were dropped in V4. HuggingFace
// was dropped in V4 and re-added in V13 via the router.huggingface.co route.
// SambaNova was dropped in V23 (free tier permanently retired).
const PLATFORMS = [
  'google', 'groq', 'cerebras', 'nvidia', 'mistral',
  'openrouter', 'github', 'cohere', 'cloudflare', 'zhipu', 'ollama',
  'kilo', 'llm7', 'huggingface', 'opencode', 'ovh', 'agnes', 'reka', 'siliconflow',
  'routeway', 'bazaarlink', 'ainative', 'aion', 'requesty', 'nara', 'aihorde', 'custom',
] as const;

const ALLOWED_IMPORT_EXTENSIONS = new Set(['.env', '.json', '.jsonc', '.md', '.txt', '.csv']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_IMPORT_EXTENSIONS.has(ext)) {
      cb(new Error('Unsupported file type'));
      return;
    }
    cb(null, true);
  },
});

// `key` is optional so keyless providers (Kilo's anonymous gateway) can be added
// without one; the handler enforces a non-empty key for everyone else.
const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().optional(),
  label: z.string().optional(),
});

const updateKeySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().optional(),
}).refine(data => data.enabled !== undefined || data.label !== undefined, {
  message: 'At least one of enabled or label must be provided',
});

const importKeySchema = z.object({
  keyName: z.string().optional(),
  keyValue: z.string().min(1),
  platform: z.enum(PLATFORMS),
});

function handleUploadError(err: any, res: Response, next: NextFunction): boolean {
  if (!err) return false;
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { message: 'File too large. Maximum size is 5MB' } });
    return true;
  }
  if (err.code === 'LIMIT_FILE_COUNT') {
    res.status(413).json({ error: { message: 'Too many files. Maximum is 10' } });
    return true;
  }
  if (err.message?.includes('Unsupported file type')) {
    res.status(400).json({ error: { message: 'Unsupported file type' } });
    return true;
  }
  next(err);
  return true;
}

function parseUpload(file: Express.Multer.File) {
  const content = file.buffer.toString('utf8');
  if (!content.trim()) {
    throw Object.assign(new Error('File contains no data'), { status: 400 });
  }

  if (/\.jsonc?$/i.test(file.originalname)) {
    try {
      JSON.parse(stripTrailingCommas(stripJsoncComments(content)));
    } catch {
      throw Object.assign(new Error('Invalid JSON format'), { status: 400 });
    }
  }

  return parseKeysFromFile(content, file.originalname);
}

function splitRawKey(rawKey: string) {
  const eqIndex = rawKey.indexOf('=');
  return {
    keyName: eqIndex === -1 ? rawKey : rawKey.slice(0, eqIndex),
    keyValue: eqIndex === -1 ? '' : rawKey.slice(eqIndex + 1),
  };
}

function insertImportedKey(platform: (typeof PLATFORMS)[number], keyName: string, keyValue: string) {
  if (platform === 'custom') {
    throw new Error('Custom providers must be added with a base URL');
  }
  if (!resolveProvider(platform)) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(keyValue.trim());
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, keyName, encrypted, iv, authTag);
}

// Count enabled catalog models for a platform. Used to warn when a key is
// added for a provider that has zero models in the operator's current catalog.
function enabledModelCount(platform: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM models WHERE platform = ? AND enabled = 1',
  ).get(platform) as { c: number };
  return row.c;
}

// Non-null when the just-added key has no usable models yet, so the client can
// explain the silence instead of leaving the user staring at an empty list.
function noModelsNotice(platform: string): string | undefined {
  if (enabledModelCount(platform) > 0) return undefined;
  return (
    `Key saved, but no models are available for ${platform} yet. ` +
    `Please add models manually through the custom provider interface or wait for automatic model discovery.`
  );
}

// Auto-discover models from the provider's /v1/models endpoint and add them to the database
async function discoverAndSaveModels(platform: Platform, apiKey: string, keyId: number): Promise<number> {
  try {
    const provider = resolveProvider(platform);
    if (!provider || !provider.getAvailableModels) {
      return 0;
    }

    const models = await provider.getAvailableModels(apiKey);
    if (!models || models.length === 0) {
      return 0;
    }

    // Only auto-add FREE text chat models. Aggregators like OpenRouter/Routeway
    // mix free (`:free` suffix / zero pricing) and paid routes in their
    // /v1/models listing; adding paid routes would 402 on first use. Only
    // models explicitly flagged as free are auto-added — if none are flagged,
    // nothing is added (the user can manually add via the model dialog).
    const modelsToAdd = models.filter(m => m.free === true);

    const db = getDb();

    // Clean up models previously auto-discovered for this platform (bound to a
    // key_id) that are NOT in the new free-only set. This removes leftover
    // non-free models from a prior add (e.g. when the free filter was absent or
    // buggy), so re-adding a key doesn't leave 300+ unusable paid models in the
    // database. Catalog-managed models (key_id IS NULL) are never touched.
    const keepIds = new Set(modelsToAdd.map(m => m.id));
    const staleRows = db.prepare(
      `SELECT id, model_id FROM models WHERE platform = ? AND key_id IS NOT NULL`,
    ).all(platform) as { id: number; model_id: string }[];
    for (const row of staleRows) {
      if (!keepIds.has(row.model_id)) {
        db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(row.id);
        db.prepare('DELETE FROM models WHERE id = ?').run(row.id);
      }
    }

    let addedCount = 0;

    for (const model of modelsToAdd) {
      try {
        // Check if model already exists
        const existing = db.prepare(
          'SELECT id FROM models WHERE platform = ? AND model_id = ?'
        ).get(platform, model.id) as { id: number } | undefined;

        if (!existing) {
          // Add new model
          const info = db.prepare(`
            INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                             rpm_limit, rpd_limit, tpm_limit, tpd_limit, context_window,
                             enabled, supports_vision, supports_tools, key_id)
            VALUES (?, ?, ?, 50, 5, 'Medium', 60, 1000, 10000, null, 8192, 1, ?, ?, ?)
          `).run(
            platform,
            model.id,
            model.name,
            model.supportsVision ? 1 : 0,
            model.supportsTools ? 1 : 0,
            keyId
          );
          const newId = Number(info.lastInsertRowid);
          addedCount++;

          // The Models page is a `fallback_config JOIN models`; without a
          // companion fallback_config row the model is written but invisible.
          const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(newId);
          if (!inChain) {
            const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
            db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(newId, max.m + 1);
          }
        }
      } catch (err) {
        console.warn(`[${platform}] Failed to add model ${model.id}:`, err);
      }
    }

    return addedCount;
  } catch (err) {
    console.warn(`[${platform}] Model discovery failed:`, err);
    return 0;
  }
}

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const customModels = [
    ...db.prepare(`
      SELECT key_id, id, 'chat' AS kind, model_id, display_name, NULL AS family
        FROM models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, 'embedding' AS kind, model_id, display_name, family
        FROM embedding_models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
    ...db.prepare(`
      SELECT key_id, id, modality AS kind, model_id, display_name, NULL AS family
        FROM media_models
       WHERE platform = 'custom' AND key_id IS NOT NULL
    `).all() as any[],
  ];
  const modelsByKeyId = new Map<number, any[]>();
  for (const m of customModels) {
    const keyId = Number(m.key_id);
    if (!Number.isInteger(keyId)) continue;
    const list = modelsByKeyId.get(keyId) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      modelId: m.model_id,
      displayName: m.display_name,
      family: m.family ?? null,
    });
    modelsByKeyId.set(keyId, list);
  }
  for (const list of modelsByKeyId.values()) {
    list.sort((a, b) => {
      const ka = ['chat', 'embedding', 'image', 'audio'].indexOf(a.kind);
      const kb = ['chat', 'embedding', 'image', 'audio'].indexOf(b.kind);
      return (ka - kb) || String(a.displayName).localeCompare(String(b.displayName));
    });
  }

  // Build platform-level models for built-in (non-custom) providers
  const platformModelsMap = new Map<string, any[]>();

  const chatPlatformModels = db.prepare(`
    SELECT platform, id, 'chat' AS kind, model_id, display_name, NULL AS family
      FROM models
     WHERE platform != 'custom'
  `).all() as any[];

  const embedPlatformModels = db.prepare(`
    SELECT platform, id, 'embedding' AS kind, model_id, display_name, family
      FROM embedding_models
     WHERE platform != 'custom'
  `).all() as any[];

  const mediaPlatformModels = db.prepare(`
    SELECT platform, id, modality AS kind, model_id, display_name, NULL AS family
      FROM media_models
     WHERE platform != 'custom'
  `).all() as any[];

  for (const m of [...chatPlatformModels, ...embedPlatformModels, ...mediaPlatformModels]) {
    const list = platformModelsMap.get(m.platform) ?? [];
    list.push({
      id: m.id,
      kind: m.kind,
      modelId: m.model_id,
      displayName: m.display_name,
      family: m.family ?? null,
    });
    platformModelsMap.set(m.platform, list);
  }
  for (const list of platformModelsMap.values()) {
    list.sort((a, b) => {
      const ka = ['chat', 'embedding', 'image', 'audio'].indexOf(a.kind);
      const kb = ['chat', 'embedding', 'image', 'audio'].indexOf(b.kind);
      return (ka - kb) || String(a.displayName).localeCompare(String(b.displayName));
    });
  }

  const platformModels: Record<string, any[]> = Object.fromEntries(platformModelsMap);

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      baseUrl: row.base_url ?? null,
      status: row.status,
      enabled: row.enabled === 1,
      keyless: resolveProvider(row.platform)?.keyless === true,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
      models: row.platform === 'custom' ? (modelsByKeyId.get(row.id) ?? []) : undefined,
    };
  });

  res.json({ keys, platformModels });
});

// Export keys — returns plaintext keys in the requested format.
// GET /api/keys/export?format=json|env|csv&healthy=true
// The response is the raw file download (Content-Type varies by format).
keysRouter.get('/export', (req: Request, res: Response) => {
  const db = getDb();
  const format = (req.query.format as string) ?? 'json';
  const healthyOnly = req.query.healthy === 'true';

  let whereClause = '';
  if (healthyOnly) {
    whereClause = "WHERE status = 'healthy'";
  }

  const rows = db.prepare(`SELECT * FROM api_keys ${whereClause} ORDER BY platform, created_at ASC`).all() as any[];

  // Decrypt and filter — only export keys with a real value
  const decryptedKeys = rows
    .map(row => {
      let key = '';
      try {
        key = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      } catch {
        key = '';
      }
      return {
        platform: row.platform,
        key,
        label: row.label || '',
        baseUrl: row.base_url || undefined,
      };
    })
    .filter(k => {
      const v = k.key.trim();
      return v.length > 0 && v !== 'no-key';
    });

  if (decryptedKeys.length === 0) {
    res.status(404).json({ error: { message: 'No keys to export' } });
    return;
  }

  if (format === 'env') {
    // .env format: GOOGLE_KEY=xxx\nGROQ_KEY=yyy
    const lines = decryptedKeys.map(k => {
      const envKey = `${k.platform.toUpperCase()}_KEY=${k.key}`;
      return k.label ? `# ${k.label}\n${envKey}` : envKey;
    });
    const content = lines.join('\n\n') + '\n';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.env"');
    res.send(content);
    return;
  }

  if (format === 'csv') {
    // CSV format: platform,key,label
    const escCsv = (v: string) => `"${v.replace(/"/g, '""')}"`;
    // CSV formula-injection guard: a spreadsheet treats a cell that starts with
    // =, +, -, @, tab or CR as a live formula, so a label like `=HYPERLINK(...)`
    // would execute on open. Prefix such cells with a single quote to force them
    // to be read as text. Applied only to free-text fields the user controls
    // (labels); the key value must round-trip verbatim for re-import, and the
    // platform is one of our own fixed enum values.
    const neutralize = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
    const header = 'platform,key,label';
    const lines = decryptedKeys.map(k =>
      [escCsv(k.platform), escCsv(k.key), escCsv(neutralize(k.label))].join(',')
    );
    const content = [header, ...lines].join('\n') + '\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.csv"');
    res.send(content);
    return;
  }

  // Default: JSON format (round-trip safe — can be imported directly)
  const jsonExport = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: 'freellmapi',
    keys: decryptedKeys,
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="freellmapi-keys.json"');
  res.json(jsonExport);
});

// Add a key
keysRouter.post('/', async (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, label } = parsed.data;
  const isKeyless = resolveProvider(platform)?.keyless === true;
  const rawKey = parsed.data.key?.trim() ?? '';

  if (!isKeyless && !rawKey) {
    res.status(400).json({ error: { message: 'key is required' } });
    return;
  }

  // Keyless providers (Kilo anon) store a sentinel so routing sees the platform
  // as configured; the provider omits the auth header on outgoing calls.
  const keyToStore = isKeyless ? (rawKey || 'no-key') : rawKey;

  const db = getDb();

  // A keyless provider needs only one sentinel row — re-enable an existing one
  // instead of piling up duplicates each time the user clicks "Add".
  if (isKeyless) {
    const existing = db.prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number } | undefined;
    if (existing) {
      db.prepare("UPDATE api_keys SET enabled = 1, status = 'unknown' WHERE id = ?").run(existing.id);

      // Auto health-check + discover free models for the re-enabled keyless provider.
      let keyStatus: string = 'unknown';
      let discoveredModels = 0;
      try {
        keyStatus = await checkKeyHealth(existing.id);
      } catch (err) {
        console.warn(`[${platform}] Health check failed:`, err);
      }
      if (keyStatus === 'healthy') {
        try {
          discoveredModels = await discoverAndSaveModels(platform, keyToStore, existing.id);
          console.log(`[${platform}] Discovered and added ${discoveredModels} free models`);
        } catch (err) {
          console.warn(`[${platform}] Model discovery failed:`, err);
        }
      }

      res.status(200).json({
        id: existing.id,
        platform,
        label: label ?? '',
        maskedKey: maskKey(keyToStore),
        status: keyStatus,
        enabled: true,
        modelsAvailable: enabledModelCount(platform),
        discoveredModels,
        notice: noModelsNotice(platform),
      });
      return;
    }
  }

  const { encrypted, iv, authTag } = encrypt(keyToStore);
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);

  const keyId = Number(result.lastInsertRowid);

  // Auto health-check, then discover free models if the key is valid.
  // Applies to both keyed and keyless providers — keyless checkKeyHealth is
  // instant (marks healthy without a network probe), and keyless providers
  // (Kilo, OVH) support getAvailableModels for catalog discovery.
  let keyStatus: string = 'unknown';
  let discoveredModels = 0;
  try {
    keyStatus = await checkKeyHealth(keyId);
  } catch (err) {
    console.warn(`[${platform}] Health check failed:`, err);
  }
  if (keyStatus === 'healthy') {
    try {
      discoveredModels = await discoverAndSaveModels(platform, keyToStore, keyId);
      console.log(`[${platform}] Discovered and added ${discoveredModels} free models`);
    } catch (err) {
      console.warn(`[${platform}] Model discovery failed:`, err);
    }
  }

  res.status(201).json({
    id: keyId,
    platform,
    label: label ?? '',
    maskedKey: maskKey(keyToStore),
    status: keyStatus,
    enabled: true,
    modelsAvailable: enabledModelCount(platform),
    discoveredModels,
    notice: noModelsNotice(platform),
  });
});

// Discover available models from a provider without adding them
keysRouter.get('/:id/discover-models', async (req: Request, res: Response) => {
  const keyId = parseInt(String(req.params.id), 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const keyRow = db.prepare('SELECT platform, encrypted_key, base_url FROM api_keys WHERE id = ?').get(keyId) as
    { platform: string; encrypted_key: string; base_url?: string | null } | undefined;

  if (!keyRow) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  try {
    const keyCrypto = db.prepare('SELECT iv, auth_tag FROM api_keys WHERE id = ?').get(keyId) as
      { iv: string; auth_tag: string };
    const apiKey = decrypt(keyRow.encrypted_key, keyCrypto.iv, keyCrypto.auth_tag);

    // Custom (user-supplied base_url) providers must be resolved with their
    // stored base URL, otherwise resolveProvider('custom') returns undefined
    // and discovery silently fails.
    const provider = resolveProvider(keyRow.platform as Platform, keyRow.base_url);
    if (!provider || !provider.getAvailableModels) {
      res.status(400).json({ error: { message: 'Provider does not support model discovery' } });
      return;
    }

    // Keyless/sentinel rows (local Ollama, vLLM, anonymous gateways) store
    // 'no-key' instead of a real credential. Don't send `Bearer no-key` when
    // listing models — mark the provider keyless so it omits the auth header.
    if (apiKey === 'no-key') provider.keyless = true;

    const models = await provider.getAvailableModels(apiKey);
    if (!models) {
      res.status(400).json({ error: { message: 'Failed to discover models' } });
      return;
    }

    // Filter out models that already exist in the database
    const existingModels = db.prepare(
      'SELECT model_id FROM models WHERE platform = ? AND key_id = ?'
    ).all(keyRow.platform, keyId) as { model_id: string }[];
    const existingIds = new Set(existingModels.map(m => m.model_id));

    const availableModels = models.filter(model => !existingIds.has(model.id));

    res.json({
      platform: keyRow.platform,
      totalModels: models.length,
      availableModels
    });
  } catch (err: any) {
    console.warn(`[${keyRow.platform}] Model discovery failed:`, err);
    res.status(500).json({ error: { message: 'Model discovery failed: ' + err.message } });
  }
});

// Add specific models to the database
keysRouter.post('/:id/add-models', async (req: Request, res: Response) => {
  const keyId = parseInt(String(req.params.id), 10);
  if (isNaN(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { modelIds, models: modelPayload } = req.body;
  if (
    !(Array.isArray(modelPayload) && modelPayload.length > 0) &&
    !Array.isArray(modelIds)
  ) {
    res.status(400).json({ error: { message: 'models or modelIds must be a non-empty array' } });
    return;
  }

  const db = getDb();
  const keyRow = db.prepare('SELECT platform, encrypted_key, base_url FROM api_keys WHERE id = ?').get(keyId) as
    { platform: string; encrypted_key: string; base_url?: string | null } | undefined;

  if (!keyRow) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  try {
    const keyCrypto = db.prepare('SELECT iv, auth_tag FROM api_keys WHERE id = ?').get(keyId) as
      { iv: string; auth_tag: string };
    const apiKey = decrypt(keyRow.encrypted_key, keyCrypto.iv, keyCrypto.auth_tag);

    // Prefer the client-supplied list (the dialog already discovered these
    // models) — this avoids a SECOND upstream /models fetch that could hang or
    // be rate-limited immediately after the discover call. Fall back to a
    // re-discovery only when the client sent ids without metadata.
    let modelsToAdd: Array<{ id: string; name: string; supportsTools?: boolean; supportsVision?: boolean }>;

    if (Array.isArray(modelPayload) && modelPayload.length > 0) {
      modelsToAdd = modelPayload
        .filter((m: any) => m && typeof m.id === 'string' && m.id.length > 0)
        .map((m: any) => ({
          id: m.id,
          name: typeof m.name === 'string' && m.name.length > 0 ? m.name : m.id,
          supportsTools: !!m.supportsTools,
          supportsVision: !!m.supportsVision,
        }));
    } else {
      // Custom (user-supplied base_url) providers must be resolved with their
      // stored base URL, otherwise resolveProvider('custom') returns undefined
      // and discovery silently fails.
      const provider = resolveProvider(keyRow.platform as Platform, keyRow.base_url);
      if (!provider || !provider.getAvailableModels) {
        res.status(400).json({ error: { message: 'Provider does not support model discovery' } });
        return;
      }

      // Keyless/sentinel rows (local Ollama, vLLM, anonymous gateways) store
      // 'no-key' instead of a real credential. Don't send `Bearer no-key` when
      // listing models — mark the provider keyless so it omits the auth header.
      if (apiKey === 'no-key') provider.keyless = true;

      const models = await provider.getAvailableModels(apiKey);
      if (!models) {
        res.status(400).json({ error: { message: 'Failed to discover models' } });
        return;
      }

      modelsToAdd = models.filter(model => (modelIds as string[]).includes(model.id));
    }

    let addedCount = 0;

    for (const model of modelsToAdd) {
      try {
        const existing = db.prepare(
          'SELECT id FROM models WHERE platform = ? AND model_id = ?'
        ).get(keyRow.platform, model.id) as { id: number } | undefined;

        if (!existing) {
          const info = db.prepare(`
            INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                             rpm_limit, rpd_limit, tpm_limit, tpd_limit, context_window,
                             enabled, supports_vision, supports_tools, key_id)
            VALUES (?, ?, ?, 50, 5, 'Medium', 60, 1000, 10000, null, 8192, 1, ?, ?, ?)
          `).run(
            keyRow.platform,
            model.id,
            model.name,
            model.supportsVision ? 1 : 0,
            model.supportsTools ? 1 : 0,
            keyId
          );
          const newId = Number(info.lastInsertRowid);
          addedCount++;

          // The Models page (GET /api/fallback) is a `fallback_config JOIN
          // models` — a model only appears there if it has a companion
          // fallback_config row. Without this, discovered models are written to
          // `models` but stay invisible in the UI. Append to the chain with the
          // next priority (mirrors the custom-provider registration path).
          const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(newId);
          if (!inChain) {
            const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
            db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(newId, max.m + 1);
          }
        }
      } catch (err) {
        console.warn(`[${keyRow.platform}] Failed to add model ${model.id}:`, err);
      }
    }

    res.json({
      added: addedCount,
      totalRequested: modelsToAdd.length,
    });
  } catch (err: any) {
    console.warn(`[${keyRow.platform}] Model addition failed:`, err);
    res.status(500).json({ error: { message: 'Model addition failed: ' + err.message } });
  }
});

// ── Custom OpenAI-compatible providers (#117, #212) ───────────────────────
// User-configured endpoints (llama.cpp / LM Studio / vLLM / Ollama / any
// OpenAI-compatible base_url). Each DISTINCT base_url gets its own 'custom'
// api_keys row, and every registered model binds to its endpoint's key via
// models.key_id — so several custom providers coexist without overwriting
// each other (#212). Re-submitting an existing base_url updates its key/label;
// re-registering an existing model id re-binds it to the submitted endpoint.
// A model can be given as a bare id ("qwen3:4b") or as {model, displayName}.
// `model`/`displayName` (singular) stay supported for older clients; `models`
// (plural) lets one submit bind several model ids to the same endpoint. (#281)
// A custom model can declare its capabilities at registration. `supportsTools`
// defaults to 1 (modern OpenAI-compatible servers — Ollama, vLLM, LM Studio —
// all emit tool calls), `supportsVision` defaults to 0 unless declared. Leaving
// a flag unset keeps the DB default on insert and preserves the stored value on
// re-registration, so a capability the user later toggled isn't clobbered. (#470)
const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    displayName: z.string().optional(),
    supportsTools: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
  }),
]);
const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl must be a valid URL'),
  model: z.string().optional(),
  models: z.array(modelEntrySchema).optional(),
  displayName: z.string().optional(),
  apiKey: z.string().optional(),
  label: z.string().optional(),
  // Top-level defaults applied to every model in this submit; a per-entry flag
  // (object form) overrides them for that one model.
  supportsTools: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
});

keysRouter.post('/custom', async (req: Request, res: Response) => {
  const parsed = customProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const baseUrl = parsed.data.baseUrl.trim().replace(/\/+$/, '');

  // SSRF guard (#440): a base_url is the one user-controlled outbound target.
  // Cloud metadata / link-local addresses are rejected outright; private
  // ranges too when FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS is set. Re-checked
  // at request time in proxyFetch for URLs already in the DB.
  const verdict = await assessProviderUrl(baseUrl);
  if (!verdict.allowed) {
    res.status(400).json({ error: { message: `baseUrl rejected: ${verdict.reason}` } });
    return;
  }
  // Local servers often need no key; keep a sentinel so there's always a bearer.
  const providedKey = parsed.data.apiKey?.trim() || undefined;
  const label = parsed.data.label?.trim() || undefined;

  // Flatten singular + plural inputs into one list, dedupe by model id, drop
  // blanks. The singular `displayName` only applies to a lone `model` (it can't
  // sensibly fan out across many ids). Capability flags resolve per-entry first,
  // then fall back to the submit-level defaults, then to undefined (DB default).
  const topTools = parsed.data.supportsTools;
  const topVision = parsed.data.supportsVision;
  const entries: { modelId: string; displayName: string; supportsTools?: boolean; supportsVision?: boolean }[] = [];
  const seen = new Set<string>();
  const addEntry = (rawId: string, rawDisplay?: string, tools?: boolean, vision?: boolean) => {
    const modelId = rawId.trim();
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    entries.push({
      modelId,
      displayName: (rawDisplay?.trim() || modelId),
      supportsTools: tools ?? topTools,
      supportsVision: vision ?? topVision,
    });
  };
  if (parsed.data.model?.trim()) addEntry(parsed.data.model, parsed.data.displayName);
  for (const m of parsed.data.models ?? []) {
    if (typeof m === 'string') addEntry(m);
    else addEntry(m.model, m.displayName, m.supportsTools, m.supportsVision);
  }

  // A custom endpoint may be registered with NO models up front — the caller
  // can discover models later through the model-selection dialog. We still
  // create the api_keys row (the endpoint) and skip the model insert loop.
  const db = getDb();
  const upsert = db.transaction(() => {
    // One 'custom' key row PER ENDPOINT (matched on base_url). Re-submitting
    // the same endpoint updates its key/label; a new base_url gets its own
// row instead of clobbering the previous provider. (#212) Re-submitting with a
// blank key preserves the stored key; only a provided key updates credentials.
    const existing = db.prepare("SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'custom' AND base_url = ? LIMIT 1")
      .get(baseUrl) as { id: number; encrypted_key: string; iv: string; auth_tag: string } | undefined;
    let keyId: number;
    let storedKeyForMask = providedKey ?? 'no-key';
    if (existing) {
      keyId = existing.id;
      if (providedKey) {
        const { encrypted, iv, authTag } = encrypt(providedKey);
        db.prepare("UPDATE api_keys SET label = COALESCE(?, label), encrypted_key = ?, iv = ?, auth_tag = ?, status = 'unknown', enabled = 1 WHERE id = ?")
          .run(label ?? null, encrypted, iv, authTag, existing.id);
        storedKeyForMask = providedKey;
      } else {
        try {
          storedKeyForMask = decrypt(existing.encrypted_key, existing.iv, existing.auth_tag);
        } catch {
          storedKeyForMask = 'no-key';
        }
        db.prepare("UPDATE api_keys SET label = COALESCE(?, label), status = 'unknown', enabled = 1 WHERE id = ?")
          .run(label ?? null, existing.id);
      }
    } else {
      const keyToStore = providedKey ?? 'no-key';
      const { encrypted, iv, authTag } = encrypt(keyToStore);
      const r = db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
        VALUES ('custom', ?, ?, ?, ?, 'unknown', 1, ?)
      `).run(label ?? 'Custom', encrypted, iv, authTag, baseUrl);
      keyId = Number(r.lastInsertRowid);
      storedKeyForMask = keyToStore;
    }

    const registered: { modelDbId: number; model: string; displayName: string; supportsTools: boolean; supportsVision: boolean }[] = [];
    for (const { modelId, displayName, supportsTools, supportsVision } of entries) {
      // Register each model bound to THIS endpoint's key. Custom models carry no
      // rate limits and start at the neutral intelligence score of 50.
      // Re-registering an existing model id re-binds it (model ids are unique
      // per platform, so one id can't live on two endpoints at once).
      // Capability flags: an unset flag binds NULL so COALESCE picks the insert
      // default (tools 1, vision 0) on a new row and preserves the existing
      // value on re-registration. (#470)
      const toolsParam = supportsTools === undefined ? null : (supportsTools ? 1 : 0);
      const visionParam = supportsVision === undefined ? null : (supportsVision ? 1 : 0);
      db.prepare(`
        INSERT INTO models
          (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
           rpm_limit, rpd_limit, tpm_limit, tpd_limit, context_window, enabled, key_id,
           supports_tools, supports_vision)
        VALUES ('custom', @modelId, @displayName, 50, 50, 'Custom', NULL, NULL, NULL, NULL, NULL, 1, @keyId,
           COALESCE(@tools, 1), COALESCE(@vision, 0))
        ON CONFLICT(platform, model_id)
        DO UPDATE SET
          display_name = excluded.display_name,
          key_id = excluded.key_id,
          enabled = 1,
          supports_tools = COALESCE(@tools, supports_tools),
          supports_vision = COALESCE(@vision, supports_vision)
      `).run({ modelId, displayName, keyId, tools: toolsParam, vision: visionParam });

      const modelRow = db.prepare("SELECT id, supports_tools, supports_vision FROM models WHERE platform = 'custom' AND model_id = ?").get(modelId) as { id: number; supports_tools: number; supports_vision: number };

      // Append to the fallback chain if not already present.
      const inChain = db.prepare('SELECT 1 FROM fallback_config WHERE model_db_id = ?').get(modelRow.id);
      if (!inChain) {
        const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
        db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelRow.id, max.m + 1);
      }

      registered.push({
        modelDbId: modelRow.id,
        model: modelId,
        displayName,
        supportsTools: modelRow.supports_tools === 1,
        supportsVision: modelRow.supports_vision === 1,
      });
    }

    return { keyId, registered, storedKeyForMask };
  });

  const { keyId, registered, storedKeyForMask } = upsert();
  // `model`/`displayName`/`modelDbId` echo the first model for older clients;
  // `models` carries the full set registered in this call. When no models were
  // supplied these are null (the endpoint was registered for later discovery).
  const first = registered[0];
  res.status(201).json({
    success: true,
    keyId,
    modelDbId: first?.modelDbId ?? null,
    platform: 'custom',
    baseUrl,
    model: first?.model ?? null,
    displayName: first?.displayName ?? null,
    supportsTools: first?.supportsTools ?? null,
    supportsVision: first?.supportsVision ?? null,
    models: registered,
    maskedKey: maskKey(storedKeyForMask),
  });
});

keysRouter.post('/import', (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      if (!req.file) {
        res.status(400).json({ error: { message: 'No file uploaded' } });
        return;
      }

      const result = parseUpload(req.file);
      const imported: Array<{ keyName: string; platform: string }> = [];
      const skipped = [...result.skipped];
      const errors: Array<{ key: string; error: string }> = [];

      for (const parsedKey of result.keys) {
        const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
        if (!parsedKey.platform) {
          skipped.push(keyName);
          continue;
        }
        const platformParse = z.enum(PLATFORMS).safeParse(parsedKey.platform);
        if (!platformParse.success || platformParse.data === 'custom') {
          skipped.push(keyName);
          continue;
        }
        if (!keyValue.trim()) {
          errors.push({ key: keyName, error: 'keyValue must be at least 1 character' });
          continue;
        }

        try {
          insertImportedKey(platformParse.data, keyName, keyValue);
          imported.push({ keyName, platform: platformParse.data });
        } catch (insertErr) {
          errors.push({ key: keyName, error: (insertErr as Error).message });
        }
      }

      res.json({
        imported: imported.length,
        skipped,
        errors,
        total: result.keys.length + result.skipped.length,
      });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

keysRouter.post('/preview', (req: Request, res: Response, next: NextFunction) => {
  upload.array('files', 10)(req, res, (err: any) => {
    if (handleUploadError(err, res, next)) return;

    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: { message: 'No files uploaded' } });
        return;
      }

      const keys: Array<{ keyName: string; keyValue: string; detectedPlatform: string | null; prefix: string; isDuplicate: boolean }> = [];
      const skipped: string[] = [];

      // Build a set of existing decrypted key values for duplicate detection
      const db = getDb();
      const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
      const existingKeys = new Set<string>();
      for (const row of existingRows) {
        try {
          existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
        } catch { /* skip undecryptable rows */ }
      }

      let duplicateCount = 0;

      for (const file of files) {
        const result = parseUpload(file);
        for (const parsedKey of result.keys) {
          const { keyName, keyValue } = splitRawKey(parsedKey.rawKey);
          const isDuplicate = existingKeys.has(keyValue.trim());
          if (isDuplicate) duplicateCount++;
          keys.push({
            keyName,
            keyValue,
            detectedPlatform: parsedKey.platform,
            prefix: parsedKey.prefix,
            isDuplicate,
          });
        }
        skipped.push(...result.skipped);
      }

      res.json({ keys, total: keys.length, skipped, duplicates: duplicateCount });
    } catch (handlerErr: any) {
      res.status(handlerErr.status ?? 500).json({ error: { message: handlerErr.message } });
    }
  });
});

keysRouter.post('/import-selected', (req: Request, res: Response) => {
  const parsed = z.object({ keys: z.array(importKeySchema).max(100) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  let imported = 0;
  let duplicateSkipped = 0;
  const errors: Array<{ key: string; error: string }> = [];

  // Build a set of existing decrypted key values for duplicate detection
  const db = getDb();
  const existingRows = db.prepare('SELECT encrypted_key, iv, auth_tag FROM api_keys').all() as any[];
  const existingKeys = new Set<string>();
  for (const row of existingRows) {
    try {
      existingKeys.add(decrypt(row.encrypted_key, row.iv, row.auth_tag));
    } catch { /* skip undecryptable rows */ }
  }

  for (const key of parsed.data.keys) {
    const keyName = key.keyName?.trim() || key.platform;
    if (key.platform === 'custom') {
      errors.push({ key: keyName, error: 'Custom providers must be added with a base URL' });
      continue;
    }

    if (existingKeys.has(key.keyValue.trim())) {
      duplicateSkipped++;
      errors.push({ key: keyName, error: 'Duplicate key — already exists' });
      continue;
    }

    try {
      insertImportedKey(key.platform, keyName, key.keyValue);
      imported++;
      existingKeys.add(key.keyValue.trim());
    } catch (err) {
      errors.push({ key: keyName, error: (err as Error).message });
    }
  }

  res.json({
    imported,
    skipped: [],
    errors,
    total: parsed.data.keys.length,
  });
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const row = db.prepare('SELECT platform FROM api_keys WHERE id = ?').get(id) as { platform: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const remove = db.transaction(() => {
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
    // Custom models exist only because POST /custom registered them alongside
    // their endpoint key (#117) — they can't route without it. Cascade away
    // the models bound to THIS endpoint (#212); other custom providers keep
    // theirs. Legacy rows (key_id NULL) are swept once no custom keys remain,
    // so they never linger in the fallback chain forever (#189).
    if (row.platform === 'custom') {
      const defaultEmbedding = db.prepare("SELECT value FROM settings WHERE key = 'embeddings_default_family'").get() as { value: string } | undefined;
      db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom' AND key_id = ?)").run(id);
      db.prepare("DELETE FROM models WHERE platform = 'custom' AND key_id = ?").run(id);
      db.prepare("DELETE FROM embedding_models WHERE platform = 'custom' AND key_id = ?").run(id);
      db.prepare("DELETE FROM media_models WHERE platform = 'custom' AND key_id = ?").run(id);
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE platform = 'custom'").get() as { n: number };
      if (remaining.n === 0) {
        db.prepare("DELETE FROM fallback_config WHERE model_db_id IN (SELECT id FROM models WHERE platform = 'custom')").run();
        db.prepare("DELETE FROM models WHERE platform = 'custom'").run();
        db.prepare("DELETE FROM embedding_models WHERE platform = 'custom'").run();
        db.prepare("DELETE FROM media_models WHERE platform = 'custom'").run();
      }
      if (defaultEmbedding) {
        const stillExists = db.prepare('SELECT 1 FROM embedding_models WHERE family = ? LIMIT 1').get(defaultEmbedding.value);
        if (!stillExists) {
          const replacement = db.prepare('SELECT family FROM embedding_models ORDER BY family, priority LIMIT 1').get() as { family: string } | undefined;
          if (replacement) {
            db.prepare("UPDATE settings SET value = ? WHERE key = 'embeddings_default_family'").run(replacement.family);
          }
        }
      }
    }
  });
  remove();

  res.json({ success: true });
});

// Toggle all keys for a platform
keysRouter.patch('/platform/:platform', (req: Request, res: Response) => {
  const platform = req.params.platform as string;
  if (!(PLATFORMS as readonly string[]).includes(platform)) {
    res.status(400).json({ error: { message: `Invalid platform '${platform}'` } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE platform = ?').run(enabled ? 1 : 0, platform);

  res.json({ success: true, enabled, updatedKeys: result.changes });
});

// Update key (toggle enable/disable or edit label)
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const parsed = updateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { enabled, label } = parsed.data;
  const updates: string[] = [];
  const values: (string | number)[] = [];

  if (enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(enabled ? 1 : 0);
  }
  if (label !== undefined) {
    updates.push('label = ?');
    values.push(label);
  }

  values.push(id);

  const db = getDb();
  const result = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  const response: Record<string, unknown> = { success: true };
  if (enabled !== undefined) response.enabled = enabled;
  if (label !== undefined) response.label = label;
  res.json(response);
});
