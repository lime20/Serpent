#!/usr/bin/env node

/**
 * Pure algorithm benchmark for image-sequence discovery.
 *
 * Loads the production TypeScript implementation and creates an in-memory
 * variant that changes only `run = [...run, frame]` to `run.push(frame)`.
 * The second comparison models repeated same-directory lookups in
 * LibraryService by comparing N calls to findImageSequenceContaining with one
 * detectImageSequences pass plus a value-to-run index. No filesystem, Worker,
 * SQLite, decoder, Electron window, or product source mutation is involved.
 *
 * Safe default: one 1k run and 1k siblings with 1 / 10 selected frames.
 * Use --full only after reviewing its estimated spread-copy work. In
 * particular, do not combine very large sibling and selected counts.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceRef = "589d41aaa334c9b04c4623741ea7cdf45c4dafb3";
const defaultSizes = [1_000];
const defaultFindCases = [{ siblingCount: 1_000, selectedCount: 1 }, { siblingCount: 1_000, selectedCount: 10 }];

function parseArgs(argv) {
  const options = {
    sizes: defaultSizes,
    findCases: defaultFindCases,
    repeats: 3,
    sourceRef: defaultSourceRef,
    outputPath: undefined,
  };
  for (const arg of argv) {
    if (arg === "--full") {
      options.sizes = [1_000, 5_000, 20_000];
      options.findCases = [
        ...[1_000, 5_000].flatMap((siblingCount) =>
          [1, 10, 50].map((selectedCount) => ({ siblingCount, selectedCount })),
        ),
      ];
    } else if (arg.startsWith("--sizes=")) {
      options.sizes = parsePositiveIntegers(arg.slice("--sizes=".length));
    } else if (arg.startsWith("--find-cases=")) {
      options.findCases = arg
        .slice("--find-cases=".length)
        .split(",")
        .map((item) => {
          const [siblings, selected, extra] = item.split(":");
          if (extra !== undefined) throw new Error(`Invalid find case: ${item}`);
          return {
            siblingCount: parsePositiveInteger(siblings, item),
            selectedCount: parsePositiveInteger(selected, item),
          };
        });
    } else if (arg.startsWith("--repeats=")) {
      options.repeats = parsePositiveInteger(arg.slice("--repeats=".length), arg);
    } else if (arg.startsWith("--source-ref=")) {
      options.sourceRef = arg.slice("--source-ref=".length);
      if (!options.sourceRef) throw new Error("--source-ref must not be empty.");
    } else if (arg.startsWith("--out=")) {
      options.outputPath = path.resolve(repoRoot, arg.slice("--out=".length));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  for (const testCase of options.findCases) {
    if (testCase.selectedCount > testCase.siblingCount) {
      throw new Error("selectedCount must not exceed siblingCount.");
    }
    const spreadCopies = testCase.selectedCount *
      (testCase.siblingCount * (testCase.siblingCount - 1)) / 2;
    if (spreadCopies > 1_000_000_000) {
      throw new Error(
        `Refusing ${spreadCopies.toLocaleString()} estimated array-element copies in one repeated-find case. Reduce the case size.`,
      );
    }
  }
  return options;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer for ${label}.`);
  }
  return parsed;
}

function parsePositiveIntegers(value) {
  return value.split(",").map((item) => parsePositiveInteger(item, "--sizes"));
}

function readTextAtRef(sourceRef, repositoryPath) {
  return execFileSync("git", ["show", `${sourceRef}:${repositoryPath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function loadSequenceModules(sourceRef) {
  const mediaSource = readTextAtRef(sourceRef, "src/shared/media-formats.ts");
  const sequenceSource = readTextAtRef(sourceRef, "src/shared/image-sequence.ts");
  const replacement = "run.push(frame);";
  const target = "run = [...run, frame];";
  assert.equal(sequenceSource.split(target).length - 1, 1, "production append expression changed; update this benchmark before using it");

  const transpile = (source) => ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  const mediaModuleUrl = `data:text/javascript;base64,${Buffer.from(transpile(mediaSource)).toString("base64")}`;
  const productionModuleText = transpile(
    sequenceSource.replace('from "./media-formats"', `from ${JSON.stringify(mediaModuleUrl)}`),
  );
  const optimizedModuleText = transpile(
    sequenceSource
      .replace('from "./media-formats"', `from ${JSON.stringify(mediaModuleUrl)}`)
      .replace(target, replacement),
  );
  const productionUrl = `data:text/javascript;base64,${Buffer.from(productionModuleText).toString("base64")}`;
  const optimizedUrl = `data:text/javascript;base64,${Buffer.from(optimizedModuleText).toString("base64")}`;
  return Promise.all([import(productionUrl), import(optimizedUrl)]);
}

function normalizeSequences(sequences) {
  return sequences.map((sequence) => ({
    extension: sequence.extension,
    frames: sequence.frames.map((frame) => ({
      frameNumber: frame.frameNumber,
      name: frame.name,
      numberStyle: frame.numberStyle,
      numericWidth: frame.numericWidth,
      value: frame.value,
    })),
    numberStyle: sequence.numberStyle,
    numericWidth: sequence.numericWidth,
    prefix: sequence.prefix,
  }));
}

function normalizeFoundSequence(sequence) {
  return sequence === null ? null : normalizeSequences([sequence])[0];
}

function syntheticFixtures() {
  return [
    "shot_1.webp", "shot_2.webp", "shot_3.webp",
    "shot_001.webp", "shot_002.webp", "shot_003.webp",
    "clip_01.png", "clip_02.png", "clip_03.png",
    "clip_15.png", "clip_16.png", "clip_17.png",
    "photo (01).jpg", "photo (02).jpg", "photo (03).jpg",
    "photo(1).jpg", "photo(2).jpg", "photo(3).jpg",
    "scene/frm1.tif", "scene/frm2.tif", "scene/frm3.tif",
    "elsewhere/frm1.tif", "elsewhere/frm2.tif", "elsewhere/frm3.tif",
    "duplicate_1.png", "duplicate_1.png", "duplicate_2.png", "duplicate_3.png",
    "video_1.mp4", "video_2.mp4", "video_3.mp4",
    "not_a_frame_final.png", "still.png",
  ];
}

function assertEquivalentBehavior(production, optimized) {
  const fixtures = syntheticFixtures();
  const expected = normalizeSequences(production.detectImageSequences(fixtures));
  assert.deepEqual(normalizeSequences(optimized.detectImageSequences(fixtures)), expected);

  const selected = [
    "shot_2.webp", "shot_002.webp", "clip_02.png", "clip_16.png",
    "photo (02).jpg", "photo(2).jpg", "scene/frm2.tif", "elsewhere/frm2.tif",
    "duplicate_1.png", "duplicate_2.png", "missing_99.png",
  ];
  const indexed = indexSequencesContaining(selected, optimized.detectImageSequences(fixtures));
  for (const value of selected) {
    assert.deepEqual(
      normalizeFoundSequence(indexed.get(value) ?? null),
      normalizeFoundSequence(production.findImageSequenceContaining(value, fixtures)),
      `indexed lookup differs for ${value}`,
    );
  }
  return { filenameCount: fixtures.length, selectedLookupCount: selected.length };
}

function indexSequencesContaining(selectedValues, sequences) {
  const byValue = new Map();
  for (const sequence of sequences) {
    for (const frame of sequence.frames) {
      if (!byValue.has(frame.value)) byValue.set(frame.value, sequence);
    }
  }
  return new Map(selectedValues.map((value) => [value, byValue.get(value) ?? null]));
}

function makeRun(size) {
  return Array.from({ length: size }, (_, index) => `run_${String(index + 1).padStart(5, "0")}.png`);
}

function makeSelected(values, selectedCount) {
  if (selectedCount === 1) return [values[Math.floor(values.length / 2)]];
  return Array.from({ length: selectedCount }, (_, index) =>
    values[Math.floor((index * (values.length - 1)) / (selectedCount - 1))],
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timeSamples(operation, repeats) {
  operation();
  const samples = [];
  for (let index = 0; index < repeats; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return { medianMs: Number(median(samples).toFixed(3)), samplesMs: samples.map((value) => Number(value.toFixed(3))) };
}

function benchmarkDetect(production, optimized, sizes, repeats) {
  return sizes.map((size) => {
    const values = makeRun(size);
    const expected = normalizeSequences(production.detectImageSequences(values));
    assert.deepEqual(normalizeSequences(optimized.detectImageSequences(values)), expected);
    const spreadElementCopiesPerCall = size * (size - 1) / 2;
    return {
      siblingCount: size,
      sequenceCount: expected.length,
      frameCount: expected.reduce((total, sequence) => total + sequence.frames.length, 0),
      estimatedArrayElementCopiesPerProductionCall: spreadElementCopiesPerCall,
      productionSpreadAppend: timeSamples(() => production.detectImageSequences(values), repeats),
      pushAppendPrototype: timeSamples(() => optimized.detectImageSequences(values), repeats),
    };
  });
}

function benchmarkRepeatedFind(production, optimized, testCases, repeats) {
  return testCases.map(({ siblingCount, selectedCount }) => {
    const values = makeRun(siblingCount);
    const selected = makeSelected(values, selectedCount);
    const expected = selected.map((value) =>
      normalizeFoundSequence(production.findImageSequenceContaining(value, values)),
    );
    const singleDetection = optimized.detectImageSequences(values);
    const indexed = indexSequencesContaining(selected, singleDetection);
    assert.deepEqual(
      selected.map((value) => normalizeFoundSequence(indexed.get(value) ?? null)),
      expected,
    );
    const spreadElementCopiesPerRepeatedSet = selectedCount * siblingCount * (siblingCount - 1) / 2;
    const repeatedTiming = timeSamples(() => {
      for (const value of selected) production.findImageSequenceContaining(value, values);
    }, repeats);
    const indexedTiming = timeSamples(() => {
      const sequences = optimized.detectImageSequences(values);
      const index = indexSequencesContaining(selected, sequences);
      for (const value of selected) index.get(value);
    }, repeats);
    return {
      siblingCount,
      selectedCount,
      outputsEquivalent: true,
      modeledParentDirectoryEnumerationsFromSourceCalls: { repeatedFind: selectedCount, oneDetectionIndex: 1 },
      detectorInputFramesPerSet: { repeatedFind: siblingCount * selectedCount, oneDetectionIndex: siblingCount },
      estimatedArrayElementCopiesPerRepeatedSet: spreadElementCopiesPerRepeatedSet,
      repeatedProductionFind: repeatedTiming,
      oneDetectionPlusIndex: indexedTiming,
    };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [production, optimized] = await loadSequenceModules(options.sourceRef);
  const fixtureSummary = assertEquivalentBehavior(production, optimized);
  const report = {
    schemaVersion: 1,
    benchmark: "import-sequence-discovery-pure-algorithm",
    source: "src/shared/image-sequence.ts (loaded from the selected git ref; only in-memory prototype substitution)",
    sourceRef: options.sourceRef,
    nodeVersion: process.version,
    repetitions: options.repeats,
    scope: "synthetic in-memory filenames only; excludes readdir, metadata decoding, Worker/IPC, SQLite, and UI",
    equivalenceFixtures: {
      passed: true,
      ...fixtureSummary,
      cover: ["multiple independent runs", "numbering gaps", "zero padding", "parentheses", "duplicate frame values", "directory isolation", "unsupported extension"],
    },
    detectBenchmarks: benchmarkDetect(production, optimized, options.sizes, options.repeats),
    repeatedFindBenchmarks: benchmarkRepeatedFind(production, optimized, options.findCases, options.repeats),
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.outputPath) {
    mkdirSync(path.dirname(options.outputPath), { recursive: true });
    writeFileSync(options.outputPath, serialized, "utf8");
    process.stdout.write(`Wrote benchmark JSON.\n`);
  } else {
    process.stdout.write(serialized);
  }
}

await main();
