import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const ASSET_COUNT = 20_000;
const MISS_COUNT = 400;
const MANAGED_COUNT = 18_000;
const outputPath = resolve(
  'docs/internal/research/2026-10-19-import-lookup-indexes-results.json',
);
const db = new Database(':memory:');

const roundMs = (milliseconds) => Number(milliseconds.toFixed(3));

try {
  db.exec(`
    CREATE TABLE assets (
      asset_id TEXT PRIMARY KEY,
      location_kind TEXT NOT NULL,
      linked_folder_id TEXT,
      path_identity TEXT NOT NULL,
      relative_file_path TEXT NOT NULL,
      deleted_at TEXT,
      current_revision_id TEXT
    );
    CREATE TABLE revisions (
      revision_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      content_fingerprint TEXT
    );
    CREATE INDEX revisions_asset_accepted_idx
      ON revisions(asset_id, accepted_at);
    CREATE UNIQUE INDEX assets_managed_path_identity_unique
      ON assets(path_identity) WHERE location_kind = 'managed';
    CREATE UNIQUE INDEX assets_linked_path_identity_unique
      ON assets(linked_folder_id, path_identity) WHERE location_kind = 'linked';
  `);

  const insertRevision = db.prepare(`
    INSERT INTO revisions(revision_id, asset_id, accepted_at, byte_size, content_fingerprint)
    VALUES (?, ?, '2026-10-19T00:00:00.000Z', ?, NULL)
  `);
  const insertAsset = db.prepare(`
    INSERT INTO assets(
      asset_id, location_kind, linked_folder_id, path_identity,
      relative_file_path, deleted_at, current_revision_id
    ) VALUES (?, ?, ?, ?, ?, NULL, ?)
  `);
  const seed = db.transaction(() => {
    for (let i = 0; i < ASSET_COUNT; i += 1) {
      const managed = i < MANAGED_COUNT;
      const id = `asset-${String(i).padStart(6, '0')}`;
      const revisionId = `revision-${String(i).padStart(6, '0')}`;
      const relativePath = `${managed ? 'managed' : 'linked'}/${String(i).padStart(6, '0')}.png`;
      const pathIdentity = relativePath.toLowerCase();
      insertRevision.run(revisionId, id, 1024 + (i % 4096));
      insertAsset.run(
        id,
        managed ? 'managed' : 'linked',
        managed ? null : `linked-folder-${i % 8}`,
        pathIdentity,
        relativePath,
        revisionId,
      );
    }
  });
  seed();

  const originalPathLookup =
    'SELECT asset_id, current_revision_id FROM assets WHERE path_identity = ?';
  const managedPathLookup =
    "SELECT asset_id, current_revision_id FROM assets WHERE path_identity = ? AND location_kind = 'managed'";
  const mapMaterialization = `
    SELECT a.path_identity AS path_identity,
           a.relative_file_path AS relative_file_path,
           r.byte_size AS byte_size
      FROM assets a
      LEFT JOIN revisions r ON r.revision_id = a.current_revision_id
     WHERE a.deleted_at IS NULL
  `;
  const explain = (sql) =>
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('missing-identity').map((row) => row.detail);

  const originalPlan = explain(originalPathLookup);
  const managedPlan = explain(managedPathLookup);
  const availableIndexes = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('assets', 'revisions') ORDER BY name")
    .all();

  const missingKeys = Array.from(
    { length: MISS_COUNT },
    (_, i) => `not-present/${String(i).padStart(4, '0')}.png`,
  );

  const timeMisses = (sql) => {
    const statement = db.prepare(sql);
    const start = performance.now();
    let hits = 0;
    for (const key of missingKeys) {
      if (statement.get(key)) hits += 1;
    }
    return { elapsedMs: roundMs(performance.now() - start), lookups: MISS_COUNT, hits };
  };

  const unfilteredPointLookup = timeMisses(originalPathLookup);
  const managedIndexedPointLookup = timeMisses(managedPathLookup);

  const mapStart = performance.now();
  const rows = db.prepare(mapMaterialization).all();
  const destinationMap = new Map(
    rows.map((row) => [row.path_identity, {
      actualRelativePath: row.relative_file_path,
      size: row.byte_size ?? -1,
    }]),
  );
  const mapBuildMs = roundMs(performance.now() - mapStart);
  const mapLookupStart = performance.now();
  let mapHits = 0;
  for (const key of missingKeys) {
    if (destinationMap.has(key)) mapHits += 1;
  }
  const mapLookupMs = roundMs(performance.now() - mapLookupStart);

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assets').get().count, ASSET_COUNT);
  assert.equal(rows.length, ASSET_COUNT);
  assert.equal(destinationMap.size, ASSET_COUNT);
  assert.equal(unfilteredPointLookup.hits, 0);
  assert.equal(managedIndexedPointLookup.hits, 0);
  assert.equal(mapHits, 0);
  assert(originalPlan.some((detail) => detail.includes('SCAN assets')));
  assert(managedPlan.some((detail) => detail.includes('assets_managed_path_identity_unique')));

  const result = {
    experiment: 'isolated SQLite path lookup/index construction microbenchmark',
    fixture: {
      database: ':memory:',
      assets: ASSET_COUNT,
      managedAssets: MANAGED_COUNT,
      linkedAssets: ASSET_COUNT - MANAGED_COUNT,
      revisions: ASSET_COUNT,
      missingLookups: MISS_COUNT,
      deletedRows: 0,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      modules: process.versions.modules,
      betterSqlite3Sqlite: db.prepare('SELECT sqlite_version() AS version').get().version,
      nodeBuiltinSqlite: process.versions.sqlite,
    },
    ddlIndexes: availableIndexes,
    queryPlans: {
      sourceResolveImportPathLookup: {
        sql: originalPathLookup,
        plan: originalPlan,
      },
      managedPredicateCandidate: {
        sql: managedPathLookup,
        plan: managedPlan,
      },
      destinationMapMaterialization: {
        sql: mapMaterialization.trim(),
        plan: db.prepare(`EXPLAIN QUERY PLAN ${mapMaterialization}`).all().map((row) => row.detail),
      },
    },
    oneRunTimingMs: {
      cachedPreparedUnfilteredPathLookup400Misses: unfilteredPointLookup.elapsedMs,
      cachedPreparedManagedIndexedLookup400Misses: managedIndexedPointLookup.elapsedMs,
      fullDestinationMapBuild20000Rows: mapBuildMs,
      fullDestinationMap400Misses: mapLookupMs,
      fullMapBuildPlusLookups: roundMs(mapBuildMs + mapLookupMs),
    },
    assertionsPassed: 8,
    limitations: [
      'Synthetic schema reproduces relevant columns and the current managed/linked partial path_identity indexes; it is not a complete library database.',
      'Measures SQLite lookup and full-map materialization only; excludes filesystem orphan fallback, payload copying, worker startup, and end-to-end import behavior.',
      'The content-fingerprint lookup has no content_fingerprint index in the inspected source DDL; no content-hash query timing was run.',
      'Single timing run per strategy; values are a local query-shape comparison, not a product performance guarantee.',
    ],
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  db.close();
}
