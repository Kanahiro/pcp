#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

const [file, xmin, xmax, ymin, ymax, zmin, zmax, resolution, copc] = process.argv.slice(2);
if ([file, xmin, xmax, ymin, ymax, zmin, zmax, resolution].some((value) => value === undefined)) {
  console.error("usage: node scripts/benchmark-duckdb.mjs FILE XMIN XMAX YMIN YMAX ZMIN ZMAX RESOLUTION [COPC]");
  process.exit(2);
}
const numbers = [xmin, xmax, ymin, ymax, zmin, zmax, resolution];
if (!numbers.every((value) => /^-?\d+$/.test(value))) {
  console.error("bbox and resolution arguments must be quantized integers");
  process.exit(2);
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const spatialPredicate = `x BETWEEN ${xmin} AND ${xmax}
  AND y BETWEEN ${ymin} AND ${ymax}
  AND z BETWEEN ${zmin} AND ${zmax}`;
const allColumns = [
  "x", "y", "z", "intensity", "return_number", "number_of_returns",
  "scan_direction_flag", "edge_of_flight_line", "classification", "synthetic",
  "key_point", "withheld", "overlap", "scanner_channel", "scan_angle", "user_data",
  "point_source_id", "gps_time", "red", "green", "blue", "nir",
  "wave_packet_descriptor_index", "waveform_data_offset", "waveform_packet_size",
  "return_point_waveform_location", "waveform_x_t", "waveform_y_t", "waveform_z_t",
  "extra_bytes",
];

function query(sql) {
  const started = performance.now();
  const result = spawnSync("duckdb", ["-json", "-c", sql], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "duckdb failed");
  return { rows: JSON.parse(result.stdout), elapsedMs: performance.now() - started };
}

const metadataResult = query(`SELECT decode(value) AS value
  FROM parquet_kv_metadata(${quote(file)}) WHERE decode(key) = 'point_cloud'`);
const pointCloud = JSON.parse(metadataResult.rows[0].value);
const maxResolution = Number(resolution);
if (!Array.isArray(pointCloud.level_row_group_ends) || maxResolution >= pointCloud.level_row_group_ends.length) {
  console.error(`resolution must be between 0 and ${pointCloud.level_row_group_ends?.length - 1}`);
  process.exit(2);
}
const lodRowGroupEnd = pointCloud.level_row_group_ends[maxResolution];
const lodPointsResult = query(`SELECT sum(points)::BIGINT AS value FROM (
    SELECT row_group_id, any_value(row_group_num_rows) AS points
    FROM parquet_metadata(${quote(file)})
    WHERE row_group_id < ${lodRowGroupEnd} GROUP BY row_group_id
  )`);
const lodPoints = lodRowGroupEnd === 0 ? 0 : Number(lodPointsResult.rows[0].value);

// A plain count(*) can be answered from the footer. Hashing every projected
// column forces a real full decode, which is what this benchmark promises.
const full = query(`SELECT count(*) AS points,
  sum(hash(${allColumns.join(", ")})::HUGEINT) AS checksum
  FROM read_parquet(${quote(file)})`);
const bbox = query(`WITH lod AS (
    SELECT * FROM read_parquet(${quote(file)}) LIMIT ${lodPoints}
  ) SELECT count(*) AS points FROM lod WHERE ${spatialPredicate}`);
const candidates = query(`
  WITH row_group_stats AS (
    SELECT row_group_id, any_value(row_group_num_rows) AS points,
      max(CASE WHEN path_in_schema = 'x' THEN stats_min::BIGINT END) AS xmin,
      max(CASE WHEN path_in_schema = 'x' THEN stats_max::BIGINT END) AS xmax,
      max(CASE WHEN path_in_schema = 'y' THEN stats_min::BIGINT END) AS ymin,
      max(CASE WHEN path_in_schema = 'y' THEN stats_max::BIGINT END) AS ymax,
      max(CASE WHEN path_in_schema = 'z' THEN stats_min::BIGINT END) AS zmin,
      max(CASE WHEN path_in_schema = 'z' THEN stats_max::BIGINT END) AS zmax
    FROM parquet_metadata(${quote(file)}) GROUP BY row_group_id
  )
  SELECT count(*) AS row_groups_read, sum(points) AS points_in_candidate_row_groups
  FROM row_group_stats
  WHERE row_group_id < ${lodRowGroupEnd}
    AND (xmin IS NULL OR xmax IS NULL OR (xmax >= ${xmin} AND xmin <= ${xmax}))
    AND (ymin IS NULL OR ymax IS NULL OR (ymax >= ${ymin} AND ymin <= ${ymax}))
    AND (zmin IS NULL OR zmax IS NULL OR (zmax >= ${zmin} AND zmin <= ${zmax}))`);
const totalGroups = query(`SELECT count(DISTINCT row_group_id) AS value FROM parquet_metadata(${quote(file)})`);
const columnStorage = query(`SELECT path_in_schema AS column_name,
  sum(total_compressed_size)::BIGINT AS compressed_bytes
  FROM parquet_metadata(${quote(file)}) GROUP BY path_in_schema ORDER BY path_in_schema`);
const bytes = statSync(file).size;
const points = Number(full.rows[0].points);
const candidate = candidates.rows[0];

console.log(JSON.stringify({
  storage: {
    parquetBytes: bytes,
    bytesPerPoint: bytes / points,
    columnCompressedBytes: Object.fromEntries(
      columnStorage.rows.map((row) => [row.column_name, Number(row.compressed_bytes)]),
    ),
    ...(copc === undefined ? {} : { copcBytes: statSync(copc).size }),
  },
  fullScan: { points, checksum: full.rows[0].checksum, elapsedMs: full.elapsedMs },
  spatialQuery: {
    matchedPoints: Number(bbox.rows[0].points),
    elapsedMs: bbox.elapsedMs,
    rowGroupsTotal: Number(totalGroups.rows[0].value),
    rowGroupsRead: Number(candidate.row_groups_read),
    rowGroupsPruned: Number(totalGroups.rows[0].value) - Number(candidate.row_groups_read),
    pointsInCandidateRowGroups: Number(candidate.points_in_candidate_row_groups ?? 0),
  },
}, null, 2));
