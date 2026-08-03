# Database Schema

The database schema is declared as a single source of truth in
`src/db/schema.ts`. On every boot `initDb()` calls `initSchema(db)`, which
creates every table, column, and index with `IF NOT EXISTS` / idempotent
`ALTER TABLE ADD COLUMN` — a fresh database is built to spec, and an existing
database is brought up to spec automatically.

## No preset models

The catalog starts **empty**. No model rows are seeded. Models arrive only when
a provider key is added on the Keys page — `discoverAndSaveModels()` pulls the
provider's `/v1/models` list and inserts the rows into the `models` table.
Routing considers ONLY rows that exist with `enabled = 1`; a model that was
never pulled, or was deleted, can never be routed.

## One-time purge of legacy preset models

Existing databases that were created before this refactor contain hundreds of
preset model rows seeded by the former migration system. To wipe them and start
fresh from an empty catalog, run:

```sh
npm run db:purge-models
```

This deletes every row from `models`, `fallback_config`, `profile_models`,
`media_models`, and `embedding_models`, then rebuilds the Default profile from
the (now empty) fallback chain. It is a destructive, one-way operation — back
up the database first. It never touches `api_keys`, `requests`, or `settings`.

## Local development

The database is created at `server/data/freeapi.db` (override with
`FREEAPI_DB_PATH`). On first boot the schema is created and a unified API key
is generated and printed to the console. Add a provider key in the dashboard to
populate models.

## Exporting the catalog

The `export-catalog` script reads the live `models` table and writes a signed
catalog JSON for the standalone catalog server:

```sh
npm run export-catalog
```
