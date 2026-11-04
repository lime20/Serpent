import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire, Module } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineRef = process.argv[2] ?? '589d41aaa334c9b04c4623741ea7cdf45c4dafb3';
const prRef = process.argv[3] ?? '1fa2a49c79509aa95196b9fb78d6f0d105daae16';
const scratchRoot = mkdtempSync(path.join(tmpdir(), 'serpent-pr70-review-'));

process.env.NODE_PATH = [process.env.NODE_PATH, path.join(repoRoot, 'node_modules')]
  .filter(Boolean)
  .join(path.delimiter);
Module._initPaths();

function copySourceAtRevision(revision, label) {
  const copyRoot = path.join(scratchRoot, label);
  const sourceRoot = path.join(copyRoot, 'src');
  cpSync(path.join(repoRoot, 'src'), sourceRoot, { recursive: true });
  const workerSource = execFileSync(
    'git',
    ['show', `${revision}:src/worker/library-service.ts`],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(path.join(sourceRoot, 'worker', 'library-service.ts'), workerSource);
  return { copyRoot, entry: path.join(sourceRoot, 'worker', 'library-service.ts') };
}

async function loadLibraryService(revision, label) {
  const source = copySourceAtRevision(revision, label);
  const outputRoot = path.join(source.copyRoot, 'bundle');
  mkdirSync(outputRoot, { recursive: true });
  const bundlePath = path.join(outputRoot, 'library-service.cjs');
  await build({
    configFile: false,
    logLevel: 'silent',
    root: source.copyRoot,
    build: {
      lib: {
        entry: source.entry,
        formats: ['cjs'],
        fileName: () => path.basename(bundlePath),
      },
      outDir: outputRoot,
      emptyOutDir: false,
      rollupOptions: {
        external: (id) =>
          id.startsWith('node:') ||
          (!id.startsWith('.') && !path.isAbsolute(id)),
      },
    },
  });
  const loaded = createRequire(import.meta.url)(bundlePath);
  return loaded.LibraryService;
}

function runOrphanCase(LibraryService, storedName, incomingName) {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-pr70-orphan-'));
  const service = new LibraryService();
  try {
    const incomingRoot = path.join(root, 'incoming');
    mkdirSync(incomingRoot);
    const library = service.createLibrary({
      displayName: 'Import destination fixture',
      selectedParentPath: root,
    });
    const assetsPath = path.join(library.libraryPath, 'Assets');
    writeFileSync(path.join(assetsPath, storedName), 'existing orphan bytes');
    writeFileSync(path.join(incomingRoot, incomingName), 'incoming bytes');
    const plan = service.prepareImport({
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [path.join(incomingRoot, incomingName)],
    });
    return { nameConflictCount: plan.nameConflictCount, fileCount: plan.fileCount };
  } finally {
    try {
      service.closeAll();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
}

function runLinkedCollisionCase(LibraryService) {
  const root = mkdtempSync(path.join(tmpdir(), 'serpent-pr70-linked-'));
  const service = new LibraryService();
  try {
    const linkedRoot = path.join(root, 'linked-source');
    const incomingRoot = path.join(root, 'incoming');
    mkdirSync(linkedRoot);
    mkdirSync(incomingRoot);
    writeFileSync(path.join(linkedRoot, 'same-name.png'), 'linked asset bytes');
    writeFileSync(path.join(incomingRoot, 'same-name.png'), 'managed import bytes');
    const library = service.createLibrary({
      displayName: 'Linked destination fixture',
      selectedParentPath: root,
    });
    service.importFolderAsLinked({
      libraryId: library.libraryId,
      sourceRootPath: linkedRoot,
    });
    const plan = service.prepareImport({
      libraryId: library.libraryId,
      sourceKind: 'files',
      sourcePaths: [path.join(incomingRoot, 'same-name.png')],
    });
    return { nameConflictCount: plan.nameConflictCount, fileCount: plan.fileCount };
  } finally {
    try {
      service.closeAll();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
}

try {
  const baseline = await loadLibraryService(baselineRef, 'baseline');
  const pr = await loadLibraryService(prRef, 'pr');
  const cases = [
    {
      name: 'NFD orphan vs NFC incoming',
      stored: 'cafe\u0301.png',
      incoming: 'caf\u00e9.png',
    },
    {
      name: 'Unicode case-fold expansion orphan',
      stored: 'Straße.png',
      incoming: 'STRASSE.png',
    },
  ];
  const results = cases.map((item) => ({
    case: item.name,
    baseline: runOrphanCase(baseline, item.stored, item.incoming),
    pr: runOrphanCase(pr, item.stored, item.incoming),
  }));
  results.push({
    case: 'linked-only same relative path',
    baseline: runLinkedCollisionCase(baseline),
    pr: runLinkedCollisionCase(pr),
  });
  assert.deepEqual(
    results.map(({ baseline: before, pr: after }) => [before.nameConflictCount, after.nameConflictCount]),
    [[1, 0], [1, 0], [0, 1]],
    'Expected the baseline to preserve Unicode orphan conflicts and ignore linked-only paths, with PR #70 changing both outcomes.',
  );
  process.stdout.write(`${JSON.stringify({ baselineRef, prRef, results }, null, 2)}\n`);
} finally {
  rmSync(scratchRoot, { force: true, recursive: true });
}
