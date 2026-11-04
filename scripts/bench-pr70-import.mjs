import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);

if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
  const child = spawn(require('electron'), [scriptPath, ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    console.error('Could not start Electron Node for the benchmark.', error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
} else {
  await runBenchmark();
}

async function runBenchmark() {
  const fs = (await import('node:fs')).default;
  const path = await import('node:path');
  const os = await import('node:os');
  const crypto = await import('node:crypto');
  const zlib = await import('node:zlib');
  const { performance } = await import('node:perf_hooks');
  const { execFileSync } = await import('node:child_process');
  const { syncBuiltinESMExports } = await import('node:module');
  const { Module } = await import('node:module');
  const { build } = await import('vite');
  const repoRoot = process.cwd();
  const args = process.argv.slice(2);
  const smoke = args.includes('--smoke');
  const outputIndex = args.indexOf('--output');
  const optionValue = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const testResultsRoot = path.resolve(repoRoot, 'test-results');
  fs.mkdirSync(testResultsRoot, { recursive: true });
  const freeSpace = fs.statfsSync(testResultsRoot);
  const availableBytes = Number(freeSpace.bavail) * Number(freeSpace.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes < 512 * 1024 * 1024) {
    throw new Error('Benchmark stopped: the local test-results volume needs at least 512 MiB free for isolated fixtures and temporary bundles.');
  }
  const outputRoot = outputIndex >= 0
    ? path.resolve(repoRoot, args[outputIndex + 1])
    : fs.mkdtempSync(path.join(testResultsRoot, 'pr70-destination-index-bench-'));
  const managedOutputRoot = outputIndex < 0;
  if (outputIndex >= 0) fs.mkdirSync(outputRoot, { recursive: true });
  if (fs.readdirSync(outputRoot).length !== 0) throw new Error('Benchmark output directory must be empty.');

  const refs = {
    baseline: '589d41aaa334c9b04c4623741ea7cdf45c4dafb3',
    pr: '1fa2a49c79509aa95196b9fb78d6f0d105daae16',
  };
  const seed = 20261019;
  const scenarios = smoke
    ? [{ id: 'smoke-1k-1', existing: 1_000, incoming: 1, pairedRounds: 1 }]
    : [
        { id: 'flat-20k-400', existing: 20_000, incoming: 400, pairedRounds: 5 },
        { id: 'flat-20k-1', existing: 20_000, incoming: 1, pairedRounds: 3 },
        ...(args.includes('--include-1k')
          ? [{ id: 'flat-1k-400', existing: 1_000, incoming: 400, pairedRounds: 3 }]
          : []),
      ];
  const runDir = path.join(outputRoot, 'work');
  fs.mkdirSync(runDir);
  const sourceCopies = path.join(runDir, 'source-copies');
  fs.mkdirSync(sourceCopies);
  const now = '2026-10-19T00:00:00.000Z';
  let idSequence = 0;
  const deterministicId = () => {
    const chars = crypto.createHash('sha256').update(`${seed}:${idSequence++}`).digest('hex').slice(0, 32).split('');
    chars[12] = '4';
    chars[16] = ((Number.parseInt(chars[16], 16) & 3) | 8).toString(16);
    const hex = chars.join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const portableIdentity = (relativePath) => relativePath
    .normalize('NFC')
    .split('/')
    .map((part) => part.toUpperCase().toLowerCase().normalize('NFC'))
    .join('/');
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    return crc >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type, data) => {
    const kind = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, crc]);
  };
  const sourceBytes = (index) => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const pixel = Buffer.from([0, index & 0xff, (index >> 8) & 0xff, (index * 17) & 0xff, 0xff]);
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(pixel)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  };

  function sourceForRef(ref) {
    return execFileSync('git', ['show', `${refs[ref]}:src/worker/library-service.ts`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  const mutableProbe = { active: undefined, phase: 'prepare' };
  const originalReaddirSync = fs.readdirSync;
  const originalLstatSync = fs.lstatSync;
  fs.readdirSync = function instrumentedReaddirSync(target, ...options) {
    const entries = originalReaddirSync.call(this, target, ...options);
    if (mutableProbe.active && typeof target === 'string') {
      const resolved = path.resolve(target);
      const root = mutableProbe.active.assetsPath;
      if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
        const bucket = mutableProbe.active.counters[mutableProbe.phase];
        bucket.readdirCalls += 1;
        bucket.readdirEntries += entries.length;
      }
    }
    return entries;
  };
  syncBuiltinESMExports();

  async function loadService(ref) {
    const serviceSource = sourceForRef(ref);
    const copyRoot = path.join(sourceCopies, ref);
    const sourceRoot = path.join(copyRoot, 'src');
    const outputRoot = path.join(copyRoot, 'bundle');
    fs.mkdirSync(copyRoot, { recursive: true });
    fs.cpSync(path.join(repoRoot, 'src'), sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'worker', 'library-service.ts'), serviceSource);
    fs.mkdirSync(outputRoot, { recursive: true });
    const bundlePath = path.join(outputRoot, 'library-service.cjs');
    await build({
      configFile: false,
      logLevel: 'silent',
      root: copyRoot,
      build: {
        lib: {
          entry: path.join(sourceRoot, 'worker', 'library-service.ts'),
          formats: ['cjs'],
          fileName: () => path.basename(bundlePath),
        },
        outDir: outputRoot,
        emptyOutDir: false,
        rollupOptions: {
          external: (id) => id.startsWith('node:') || (!id.startsWith('.') && !path.isAbsolute(id)),
        },
      },
    });
    process.env.NODE_PATH = [process.env.NODE_PATH, path.join(repoRoot, 'node_modules')]
      .filter(Boolean)
      .join(path.delimiter);
    Module._initPaths();
    return { LibraryService: createRequire(import.meta.url)(bundlePath).LibraryService };
  }

  const workPath = path.join(runDir, 'libraries');
  const sourceRoot = path.join(runDir, 'sources');
  fs.mkdirSync(workPath);
  fs.mkdirSync(sourceRoot);
  const sourcePathsByScenario = new Map();
  for (const scenario of scenarios) {
    const sourceDir = path.join(sourceRoot, scenario.id);
    fs.mkdirSync(sourceDir);
    const sourcePaths = [];
    for (let index = 0; index < scenario.incoming; index += 1) {
      const file = path.join(sourceDir, `incoming-${scenario.id}-${String(index).padStart(4, '0')}.png`);
      fs.writeFileSync(file, sourceBytes(index));
      sourcePaths.push(file);
    }
    sourcePathsByScenario.set(scenario.id, sourcePaths);
  }

  const services = {};
  const fixtures = new Map();
  const results = [];
  const warmups = [];
  let activeService;
  try {
    services.baseline = await loadService('baseline');
    services.pr = await loadService('pr');
    const Database = require('better-sqlite3');
    for (const scenario of scenarios) {
      const creator = new services.baseline.LibraryService({ observerFactory: () => ({ close() {} }) });
      const parent = path.join(workPath, scenario.id);
      fs.mkdirSync(parent);
      const library = creator.createLibrary({
        displayName: `PR70 ${scenario.id}`,
        selectedParentPath: parent,
      });
      creator.closeAll();
      const databasePath = path.join(library.libraryPath, '.serpent', 'library.db');
      const database = new Database(databasePath);
      database.pragma('foreign_keys = ON');
      const insertAsset = database.prepare(
        `INSERT INTO assets (
          asset_id, location_kind, managed_folder_id, linked_folder_id,
          relative_file_path, current_revision_id, availability, path_identity,
          created_at, updated_at
        ) VALUES (?, 'managed', NULL, NULL, ?, NULL, 'available', ?, ?, ?)`,
      );
      const insertRevision = database.prepare(
        `INSERT INTO revisions (
          revision_id, asset_id, parent_revision_id, byte_size, modified_at,
          original_filename, origin, accepted_at
        ) VALUES (?, ?, NULL, 1, ?, ?, 'import', ?)`,
      );
      const updateRevision = database.prepare('UPDATE assets SET current_revision_id = ? WHERE asset_id = ?');
      const insertRows = database.transaction(() => {
        for (let index = 0; index < scenario.existing; index += 1) {
          const relativePath = `existing-${String(index).padStart(5, '0')}.png`;
          const assetId = deterministicId();
          const revisionId = deterministicId();
          insertAsset.run(assetId, relativePath, portableIdentity(relativePath), now, now);
          insertRevision.run(revisionId, assetId, now, relativePath, now);
          updateRevision.run(revisionId, assetId);
        }
      });
      insertRows();
      const seededCount = database.prepare('SELECT COUNT(*) AS count FROM assets').get().count;
      if (seededCount !== scenario.existing) throw new Error(`SQL seed count mismatch for ${scenario.id}.`);
      database.pragma('wal_checkpoint(TRUNCATE)');
      database.close();

      const assetsPath = path.join(library.libraryPath, 'Assets');
      for (let index = 0; index < scenario.existing; index += 1) {
        fs.writeFileSync(path.join(assetsPath, `existing-${String(index).padStart(5, '0')}.png`), Buffer.from([0x7f]));
      }
      const physicalCount = fs.readdirSync(assetsPath).length;
      if (physicalCount !== scenario.existing) throw new Error(`On-disk seed count mismatch for ${scenario.id}.`);
      const databaseSnapshot = path.join(runDir, `${scenario.id}.db`);
      fs.copyFileSync(databasePath, databaseSnapshot);
      fixtures.set(scenario.id, { ...scenario, library, databasePath, databaseSnapshot, assetsPath });
    }

    async function resetFixture(scenario) {
      if (activeService) {
        activeService.closeAll();
        activeService = undefined;
      }
      const fixture = fixtures.get(scenario.id);
      for (const suffix of ['', '-wal', '-shm']) {
        const file = `${fixture.databasePath}${suffix}`;
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      }
      fs.copyFileSync(fixture.databaseSnapshot, fixture.databasePath);
      const operationsPath = path.join(fixture.library.libraryPath, '.serpent', 'operations');
      if (fs.existsSync(operationsPath)) fs.rmSync(operationsPath, { recursive: true, force: true });
      fs.mkdirSync(operationsPath, { recursive: true });
      for (const sourcePath of sourcePathsByScenario.get(scenario.id)) {
        const destination = path.join(fixture.assetsPath, path.basename(sourcePath));
        if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
      }
    }

    async function runOne(scenario, variant, sequence, warmup) {
      const fixture = fixtures.get(scenario.id);
      const phaseCounters = {
        prepare: { readdirCalls: 0, readdirEntries: 0, lstatCalls: 0 },
        apply: { readdirCalls: 0, readdirEntries: 0, lstatCalls: 0 },
      };
      const isInsideAssets = (candidate) => {
        if (typeof candidate !== 'string') return false;
        const resolved = path.resolve(candidate);
        return resolved === fixture.assetsPath || resolved.startsWith(`${fixture.assetsPath}${path.sep}`);
      };
      const destinationLstat = (candidate) => {
        if (isInsideAssets(candidate) && mutableProbe.active) {
          mutableProbe.active.counters[mutableProbe.phase].lstatCalls += 1;
        }
        return originalLstatSync.call(fs, candidate);
      };
      activeService = new services[variant].LibraryService({
        observerFactory: () => ({ close() {} }),
        destinationLstat,
      });
      const opened = activeService.openLibrary(fixture.library.libraryPath);
      const incoming = sourcePathsByScenario.get(scenario.id);
      const prepareArgs = {
        libraryId: opened.libraryId,
        sourceKind: 'files',
        sourcePaths: incoming,
      };

      mutableProbe.active = { assetsPath: fixture.assetsPath, counters: phaseCounters };
      mutableProbe.phase = 'prepare';
      const rssBefore = process.memoryUsage().rss;
      const prepareStarted = performance.now();
      let plan;
      let completion;
      let prepareMs;
      let applyMs;
      try {
        plan = activeService.prepareImport(prepareArgs);
        prepareMs = performance.now() - prepareStarted;
        if (!plan || typeof plan !== 'object' || !('importId' in plan)) {
          throw new Error(`prepareImport did not produce a plan for ${scenario.id}.`);
        }
        const rssAfterPrepare = process.memoryUsage().rss;
        mutableProbe.phase = 'apply';
        const applyStarted = performance.now();
        completion = activeService.resolveImport({
          importId: plan.importId,
          suspectedDuplicate: 'skip',
          nameConflict: 'keep-both',
        });
        applyMs = performance.now() - applyStarted;
        const rssAfterApply = process.memoryUsage().rss;
        if (completion.importedCount !== incoming.length || completion.skippedCount !== 0) {
          throw new Error(`Import count mismatch for ${scenario.id}: ${completion.importedCount} imported, ${completion.skippedCount} skipped.`);
        }
        return {
          scenario: scenario.id,
          variant,
          sequence,
          warmup,
          existingCount: scenario.existing,
          incomingCount: incoming.length,
          prepareMs: round(prepareMs),
          applyMs: round(applyMs),
          totalMs: round(prepareMs + applyMs),
          ...Object.fromEntries(Object.entries(phaseCounters).flatMap(([name, values]) => Object.entries(values).map(([key, value]) => [`${name}${capitalize(key)}`, value]))),
          rssBeforeBytes: rssBefore,
          rssAfterPrepareBytes: rssAfterPrepare,
          rssAfterApplyBytes: rssAfterApply,
          rssPrepareDeltaBytes: rssAfterPrepare - rssBefore,
          rssApplyDeltaBytes: rssAfterApply - rssAfterPrepare,
          importedCount: completion.importedCount,
          skippedCount: completion.skippedCount,
        };
      } finally {
        mutableProbe.active = undefined;
        activeService.closeAll();
        activeService = undefined;
      }
    }

    for (const scenario of scenarios) {
      for (const variant of ['baseline', 'pr']) {
        await resetFixture(scenario);
        const warmup = await runOne(scenario, variant, 0, true);
        warmups.push(warmup);
        await resetFixture(scenario);
      }
      for (let pair = 0; pair < scenario.pairedRounds; pair += 1) {
        const pairOrder = pair % 2 === 0 ? ['baseline', 'pr'] : ['pr', 'baseline'];
        const pairResults = [];
        for (const variant of pairOrder) {
          const measurement = await runOne(scenario, variant, pair + 1, false);
          results.push(measurement);
          pairResults.push(measurement);
          await resetFixture(scenario);
        }
        const byVariant = Object.fromEntries(pairResults.map((item) => [item.variant, item]));
        const before = byVariant.baseline;
        const after = byVariant.pr;
        const improvement = (1 - after.totalMs / before.totalMs) * 100;
        console.log(
          `${scenario.id} pair ${pair + 1}/${scenario.pairedRounds}: `
          + `baseline ${before.prepareMs.toFixed(1)}+${before.applyMs.toFixed(1)}=${before.totalMs.toFixed(1)} ms, `
          + `PR ${after.prepareMs.toFixed(1)}+${after.applyMs.toFixed(1)}=${after.totalMs.toFixed(1)} ms, `
          + `paired total change ${improvement.toFixed(1)}%, `
          + `Assets readdir entries ${before.prepareReaddirEntries + before.applyReaddirEntries}→${after.prepareReaddirEntries + after.applyReaddirEntries}`,
        );
      }
      console.log(`Completed ${scenario.id} with ${scenario.pairedRounds} paired rounds.`);
    }

    const median = (values) => {
      const sorted = [...values].sort((left, right) => left - right);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const range = (values) => ({ min: Math.min(...values), median: median(values), max: Math.max(...values) });
    const pairedSummaries = scenarios.map((scenario) => {
      const pairs = Array.from({ length: scenario.pairedRounds }, (_, index) => {
        const sequence = index + 1;
        const baseline = results.find((item) => item.scenario === scenario.id && item.sequence === sequence && item.variant === 'baseline');
        const pr = results.find((item) => item.scenario === scenario.id && item.sequence === sequence && item.variant === 'pr');
        if (!baseline || !pr) throw new Error(`Missing paired measurement for ${scenario.id} round ${sequence}.`);
        return { baseline, pr };
      });
      const summaryFor = (field) => ({
        baselineMs: range(pairs.map(({ baseline }) => baseline[field])),
        prMs: range(pairs.map(({ pr }) => pr[field])),
        pairedDeltaMs: range(pairs.map(({ baseline, pr }) => baseline[field] - pr[field])),
        pairedImprovementPercent: range(pairs.map(({ baseline, pr }) => (1 - pr[field] / baseline[field]) * 100)),
      });
      return {
        scenario: scenario.id,
        rounds: scenario.pairedRounds,
        prepare: summaryFor('prepareMs'),
        apply: summaryFor('applyMs'),
        total: summaryFor('totalMs'),
      };
    });

    const raw = {
      benchmark: 'PR70 regular import destination index',
      generatedAt: new Date().toISOString(),
      seed,
      sourceRefs: refs,
      runtime: {
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        nativeModuleAbi: process.versions.modules,
        cpuCount: os.availableParallelism?.() ?? os.cpus().length,
        filesystem: optionValue('--filesystem', 'not detected'),
        storageClass: optionValue('--storage-class', 'not detected'),
      },
      method: {
        workload: 'isolated closed library with SQL-seeded assets and on-disk entries; open via LibraryService; measure actual prepareImport and resolveImport separately',
        executionBoundary: 'production LibraryService CJS bundles run under Electron RUN_AS_NODE in one process; UtilityProcess IPC, GUI, cold library-open, and thumbnail work are outside the measured phases',
        payload: 'existing assets are deterministic one-byte synthetic placeholders; incoming sources are deterministic valid 1x1 PNGs; no thumbnails or library-open time included',
        ordering: 'serial paired rounds alternating baseline→PR then PR→baseline; each version warmed once per scenario',
        scenarios: scenarios.map(({ id, existing, incoming, pairedRounds }) => ({ id, shape: 'flat', existing, incoming, pairedRounds })),
      },
      memoryNote: 'RSS is sampled at phase boundaries in one process with both source module graphs resident. Phase deltas are descriptive; this does not isolate per-version peak memory.',
      warmups,
      pairedSummaries,
      measurements: results,
    };
    const resultFile = path.join(outputRoot, 'raw-results.json');
    fs.writeFileSync(resultFile, `${JSON.stringify(raw, null, 2)}\n`);
    if (!smoke) {
      const persistentResult = path.join(repoRoot, 'docs', 'internal', 'reviews', '2026-10-19-pr70-import-performance-results.json');
      fs.copyFileSync(resultFile, persistentResult);
      console.log('Saved raw JSON to docs/internal/reviews/2026-10-19-pr70-import-performance-results.json.');
    } else {
      console.log(managedOutputRoot
        ? 'Smoke completed; temporary JSON will be removed after the verification run.'
        : `Saved smoke JSON to ${path.relative(repoRoot, resultFile).replaceAll('\\', '/')}.`);
    }
  } finally {
    if (activeService) activeService.closeAll();
    fs.readdirSync = originalReaddirSync;
    syncBuiltinESMExports();
    if (fs.existsSync(runDir)) fs.rmSync(runDir, { recursive: true, force: true });
    if (managedOutputRoot && fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true });
  }

  function round(value) {
    return Math.round(value * 1000) / 1000;
  }

  function capitalize(value) {
    return value[0].toUpperCase() + value.slice(1);
  }
}
