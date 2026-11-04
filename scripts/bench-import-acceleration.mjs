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
    : fs.mkdtempSync(path.join(testResultsRoot, 'import-acceleration-bench-'));
  const managedOutputRoot = outputIndex < 0;
  let runDir;
  let activeService;
  const services = {};
  const fixtures = new Map();
  const results = [];
  const warmups = [];
  const mutableProbe = { active: undefined, phase: 'prepare' };
  const originalReaddirSync = fs.readdirSync;
  const originalLstatSync = fs.lstatSync;

  function assertOwnedPathNoSymlink(candidate, ownedRoot) {
    const root = path.resolve(ownedRoot);
    const absolute = path.resolve(candidate);
    const relative = path.relative(root, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Refusing recursive cleanup outside the benchmark-owned directory.');
    }
    let cursor = root;
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink()) throw new Error('Refusing cleanup through a symbolic-link root.');
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      try {
        if (fs.lstatSync(cursor).isSymbolicLink()) {
          throw new Error('Refusing cleanup through a symbolic link or junction.');
        }
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
  }

  function assertNoSymlinkTree(candidate) {
    const status = fs.lstatSync(candidate);
    if (status.isSymbolicLink()) throw new Error('Refusing recursive cleanup of a tree containing a symbolic link.');
    if (!status.isDirectory()) return;
    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      const child = path.join(candidate, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Refusing recursive cleanup of a tree containing a symbolic link.');
      if (entry.isDirectory()) assertNoSymlinkTree(child);
    }
  }

  function removeOwnedTree(candidate, ownedRoot) {
    assertOwnedPathNoSymlink(candidate, ownedRoot);
    try {
      fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    assertNoSymlinkTree(candidate);
    fs.rmSync(candidate, { recursive: true, force: true });
  }

  function restoreOwnedDirectoryContents(snapshotPath, destinationPath, ownedRoot) {
    assertOwnedPathNoSymlink(destinationPath, ownedRoot);
    assertNoSymlinkTree(snapshotPath);
    fs.mkdirSync(destinationPath, { recursive: true });
    const destinationStatus = fs.lstatSync(destinationPath);
    if (destinationStatus.isSymbolicLink() || !destinationStatus.isDirectory()) {
      throw new Error('Refusing to restore benchmark state through a non-directory path.');
    }
    for (const entry of fs.readdirSync(destinationPath, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Refusing to clear benchmark state through a symbolic link.');
      removeOwnedTree(path.join(destinationPath, entry.name), ownedRoot);
    }
    copyDirectoryContents(snapshotPath, destinationPath);
    assertSameTreeContents(snapshotPath, destinationPath);
  }

  function copyDirectoryContents(sourcePath, destinationPath) {
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
      const source = path.join(sourcePath, entry.name);
      const destination = path.join(destinationPath, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Refusing to copy benchmark state containing a symbolic link.');
      if (entry.isDirectory()) {
        fs.mkdirSync(destination);
        copyDirectoryContents(source, destination);
      } else if (entry.isFile()) {
        fs.copyFileSync(source, destination);
      } else {
        throw new Error('Refusing to copy an unsupported filesystem entry in benchmark state.');
      }
    }
  }

  function assertSameTreeContents(expectedRoot, actualRoot) {
    const inventory = (root) => {
      const entries = [];
      const visit = (directory, relativeDirectory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
          const absolute = path.join(directory, entry.name);
          const relative = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
          if (entry.isSymbolicLink()) throw new Error('Refusing to validate benchmark state containing a symbolic link.');
          if (entry.isDirectory()) {
            entries.push({ path: relative.replaceAll('\\', '/'), type: 'directory' });
            visit(absolute, relative);
          } else if (entry.isFile()) {
            const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
            entries.push({ path: relative.replaceAll('\\', '/'), type: 'file', sha256: digest });
          } else {
            throw new Error('Refusing to validate an unsupported filesystem entry in benchmark state.');
          }
        }
      };
      visit(root, '');
      return entries;
    };
    const expected = inventory(expectedRoot);
    const actual = inventory(actualRoot);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('Benchmark fixture reset did not exactly restore the snapshot tree.');
    }
  }

  try {
  if (outputIndex >= 0) fs.mkdirSync(outputRoot, { recursive: true });
  if (fs.readdirSync(outputRoot).length !== 0) throw new Error('Benchmark output directory must be empty.');

  const refs = { baseline: '589d41aaa334c9b04c4623741ea7cdf45c4dafb3' };
  const seed = 20261019;
  const scenarios = smoke
    ? [{ id: 'smoke-1k-1', existing: 1_000, incoming: 1, pairedRounds: 1 }]
    : [
        { id: 'flat-20k-400', existing: 20_000, incoming: 400, pairedRounds: 5 },
        { id: 'flat-20k-1', existing: 20_000, incoming: 1, pairedRounds: 3 },
      ];
  runDir = path.join(outputRoot, 'work');
  fs.mkdirSync(runDir);
  const sourceSnapshots = path.join(runDir, 'source-snapshots');
  fs.mkdirSync(sourceSnapshots);
  const baselineSnapshot = path.join(sourceSnapshots, 'baseline');
  const workingSnapshot = path.join(sourceSnapshots, 'working');
  fs.mkdirSync(baselineSnapshot);
  fs.mkdirSync(workingSnapshot);
  const baselineSrc = path.join(baselineSnapshot, 'src');
  const workingSrc = path.join(workingSnapshot, 'src');
  fs.mkdirSync(baselineSrc, { recursive: true });
  fs.cpSync(path.join(repoRoot, 'src'), workingSrc, { recursive: true });
  extractGitSourceTree(refs.baseline, baselineSnapshot);
  const baselineDigest = digestSourceTree(baselineSrc);
  const workingDigest = digestSourceTree(workingSrc);
  const workingHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
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

  function extractGitSourceTree(ref, destinationRoot) {
    const archive = execFileSync('git', ['archive', '--format=tar', ref, 'src'], {
      cwd: repoRoot,
      maxBuffer: 128 * 1024 * 1024,
    });
    let offset = 0;
    let pendingArchivePath;
    while (offset + 512 <= archive.length) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const field = (start, length) => archive.toString('utf8', offset + start, offset + start + length)
        .replace(/\0.*$/s, '')
        .trim();
      const name = field(0, 100);
      const prefix = field(345, 155);
      const headerPath = `${prefix ? `${prefix}/` : ''}${name}`;
      const size = Number.parseInt(field(124, 12) || '0', 8);
      const type = String.fromCharCode(archive[offset + 156] || 0);
      const contentStart = offset + 512;
      const contentEnd = contentStart + size;
      if (!Number.isSafeInteger(size) || size < 0 || contentEnd > archive.length) {
        throw new Error('Malformed baseline source archive entry.');
      }
      if (type === 'x' || type === 'g') {
        let cursor = contentStart;
        while (cursor < contentEnd) {
          const space = archive.indexOf(0x20, cursor);
          if (space < 0 || space >= contentEnd) throw new Error('Malformed extended tar header.');
          const recordLength = Number.parseInt(archive.toString('ascii', cursor, space), 10);
          const recordEnd = cursor + recordLength;
          if (!Number.isSafeInteger(recordLength) || recordLength <= 0 || recordEnd > contentEnd) {
            throw new Error('Malformed extended tar record.');
          }
          const record = archive.toString('utf8', space + 1, recordEnd).replace(/\n$/, '');
          const separator = record.indexOf('=');
          if (separator >= 0 && record.slice(0, separator) === 'path') {
            pendingArchivePath = record.slice(separator + 1);
          }
          cursor = recordEnd;
        }
        offset = contentStart + Math.ceil(size / 512) * 512;
        continue;
      }
      const archivePath = pendingArchivePath ?? headerPath;
      pendingArchivePath = undefined;
      if (!archivePath.startsWith('src/') || !Number.isSafeInteger(size) || size < 0 || contentEnd > archive.length) {
        throw new Error('Unexpected or malformed baseline source archive entry.');
      }
      const absolutePath = path.resolve(destinationRoot, ...archivePath.split('/'));
      const relation = path.relative(destinationRoot, absolutePath);
      if (relation.startsWith('..') || path.isAbsolute(relation)) {
        throw new Error('Baseline source archive entry escaped its snapshot directory.');
      }
      if (type === '5') {
        fs.mkdirSync(absolutePath, { recursive: true });
      } else if (type === '\0' || type === '0') {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, archive.subarray(contentStart, contentEnd));
      } else {
        throw new Error(`Unsupported baseline source archive entry type: ${type}.`);
      }
      offset = contentStart + Math.ceil(size / 512) * 512;
    }
  }

  function digestSourceTree(sourceRoot) {
    const files = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(absolutePath);
        else if (entry.isFile()) files.push(absolutePath);
      }
    };
    visit(sourceRoot);
    files.sort((left, right) => left.localeCompare(right));
    const hash = crypto.createHash('sha256');
    for (const absolutePath of files) {
      const relativePath = path.relative(sourceRoot, absolutePath).replaceAll('\\', '/');
      hash.update(relativePath);
      hash.update('\0');
      hash.update(fs.readFileSync(absolutePath));
      hash.update('\0');
    }
    return { sha256: hash.digest('hex'), fileCount: files.length };
  }

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

  async function loadService(variant, sourceRoot) {
    const copyRoot = path.join(runDir, `build-${variant}`);
    const outputRoot = path.join(copyRoot, 'bundle');
    fs.mkdirSync(copyRoot, { recursive: true });
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
  const stateSnapshots = path.join(runDir, 'initial-serpent-state');
  fs.mkdirSync(stateSnapshots);
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

    services.baseline = await loadService('baseline', baselineSrc);
    services.working = await loadService('working', workingSrc);
    const Database = require('better-sqlite3');
    for (const scenario of scenarios) {
      const creator = new services.baseline.LibraryService({ observerFactory: () => ({ close() {} }) });
      const parent = path.join(workPath, scenario.id);
      fs.mkdirSync(parent);
      const library = creator.createLibrary({
        displayName: `Import profile ${scenario.id}`,
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
      const serpentPath = path.join(library.libraryPath, '.serpent');
      const serpentSnapshotPath = path.join(stateSnapshots, scenario.id);
      assertOwnedPathNoSymlink(serpentPath, runDir);
      assertNoSymlinkTree(serpentPath);
      fs.cpSync(serpentPath, serpentSnapshotPath, { recursive: true });
      fixtures.set(scenario.id, { ...scenario, library, serpentPath, serpentSnapshotPath, assetsPath });
    }

    async function resetFixture(scenario) {
      if (activeService) {
        activeService.closeAll();
        activeService = undefined;
      }
      const fixture = fixtures.get(scenario.id);
      restoreOwnedDirectoryContents(fixture.serpentSnapshotPath, fixture.serpentPath, runDir);
      for (const sourcePath of sourcePathsByScenario.get(scenario.id)) {
        const destination = path.join(fixture.assetsPath, path.basename(sourcePath));
        assertOwnedPathNoSymlink(destination, runDir);
        try {
          if (!fs.lstatSync(destination).isSymbolicLink()) fs.rmSync(destination, { force: true });
          else throw new Error('Refusing to remove a benchmark fixture file through a symbolic link.');
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
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
      for (const variant of ['baseline', 'working']) {
        let warmupElapsedMs = 0;
        let warmupSequence = 0;
        while (warmupElapsedMs < 5_000) {
          await resetFixture(scenario);
          const warmup = await runOne(scenario, variant, ++warmupSequence, true);
          warmups.push(warmup);
          warmupElapsedMs += warmup.totalMs;
        }
        await resetFixture(scenario);
      }
      for (let pair = 0; pair < scenario.pairedRounds; pair += 1) {
        const pairOrder = pair % 2 === 0 ? ['baseline', 'working'] : ['working', 'baseline'];
        const pairResults = [];
        for (const variant of pairOrder) {
          const measurement = await runOne(scenario, variant, pair + 1, false);
          results.push(measurement);
          pairResults.push(measurement);
          await resetFixture(scenario);
        }
        const byVariant = Object.fromEntries(pairResults.map((item) => [item.variant, item]));
        const before = byVariant.baseline;
        const after = byVariant.working;
        const improvement = (1 - after.totalMs / before.totalMs) * 100;
        console.log(
          `${scenario.id} pair ${pair + 1}/${scenario.pairedRounds}: `
          + `baseline ${before.prepareMs.toFixed(1)}+${before.applyMs.toFixed(1)}=${before.totalMs.toFixed(1)} ms, `
          + `working ${after.prepareMs.toFixed(1)}+${after.applyMs.toFixed(1)}=${after.totalMs.toFixed(1)} ms, `
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
        const working = results.find((item) => item.scenario === scenario.id && item.sequence === sequence && item.variant === 'working');
        if (!baseline || !working) throw new Error(`Missing paired measurement for ${scenario.id} round ${sequence}.`);
        return { baseline, working };
      });
      const summaryFor = (field) => ({
        baselineMs: range(pairs.map(({ baseline }) => baseline[field])),
        workingMs: range(pairs.map(({ working }) => working[field])),
        pairedDeltaMs: range(pairs.map(({ baseline, working }) => baseline[field] - working[field])),
        pairedImprovementPercent: range(pairs.map(({ baseline, working }) => (1 - working[field] / baseline[field]) * 100)),
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
      benchmark: 'Import acceleration source comparison',
      generatedAt: new Date().toISOString(),
      seed,
      sourceRefs: {
        baseline: refs.baseline,
        workingRepositoryHead: workingHead,
        baselineSrcTree: baselineDigest,
        workingSrcTree: workingDigest,
        workingIdentityNote: 'The src tree digest identifies the measured working snapshot; repository HEAD alone does not include uncommitted source changes.',
      },
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
        executionBoundary: 'baseline bundles the complete src tree from the fixed baseline commit; working bundles a full snapshot of current src. Both production LibraryService CJS bundles run under Electron RUN_AS_NODE in one process; UtilityProcess IPC, GUI, cold library-open, and thumbnail jobs are outside the measured phases',
        payload: 'synthetic closed-library workload, not the official large-library performance fixture: existing assets are deterministic one-byte placeholders; incoming sources are deterministic valid 1x1 PNGs; no thumbnails or library-open time included',
        fixtureReset: 'each scenario clears the fixture-owned .serpent directory contents, restores the complete closed tree captured after seeding, and verifies exact path/type/file-content equality; this removes any post-snapshot operation manifests, artifacts, migration backups, or library metadata. Only known imported files are removed from the fixture-owned Assets directory. Recursive removals are constrained to the generated run directory and rejected if any path segment or descendant is a symlink/junction',
        ordering: 'serial paired rounds alternating baseline→working then working→baseline; each version receives at least 5 seconds of unmeasured complete-import warmup per scenario, excluded from summaries',
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
      const persistentResult = path.join(repoRoot, 'docs', 'internal', 'qa', '2026-10-19-import-acceleration-performance.json');
      fs.copyFileSync(resultFile, persistentResult);
      console.log('Saved raw JSON to docs/internal/qa/2026-10-19-import-acceleration-performance.json.');
    } else {
      console.log(managedOutputRoot
        ? 'Smoke completed; temporary JSON will be removed after the verification run.'
        : `Saved smoke JSON to ${path.relative(repoRoot, resultFile).replaceAll('\\', '/')}.`);
    }
  } finally {
    try {
      if (activeService) activeService.closeAll();
    } finally {
      fs.readdirSync = originalReaddirSync;
      syncBuiltinESMExports();
      try {
        if (runDir) removeOwnedTree(runDir, outputRoot);
      } finally {
        if (managedOutputRoot) removeOwnedTree(outputRoot, testResultsRoot);
      }
    }
  }

  function round(value) {
    return Math.round(value * 1000) / 1000;
  }

  function capitalize(value) {
    return value[0].toUpperCase() + value.slice(1);
  }
}
