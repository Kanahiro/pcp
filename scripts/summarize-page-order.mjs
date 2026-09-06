import fs from "node:fs";
import path from "node:path";

const inputDirectory = process.argv[2] ?? "benchmarks/page-order-256k";
const outputPath = process.argv[3] ?? path.join(inputDirectory, "summary.json");
const filePattern = /^(spatial|hilbert)-pg(\d+)(?:-rerun)?\.json$/;
const directionalQueries = new Set(["thin-x", "thin-y", "thin-z"]);

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const sumQueryMetric = (benchmark, side, metric) =>
  benchmark.queries.reduce((sum, query) => sum + query[side][metric], 0);

const files = fs.readdirSync(inputDirectory)
  .filter((file) => filePattern.test(file))
  .sort();

if (files.length === 0) {
  throw new Error(`no page-order benchmark JSON files found in ${inputDirectory}`);
}

const groups = new Map();
for (const file of files) {
  const [, pageOrder, pageRowsText] = file.match(filePattern);
  const pageRowCount = Number(pageRowsText);
  const id = `${pageOrder}/${pageRowCount}`;
  const benchmark = JSON.parse(fs.readFileSync(path.join(inputDirectory, file), "utf8"));
  const runs = groups.get(id) ?? [];
  runs.push({ file, benchmark, pageOrder, pageRowCount });
  groups.set(id, runs);
}

const allRuns = [...groups.values()].flat();
const reference = allRuns[0].benchmark;
const invariantSignature = (benchmark) => JSON.stringify({
  points: benchmark.dataset.points,
  lod: benchmark.lod,
  queryNames: benchmark.queries.map((query) => query.name),
  parquetMatched: benchmark.queries.map((query) => query.parquet.pointsMatched),
  parquetCandidates: benchmark.queries.map((query) => query.parquet.pointsInCandidateRowGroups),
  parquetRowGroups: benchmark.queries.map((query) => query.parquet.rowGroupsTotal),
  copc: benchmark.queries.map((query) => ({
    bytes: query.copc.bytesFetched,
    calls: query.copc.rangeRequests,
    matched: query.copc.pointsMatched,
  })),
  repeats: benchmark.environment.repeats,
  warmup: benchmark.environment.warmup,
  decoderConcurrency: benchmark.environment.copcDecoderConcurrency,
  coalescing: benchmark.environment.parquetRangeCoalescing,
  transport: benchmark.environment.transport,
});
const expectedInvariantSignature = invariantSignature(reference);
for (const run of allRuns.slice(1)) {
  if (invariantSignature(run.benchmark) !== expectedInvariantSignature) {
    throw new Error(`benchmark conditions differ in ${run.file}`);
  }
}

const configurations = [...groups.values()].map((runs) => {
  const first = runs[0];
  const ioSignature = (run) => JSON.stringify({
    fileBytes: run.benchmark.dataset.parquetBytes,
    queries: run.benchmark.queries.map((query) => ({
      name: query.name,
      bytes: query.parquet.bytesFetched,
      calls: query.parquet.rangeRequests,
      candidates: query.parquet.pointsInCandidateRowGroups,
      matched: query.parquet.pointsMatched,
    })),
  });
  const expectedIoSignature = ioSignature(first);
  for (const run of runs.slice(1)) {
    if (ioSignature(run) !== expectedIoSignature) {
      throw new Error(`non-deterministic I/O metrics for ${first.pageOrder}/${first.pageRowCount}`);
    }
  }

  const benchmark = first.benchmark;
  const elapsed = runs.map((run) => sumQueryMetric(run.benchmark, "parquet", "elapsedMs"));
  const queryBreakdown = benchmark.queries.map((query) => ({
    query: query.name,
    transferBytes: query.parquet.bytesFetched,
    rangeCalls: query.parquet.rangeRequests,
    candidatePoints: query.parquet.pointsInCandidateRowGroups,
    matchedPoints: query.parquet.pointsMatched,
    callsPer100kMatched: query.parquet.rangeRequests / query.parquet.pointsMatched * 100_000,
  }));
  const directional = queryBreakdown.filter((query) => directionalQueries.has(query.query));
  const directionalCalls = directional.map((query) => query.rangeCalls);
  const directionalMean = directionalCalls.reduce((sum, value) => sum + value, 0) / directionalCalls.length;
  const directionalStdDev = Math.sqrt(directionalCalls.reduce(
    (sum, value) => sum + (value - directionalMean) ** 2,
    0,
  ) / directionalCalls.length);
  const thinX = directional.find((query) => query.query === "thin-x");
  const thinY = directional.find((query) => query.query === "thin-y");

  return {
    config: `${first.pageOrder}/${first.pageRowCount / 1024}K`,
    pageOrder: first.pageOrder,
    rowGroupSize: 262_144,
    pageRowCount: first.pageRowCount,
    benchmarkRuns: runs.length,
    sourceFiles: runs.map((run) => run.file),
    fileBytes: benchmark.dataset.parquetBytes,
    transferBytes: sumQueryMetric(benchmark, "parquet", "bytesFetched"),
    rangeCalls: sumQueryMetric(benchmark, "parquet", "rangeRequests"),
    maxQueryCalls: Math.max(...benchmark.queries.map((query) => query.parquet.rangeRequests)),
    elapsedMs: {
      median: median(elapsed),
      min: Math.min(...elapsed),
      max: Math.max(...elapsed),
    },
    directionality: {
      thinXCalls: thinX.rangeCalls,
      thinYCalls: thinY.rangeCalls,
      thinZCalls: directional.find((query) => query.query === "thin-z").rangeCalls,
      thinXYCallGap: Math.abs(thinY.rangeCalls - thinX.rangeCalls),
      thinXYCallRatio: Math.max(thinX.rangeCalls, thinY.rangeCalls) /
        Math.min(thinX.rangeCalls, thinY.rangeCalls),
      callRange: Math.max(...directionalCalls) - Math.min(...directionalCalls),
      callCoefficientOfVariation: directionalStdDev / directionalMean,
    },
    queryBreakdown,
  };
}).sort((left, right) =>
  left.pageRowCount - right.pageRowCount || left.pageOrder.localeCompare(right.pageOrder));

for (const configuration of configurations) {
  const spatial = configurations.find((candidate) =>
    candidate.pageOrder === "spatial" && candidate.pageRowCount === configuration.pageRowCount);
  configuration.vsSpatial = {
    fileBytes: configuration.fileBytes / spatial.fileBytes - 1,
    transferBytes: configuration.transferBytes / spatial.transferBytes - 1,
    rangeCalls: configuration.rangeCalls / spatial.rangeCalls - 1,
    maxQueryCalls: configuration.maxQueryCalls / spatial.maxQueryCalls - 1,
    thinXYCallGap: configuration.directionality.thinXYCallGap /
      spatial.directionality.thinXYCallGap - 1,
  };
}

const measuredAt = allRuns.map((run) => run.benchmark.measuredAt).sort();
const result = {
  benchmark: "point-cloud-parquet-page-order-256k",
  measuredAt: { first: measuredAt[0], last: measuredAt.at(-1) },
  experiment: {
    rowGroupSize: 262_144,
    pageRowCounts: [...new Set(configurations.map((configuration) => configuration.pageRowCount))],
    pageOrders: [...new Set(configurations.map((configuration) => configuration.pageOrder))],
    primaryDirectionalityMetric: "absolute Range-call gap between thin-x and thin-y",
    rationale: "thin-x and thin-y have similar matched-point counts; thin-z is retained but not used as the primary symmetry metric because it matches about 8-9x more points",
  },
  validation: {
    sourceFiles: files.length,
    consistentBenchmarkConditions: true,
    deterministicHilbertRerunIo: true,
  },
  configurations,
};

fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, configurations: configurations.length }, null, 2));
