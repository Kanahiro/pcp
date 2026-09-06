import fs from "node:fs";
import path from "node:path";

const inputDirectory = process.argv[2] ?? "benchmarks/layout-matrix";
const outputPath = process.argv[3] ?? path.join(inputDirectory, "summary.json");
const configPattern = /^rg(\d+)-pg(\d+)(?:-rerun)?\.json$/;

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
  .filter((file) => configPattern.test(file))
  .sort();

if (files.length === 0) {
  throw new Error(`no layout benchmark JSON files found in ${inputDirectory}`);
}

const groups = new Map();
for (const file of files) {
  const match = file.match(configPattern);
  const rowGroupSize = Number(match[1]);
  const pageRowCount = Number(match[2]);
  const id = `${rowGroupSize}/${pageRowCount}`;
  const benchmark = JSON.parse(fs.readFileSync(path.join(inputDirectory, file), "utf8"));
  const runs = groups.get(id) ?? [];
  runs.push({ file, benchmark, rowGroupSize, pageRowCount });
  groups.set(id, runs);
}

const allRuns = [...groups.values()].flat();
const reference = allRuns[0].benchmark;
const invariantSignature = (benchmark) => JSON.stringify({
  points: benchmark.dataset.points,
  lod: benchmark.lod,
  queryNames: benchmark.queries.map((query) => query.name),
  parquetMatched: benchmark.queries.map((query) => query.parquet.pointsMatched),
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
      matched: query.parquet.pointsMatched,
    })),
  });
  const expectedSignature = ioSignature(first);
  for (const run of runs.slice(1)) {
    if (ioSignature(run) !== expectedSignature) {
      throw new Error(`non-deterministic I/O metrics for ${first.rowGroupSize}/${first.pageRowCount}`);
    }
  }

  const benchmark = first.benchmark;
  const elapsed = runs.map((run) => sumQueryMetric(run.benchmark, "parquet", "elapsedMs"));
  const normalizedElapsed = runs.map((run) =>
    sumQueryMetric(run.benchmark, "parquet", "elapsedMs") /
    sumQueryMetric(run.benchmark, "copc", "elapsedMs"));
  const queryBreakdown = benchmark.queries.map((query) => ({
    query: query.name,
    transferBytes: query.parquet.bytesFetched,
    rangeCalls: query.parquet.rangeRequests,
    candidatePoints: query.parquet.pointsInCandidateRowGroups,
    matchedPoints: query.parquet.pointsMatched,
  }));

  return {
    config: `${first.rowGroupSize / 1024}K/${first.pageRowCount / 1024}K`,
    rowGroupSize: first.rowGroupSize,
    pageRowCount: first.pageRowCount,
    benchmarkRuns: runs.length,
    sourceFiles: runs.map((run) => run.file),
    fileBytes: benchmark.dataset.parquetBytes,
    rowGroups: benchmark.queries[0].parquet.rowGroupsTotal,
    transferBytes: sumQueryMetric(benchmark, "parquet", "bytesFetched"),
    rangeCalls: sumQueryMetric(benchmark, "parquet", "rangeRequests"),
    maxQueryCalls: Math.max(...benchmark.queries.map((query) => query.parquet.rangeRequests)),
    candidatePoints: sumQueryMetric(benchmark, "parquet", "pointsInCandidateRowGroups"),
    matchedPoints: sumQueryMetric(benchmark, "parquet", "pointsMatched"),
    elapsedMs: {
      median: median(elapsed),
      min: Math.min(...elapsed),
      max: Math.max(...elapsed),
    },
    parquetToCopcElapsed: {
      median: median(normalizedElapsed),
      min: Math.min(...normalizedElapsed),
      max: Math.max(...normalizedElapsed),
    },
    queryBreakdown,
  };
}).sort((left, right) =>
  left.rowGroupSize - right.rowGroupSize || left.pageRowCount - right.pageRowCount);

const baseline = configurations.find((configuration) =>
  configuration.rowGroupSize === 65_536 && configuration.pageRowCount === 4_096);
if (!baseline) throw new Error("64K/4K baseline is missing");

for (const configuration of configurations) {
  configuration.vsBaseline = {
    fileBytes: configuration.fileBytes / baseline.fileBytes - 1,
    transferBytes: configuration.transferBytes / baseline.transferBytes - 1,
    rangeCalls: configuration.rangeCalls / baseline.rangeCalls - 1,
    candidatePoints: configuration.candidatePoints / baseline.candidatePoints - 1,
  };
}

const paretoMetrics = ["fileBytes", "transferBytes", "rangeCalls"];
const paretoConfigs = configurations.filter((candidate) =>
  !configurations.some((other) =>
    other !== candidate &&
    paretoMetrics.every((metric) => other[metric] <= candidate[metric]) &&
    paretoMetrics.some((metric) => other[metric] < candidate[metric])))
  .map((configuration) => configuration.config);

const measuredAt = files.map((file) =>
  JSON.parse(fs.readFileSync(path.join(inputDirectory, file), "utf8")).measuredAt).sort();
const result = {
  benchmark: "point-cloud-parquet-layout-matrix",
  measuredAt: { first: measuredAt[0], last: measuredAt.at(-1) },
  validation: {
    sourceFiles: files.length,
    consistentBenchmarkConditions: true,
    deterministicRerunIo: true,
  },
  baselineConfig: baseline.config,
  paretoMetrics,
  paretoConfigs,
  configurations,
};

fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, paretoConfigs, configurations: configurations.length }, null, 2));
