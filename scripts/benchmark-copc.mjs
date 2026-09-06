#!/usr/bin/env node
import { statSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";

import { Bounds, Copc, Key, Las } from "copc";
import { PointCloudParquet } from "../packages/browser/dist/index.js";

const usage = `usage: node scripts/benchmark-copc.mjs PARQUET COPC [options]

Options:
  --level N         Parquet maximum additive LOD level
  --copc-depth N    COPC maximum octree depth
  --repeats N       Measured cold-cache runs per query (default: 3)
  --warmup N        Unmeasured runs per query (default: 1)
  --concurrency N   Independent laz-perf decoders (default: 4)
  --range-gap N     Parquet coalescing gap in bytes (default: reader default)
  --range-size N    Parquet combined request cap in bytes (default: reader default)
  --output FILE     Also write the JSON result to FILE`;

function fail(message) {
  console.error(message);
  console.error(usage);
  process.exit(2);
}

function parseArguments(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  if (argv.length < 2) fail("PARQUET and COPC are required");
  const options = {
    parquet: resolve(argv[0]),
    copc: resolve(argv[1]),
    level: undefined,
    copcDepth: undefined,
    repeats: 3,
    warmup: 1,
    concurrency: 4,
    rangeGap: undefined,
    rangeSize: undefined,
    output: undefined,
  };
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) fail(`missing value for ${flag}`);
    if (flag === "--output") {
      options.output = resolve(value);
      continue;
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number)) fail(`${flag} must be an integer`);
    if (flag === "--level") options.level = number;
    else if (flag === "--copc-depth") options.copcDepth = number;
    else if (flag === "--repeats") options.repeats = number;
    else if (flag === "--warmup") options.warmup = number;
    else if (flag === "--concurrency") options.concurrency = number;
    else if (flag === "--range-gap") options.rangeGap = number;
    else if (flag === "--range-size") options.rangeSize = number;
    else fail(`unknown option: ${flag}`);
  }
  if (options.repeats < 1) fail("--repeats must be at least 1");
  if (options.warmup < 0) fail("--warmup must be non-negative");
  if (options.concurrency < 1) fail("--concurrency must be at least 1");
  if (options.rangeGap !== undefined && options.rangeGap < 0) fail("--range-gap must be non-negative");
  if (options.rangeSize !== undefined && options.rangeSize < 1) fail("--range-size must be at least 1");
  return options;
}

async function readRange(path, begin, end) {
  if (begin < 0 || end < begin) throw new RangeError("invalid byte range");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.allocUnsafe(end - begin);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, begin);
    if (bytesRead !== bytes.length) throw new Error(`short read from ${path}`);
    return bytes;
  } finally {
    await file.close();
  }
}

function createLocalFetch(path, size) {
  return async (_url, init = {}) => {
    if (init.method === "HEAD") {
      return new Response(null, { headers: { "Content-Length": String(size) } });
    }
    const range = new Headers(init.headers).get("Range")?.match(/^bytes=(\d+)-(\d*)$/);
    if (range === undefined) throw new Error("benchmark fetch requires a byte range");
    const begin = Number(range[1]);
    const end = range[2] === "" ? size : Math.min(Number(range[2]) + 1, size);
    const bytes = await readRange(path, begin, end);
    return new Response(bytes, {
      status: 206,
      headers: { "Content-Range": `bytes ${begin}-${end - 1}/${size}` },
    });
  };
}

function createMeteredGetter(path) {
  const metrics = { bytesFetched: 0, rangeRequests: 0 };
  const getter = async (begin, end) => {
    const bytes = await readRange(path, begin, end);
    metrics.bytesFetched += bytes.byteLength;
    metrics.rangeRequests += 1;
    return bytes;
  };
  return { getter, metrics };
}

async function loadHierarchy(getter, rootPage) {
  const nodes = {};
  const pending = [rootPage];
  const seen = new Set();
  let hierarchyPages = 0;
  while (pending.length > 0) {
    const page = pending.pop();
    const id = `${page.pageOffset}:${page.pageLength}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hierarchyPages += 1;
    const subtree = await Copc.loadHierarchyPage(getter, page);
    Object.assign(nodes, subtree.nodes);
    for (const child of Object.values(subtree.pages)) {
      if (child !== undefined) pending.push(child);
    }
  }
  return { nodes, hierarchyPages };
}

function cumulativeCopcPoints(nodes) {
  const byDepth = [];
  for (const [key, node] of Object.entries(nodes)) {
    if (node === undefined) continue;
    const depth = Key.parse(key)[0];
    byDepth[depth] = (byDepth[depth] ?? 0) + node.pointCount;
  }
  let cumulative = 0;
  return byDepth.map((points, depth) => {
    cumulative += points ?? 0;
    return { depth, points: points ?? 0, cumulativePoints: cumulative };
  });
}

function nearestIndex(items, target, value) {
  return items.reduce((best, item, index) =>
    Math.abs(value(item) - target) < Math.abs(value(items[best]) - target) ? index : best, 0);
}

function chooseLods(options, parquet, copcDepths, totalPoints) {
  const parquetBudgets = parquet.resolutions.map((resolution) => resolution.rowEnd);
  const copcBudgets = copcDepths.map((depth) => depth.cumulativePoints);
  let level = options.level;
  let copcDepth = options.copcDepth;
  if (level !== undefined && (level < 0 || level >= parquetBudgets.length)) {
    fail(`--level must be between 0 and ${parquetBudgets.length - 1}`);
  }
  if (copcDepth !== undefined && (copcDepth < 0 || copcDepth >= copcBudgets.length)) {
    fail(`--copc-depth must be between 0 and ${copcBudgets.length - 1}`);
  }
  if (level === undefined && copcDepth === undefined) {
    const target = totalPoints / 4;
    level = nearestIndex(parquet.resolutions, target, (item) => item.rowEnd);
    copcDepth = nearestIndex(copcDepths, target, (item) => item.cumulativePoints);
  } else if (level === undefined) {
    level = nearestIndex(parquet.resolutions, copcBudgets[copcDepth], (item) => item.rowEnd);
  } else if (copcDepth === undefined) {
    copcDepth = nearestIndex(copcDepths, parquetBudgets[level], (item) => item.cumulativePoints);
  }
  return { level, copcDepth };
}

function centeredBounds(bounds, center, fractions) {
  const min = bounds.slice(0, 3);
  const max = bounds.slice(3, 6);
  const width = min.map((value, axis) => (max[axis] - value) * fractions[axis]);
  const queryMin = min.map((value, axis) =>
    Math.max(value, Math.min(center[axis] - width[axis] / 2, max[axis] - width[axis])));
  return {
    min: queryMin,
    max: queryMin.map((value, axis) => value + width[axis]),
  };
}

function buildQueries(bounds, center) {
  return [
    ["cube", [0.25, 0.25, 0.25]],
    ["thin-x", [0.04, 0.60, 0.60]],
    ["thin-y", [0.60, 0.04, 0.60]],
    ["thin-z", [0.60, 0.60, 0.04]],
    ["large", [0.70, 0.70, 1.00]],
  ].map(([name, fractions]) => ({ name, bounds: centeredBounds(bounds, center, fractions) }));
}

function overlaps(a, b) {
  return a[3] >= b.min[0] && a[0] <= b.max[0]
    && a[4] >= b.min[1] && a[1] <= b.max[1]
    && a[5] >= b.min[2] && a[2] <= b.max[2];
}

function selectCopcNodes(copc, nodes, bounds, maxDepth) {
  return Object.entries(nodes).flatMap(([key, node]) => {
    if (node === undefined || Key.parse(key)[0] > maxDepth) return [];
    return overlaps(Bounds.stepTo([...copc.info.cube], Key.parse(key)), bounds) ? [[key, node]] : [];
  });
}

async function mapPool(items, workers, callback) {
  let cursor = 0;
  await Promise.all(workers.map(async (worker, workerIndex) => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await callback(items[index], worker, workerIndex);
    }
  }));
}

async function openParquet(path, byteLength, rangeCoalescing) {
  const started = performance.now();
  const cloud = await PointCloudParquet.open("local://cloud.parquet", {
    byteLength,
    fetch: createLocalFetch(path, byteLength),
    rangeCoalescing,
  });
  return { cloud, elapsedMs: performance.now() - started };
}

async function openCopc(path) {
  const source = createMeteredGetter(path);
  const started = performance.now();
  const copc = await Copc.create(source.getter);
  const hierarchy = await loadHierarchy(source.getter, copc.info.rootHierarchyPage);
  return {
    source,
    copc,
    ...hierarchy,
    elapsedMs: performance.now() - started,
  };
}

async function queryCopc(context, bounds, maxDepth, decoders) {
  const candidates = selectCopcNodes(context.copc, context.nodes, bounds, maxDepth);
  const before = { ...context.source.metrics };
  const started = performance.now();
  let matchedPoints = 0;
  let rgbChecksum = 0;
  await mapPool(candidates, decoders, async ([, node], lazPerf) => {
    const view = await Copc.loadPointDataView(context.source.getter, context.copc, node, {
      lazPerf,
      include: ["X", "Y", "Z", "Red", "Green", "Blue"],
    });
    const getX = view.getter("X");
    const getY = view.getter("Y");
    const getZ = view.getter("Z");
    const getRed = view.dimensions.Red === undefined ? undefined : view.getter("Red");
    const getGreen = view.dimensions.Green === undefined ? undefined : view.getter("Green");
    const getBlue = view.dimensions.Blue === undefined ? undefined : view.getter("Blue");
    let localMatched = 0;
    let localChecksum = 0;
    for (let index = 0; index < view.pointCount; index += 1) {
      const x = getX(index);
      const y = getY(index);
      const z = getZ(index);
      if (x < bounds.min[0] || x > bounds.max[0]
        || y < bounds.min[1] || y > bounds.max[1]
        || z < bounds.min[2] || z > bounds.max[2]) continue;
      localMatched += 1;
      localChecksum = (localChecksum + (getRed?.(index) ?? 0)
        + (getGreen?.(index) ?? 0) + (getBlue?.(index) ?? 0)) % 4_294_967_291;
    }
    matchedPoints += localMatched;
    rgbChecksum = (rgbChecksum + localChecksum) % 4_294_967_291;
  });
  const elapsedMs = performance.now() - started;
  const pointsInCandidateNodes = candidates.reduce((sum, [, node]) => sum + node.pointCount, 0);
  const nodesAtLod = Object.entries(context.nodes)
    .filter(([key, node]) => node !== undefined && Key.parse(key)[0] <= maxDepth).length;
  return {
    openElapsedMs: context.elapsedMs,
    metadataBytesFetched: before.bytesFetched,
    metadataRangeRequests: before.rangeRequests,
    bytesFetched: context.source.metrics.bytesFetched - before.bytesFetched,
    rangeRequests: context.source.metrics.rangeRequests - before.rangeRequests,
    nodesTotal: nodesAtLod,
    nodesRead: candidates.length,
    nodesPruned: nodesAtLod - candidates.length,
    pointsInCandidateNodes,
    pointsMatched: matchedPoints,
    elapsedMs,
  };
}

async function representativeCenter(path, copc, nodes, lazPerf) {
  const root = nodes["0-0-0-0"]
    ?? Object.entries(nodes).sort(([left], [right]) => Key.parse(left)[0] - Key.parse(right)[0])[0]?.[1];
  if (root === undefined) throw new Error("COPC hierarchy contains no point nodes");
  const view = await Copc.loadPointDataView(path, copc, root, {
    lazPerf,
    include: ["X", "Y", "Z"],
  });
  return ["X", "Y", "Z"].map((name) => {
    const get = view.getter(name);
    const values = Array.from({ length: view.pointCount }, (_, index) => get(index));
    values.sort((left, right) => left - right);
    return values[Math.floor(values.length / 2)];
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function aggregate(samples) {
  const numeric = Object.keys(samples[0]).filter((key) =>
    samples.every((sample) => typeof sample[key] === "number"));
  return Object.fromEntries(numeric.map((key) => [key, median(samples.map((sample) => sample[key]))]));
}

function closeEnough(left, right, tolerance) {
  return Math.abs(left - right) <= tolerance;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const parquetBytes = statSync(options.parquet).size;
  const copcBytes = statSync(options.copc).size;
  const rangeCoalescing = {
    ...(options.rangeGap === undefined ? {} : { maxGapBytes: options.rangeGap }),
    ...(options.rangeSize === undefined ? {} : { maxRequestBytes: options.rangeSize }),
  };
  const discoveredParquet = await openParquet(options.parquet, parquetBytes, rangeCoalescing);
  const discoveredCopc = await openCopc(options.copc);
  const copcDepths = cumulativeCopcPoints(discoveredCopc.nodes);
  const totalPoints = discoveredCopc.copc.header.pointCount;
  const lods = chooseLods(options, discoveredParquet.cloud, copcDepths, totalPoints);

  const scaleTolerance = Math.max(...discoveredParquet.cloud.metadata.scale,
    ...discoveredCopc.copc.header.scale);
  const parquetBounds = discoveredParquet.cloud.metadata.bounds;
  const copcBounds = [...discoveredCopc.copc.header.min, ...discoveredCopc.copc.header.max];
  if (discoveredParquet.cloud.resolutions.at(-1).rowEnd !== totalPoints
    || !parquetBounds.every((value, index) => closeEnough(value, copcBounds[index], scaleTolerance))) {
    throw new Error("Parquet and COPC do not describe the same source point cloud");
  }

  const decoders = await Promise.all(Array.from(
    { length: options.concurrency }, () => Las.PointData.createLazPerf(),
  ));
  const queryCenter = await representativeCenter(
    options.copc, discoveredCopc.copc, discoveredCopc.nodes, decoders[0],
  );
  const queryResults = [];
  for (const query of buildQueries(parquetBounds, queryCenter)) {
    const parquetSamples = [];
    const copcSamples = [];
    const runCount = options.warmup + options.repeats;
    for (let run = 0; run < runCount; run += 1) {
      // Alternate order to avoid giving either format a systematic cache/thermal advantage.
      const formats = run % 2 === 0 ? ["parquet", "copc"] : ["copc", "parquet"];
      for (const format of formats) {
        if (format === "parquet") {
          const opened = await openParquet(options.parquet, parquetBytes, rangeCoalescing);
          const result = await opened.cloud.queryWorld(query.bounds, lods.level);
          if (run >= options.warmup) {
            parquetSamples.push({
              openElapsedMs: opened.elapsedMs,
              metadataBytesFetched: opened.cloud.metadataBytesFetched,
              ...result.metrics,
            });
          }
        } else {
          const opened = await openCopc(options.copc);
          const result = await queryCopc(opened, query.bounds, lods.copcDepth, decoders);
          if (run >= options.warmup) copcSamples.push(result);
        }
      }
    }
    const parquet = aggregate(parquetSamples);
    const copc = aggregate(copcSamples);
    queryResults.push({
      name: query.name,
      bounds: [...query.bounds.min, ...query.bounds.max],
      parquet,
      copc,
      comparison: {
        parquetToCopcBytes: parquet.bytesFetched / copc.bytesFetched,
        parquetToCopcElapsed: parquet.elapsedMs / copc.elapsedMs,
        parquetBytesPerMatchedPoint: parquet.bytesFetched / Math.max(1, parquet.pointsMatched),
        copcBytesPerMatchedPoint: copc.bytesFetched / Math.max(1, copc.pointsMatched),
      },
    });
  }

  const parquetResolution = discoveredParquet.cloud.resolutions[lods.level];
  const copcResolution = copcDepths[lods.copcDepth];
  const result = {
    benchmark: "point-cloud-parquet-vs-copc",
    measuredAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      repeats: options.repeats,
      warmup: options.warmup,
      copcDecoderConcurrency: options.concurrency,
      parquetRangeCoalescing: {
        maxGapBytes: options.rangeGap ?? 32_768,
        maxRequestBytes: options.rangeSize ?? 2_097_152,
      },
      transport: "range-equivalent local file reads; cold application cache per sample",
    },
    dataset: {
      parquet: basename(options.parquet),
      copc: basename(options.copc),
      points: totalPoints,
      parquetBytes,
      copcBytes,
      parquetToCopcStorage: parquetBytes / copcBytes,
      bounds: parquetBounds,
      queryCenter,
      queryCenterSource: "coordinate medians of the COPC root node",
    },
    lod: {
      matching: options.level === undefined && options.copcDepth === undefined
        ? "nearest cumulative global point count to 25% of source points"
        : "explicit level(s), with omitted side matched by nearest cumulative global point count",
      parquet: {
        maxLevel: lods.level,
        cumulativePoints: parquetResolution.rowEnd,
        geometricError: parquetResolution.geometricError,
      },
      copc: {
        maxDepth: lods.copcDepth,
        cumulativePoints: copcResolution.cumulativePoints,
        nominalSpacing: discoveredCopc.copc.info.spacing / 2 ** lods.copcDepth,
      },
    },
    queries: queryResults,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.output !== undefined) await writeFile(options.output, json);
  process.stdout.write(json);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
