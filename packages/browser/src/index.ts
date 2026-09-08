import {
  asyncBufferFromUrl,
  parquetMetadataAsync,
  parquetScan,
  parquetSchema,
  readColumnIndex,
  readOffsetIndex,
  type AsyncBuffer,
  type Compressors,
  type FileMetaData,
  type ParquetQueryFilter,
  type RowGroup,
  type SchemaElement,
} from "hyparquet";
import { loadCompressors } from "./compressors.js";
import {
  concatenatePointColumns,
  POINT_COLUMNS,
  readMatchingPointColumns,
  type QuantizedPointColumns,
} from "./point-columns.js";
import { RangeCache, type RangeCoalescingOptions } from "./range-cache.js";

export type { RangeCoalescingOptions } from "./range-cache.js";
export type { QuantizedPointColumns } from "./point-columns.js";

export interface PointCloudMetadata {
  version: string;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: [number, number, number, number, number, number];
  level_row_group_ends: number[];
  /** Adjacent-level cube edge ratio; the finest cube edge is max(scale). */
  voxel_edge_ratio: number;
  crs: Record<string, unknown> | null;
}

export interface QuantizedBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface SpatialRowGroup {
  index: number;
  resolution: number;
  pointCount: number;
  rowStart: number;
  rowEnd: number;
  geometricError: number;
  quantizedBounds: QuantizedBounds;
  worldBounds: WorldBounds;
}

export interface SpatialPage {
  rowGroupIndex: number;
  pageIndex: number;
  resolution: number;
  pointCount: number;
  quantizedBounds: QuantizedBounds;
  worldBounds: WorldBounds;
}

export interface ResolutionInfo {
  resolution: number;
  rowGroupStart: number;
  rowGroupEnd: number;
  rowStart: number;
  rowEnd: number;
  pointCount: number;
  geometricError: number;
  worldBounds: WorldBounds | null;
}

export interface WorldBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface QuantizedPoint {
  resolution: number;
  x: number;
  y: number;
  z: number;
  red: number | null;
  green: number | null;
  blue: number | null;
}

export interface QueryMetrics {
  bytesFetched: number;
  rangeRequests: number;
  rowGroupsTotal: number;
  rowGroupsRead: number;
  rowGroupsPruned: number;
  pointsInCandidateRowGroups: number;
  pointsMatched: number;
  elapsedMs: number;
}

export interface QueryResult {
  chunks: QuantizedPointColumns[];
  metrics: QueryMetrics;
}

export interface QueryChunk {
  rowGroupIndex: number;
  points: QuantizedPointColumns;
}

export interface OpenOptions {
  byteLength?: number;
  fetch?: typeof globalThis.fetch;
  requestInit?: RequestInit;
  rangeCoalescing?: RangeCoalescingOptions;
}

export class PointCloudParquet {
  readonly metadata: PointCloudMetadata;
  readonly parquetMetadata: FileMetaData;
  readonly metadataBytesFetched: number;
  readonly rowGroups: SpatialRowGroup[];
  readonly resolutions: ResolutionInfo[];
  private pageBoundsPromise: Promise<SpatialPage[]> | undefined;

  private constructor(
    private readonly file: RangeCache,
    private readonly compressors: Compressors,
    metadata: PointCloudMetadata,
    parquetMetadata: FileMetaData,
    metadataBytesFetched: number,
  ) {
    this.metadata = metadata;
    this.parquetMetadata = parquetMetadata;
    this.metadataBytesFetched = metadataBytesFetched;
    this.rowGroups = buildSpatialRowGroups(parquetMetadata.row_groups, metadata);
    this.resolutions = buildResolutionInfo(this.rowGroups, metadata);
  }

  static async open(url: string, options: OpenOptions = {}): Promise<PointCloudParquet> {
    const [file, compressors] = await Promise.all([
      asyncBufferFromUrl({
        url,
        ...(options.byteLength === undefined ? {} : { byteLength: options.byteLength }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.requestInit === undefined ? {} : { requestInit: options.requestInit }),
      }),
      loadCompressors(),
    ]);
    const metered = new MeteredBuffer(file);
    const parquetMetadata = await parquetMetadataAsync(metered);
    const metadata = parsePointCloudMetadata(parquetMetadata);
    validateLevelLayout(metadata.level_row_group_ends, parquetMetadata);
    return new PointCloudParquet(
      new RangeCache(file, 64 * 1024 * 1024, options.rangeCoalescing),
      compressors,
      metadata,
      parquetMetadata,
      metered.bytesFetched,
    );
  }

  worldToQuantized(bounds: WorldBounds): QuantizedBounds {
    const { scale, offset } = this.metadata;
    return {
      min: [0, 1, 2].map((axis) =>
        Math.ceil((bounds.min[axis]! - offset[axis]!) / scale[axis]!),
      ) as [number, number, number],
      max: [0, 1, 2].map((axis) =>
        Math.floor((bounds.max[axis]! - offset[axis]!) / scale[axis]!),
      ) as [number, number, number],
    };
  }

  decodePosition(point: Pick<QuantizedPoint, "x" | "y" | "z">): [number, number, number] {
    const { scale, offset } = this.metadata;
    return [
      point.x * scale[0] + offset[0],
      point.y * scale[1] + offset[1],
      point.z * scale[2] + offset[2],
    ];
  }

  async queryWorld(
    bounds: WorldBounds,
    maxResolution: number,
    onChunk?: (chunk: QueryChunk) => void,
  ): Promise<QueryResult> {
    validateResolution(maxResolution, this.resolutions.length);
    const quantized = this.worldToQuantized(bounds);
    if (quantized.min.some((minimum, axis) => minimum > quantized.max[axis]!)) {
      return this.emptyResult();
    }
    return this.queryQuantized(quantized, maxResolution, onChunk);
  }

  async queryQuantized(
    bounds: QuantizedBounds,
    maxResolution: number,
    onChunk?: (chunk: QueryChunk) => void,
  ): Promise<QueryResult> {
    validateQuery(bounds, maxResolution, this.resolutions.length);
    const rowGroupEnd = this.metadata.level_row_group_ends[maxResolution]!;
    return this.readRowGroups(
      bounds,
      Array.from({ length: rowGroupEnd }, (_, index) => index),
      onChunk,
    );
  }

  async queryRowGroupsWorld(
    bounds: WorldBounds,
    rowGroupIndices: number[],
    onChunk?: (chunk: QueryChunk) => void,
  ): Promise<QueryResult> {
    const indices = validateRowGroupIndices(rowGroupIndices, this.rowGroups.length);
    const quantized = this.worldToQuantized(bounds);
    if (quantized.min.some((minimum, axis) => minimum > quantized.max[axis]!)) {
      return this.emptyResult();
    }
    return this.readRowGroups(quantized, indices, onChunk);
  }

  /** Loads coordinate Page Indexes lazily and exposes no Parquet index details. */
  pageBounds(): Promise<SpatialPage[]> {
    this.pageBoundsPromise ??= this.readPageBounds();
    return this.pageBoundsPromise;
  }

  private async readRowGroups(
    bounds: QuantizedBounds,
    rowGroupIndices: number[],
    onChunk?: (chunk: QueryChunk) => void,
  ): Promise<QueryResult> {
    const filter = queryFilter(bounds);
    const candidates = rowGroupIndices.filter((index) =>
      rowGroupMayMatch(this.parquetMetadata.row_groups[index]!, bounds));
    // Per-query metering keeps metrics correct when callers issue concurrent queries.
    const metered = this.file.session();
    const started = performance.now();
    const reads = candidates.map(async (index): Promise<QuantizedPointColumns> => {
      const group = this.rowGroups[index]!;
      const fullyContained = boundsContain(bounds, group.quantizedBounds);
      // Do not put a global prefetch barrier in front of the query: each Row
      // Group can decode and render as soon as its own bytes arrive.
      if (fullyContained) {
        await metered.prefetch([
          projectedColumnSpan(this.parquetMetadata.row_groups[index]!, POINT_COLUMNS),
        ]);
      }
      const scan = await parquetScan({
        file: metered,
        metadata: this.parquetMetadata,
        columns: [...POINT_COLUMNS],
        ...(fullyContained ? {} : { pruningFilter: filter }),
        rowStart: group.rowStart,
        rowEnd: group.rowEnd,
        compressors: this.compressors,
        usePageIndex: !fullyContained,
      });
      const parts = await Promise.all(scan.ranges.map((range) =>
        readMatchingPointColumns(scan, range, bounds, group.resolution)));
      const points = concatenatePointColumns(parts, group.resolution);
      onChunk?.({ rowGroupIndex: index, points });
      return points;
    });
    const chunks = await Promise.all(reads);
    const elapsedMs = performance.now() - started;
    return {
      metrics: {
        bytesFetched: metered.bytesFetched,
        rangeRequests: metered.requests,
        rowGroupsTotal: this.parquetMetadata.row_groups.length,
        rowGroupsRead: candidates.length,
        rowGroupsPruned: this.parquetMetadata.row_groups.length - candidates.length,
        pointsInCandidateRowGroups: candidates.reduce(
          (sum, index) => sum + this.rowGroups[index]!.pointCount,
          0,
        ),
        pointsMatched: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        elapsedMs,
      },
      chunks,
    };
  }

  private async readPageBounds(): Promise<SpatialPage[]> {
    const file = this.file.session();
    const schema = parquetSchema(this.parquetMetadata);
    const coordinateSchemas = ["x", "y", "z"].map((name) =>
      findSchemaElement(schema, name));
    const groups = await Promise.all(this.parquetMetadata.row_groups.map(
      async (rowGroup, rowGroupIndex) => {
        const coordinatePages = await Promise.all(coordinateSchemas.map((element) =>
          readIndexedColumnPages(file, rowGroup, element)));
        const starts = coordinatePages[0]!.starts;
        if (coordinatePages.some((pages) => !sameNumbers(pages.starts, starts))) {
          throw new Error(`XYZ page boundaries differ in Row Group ${rowGroupIndex}`);
        }
        const group = this.rowGroups[rowGroupIndex]!;
        return starts.map((start, pageIndex): SpatialPage => {
          const end = starts[pageIndex + 1] ?? group.pointCount;
          const quantizedBounds: QuantizedBounds = {
            min: coordinatePages.map((pages) => pages.minimums[pageIndex]!) as [number, number, number],
            max: coordinatePages.map((pages) => pages.maximums[pageIndex]!) as [number, number, number],
          };
          return {
            rowGroupIndex,
            pageIndex,
            resolution: group.resolution,
            pointCount: end - start,
            quantizedBounds,
            worldBounds: decodeBounds(quantizedBounds, this.metadata),
          };
        });
      },
    ));
    return groups.flat();
  }

  private emptyResult(): QueryResult {
    return {
      chunks: [],
      metrics: {
        bytesFetched: 0,
        rangeRequests: 0,
        rowGroupsTotal: this.parquetMetadata.row_groups.length,
        rowGroupsRead: 0,
        rowGroupsPruned: this.parquetMetadata.row_groups.length,
        pointsInCandidateRowGroups: 0,
        pointsMatched: 0,
        elapsedMs: 0,
      },
    };
  }
}

interface IndexedColumnPages {
  starts: number[];
  minimums: number[];
  maximums: number[];
}

async function readIndexedColumnPages(
  file: AsyncBuffer,
  rowGroup: RowGroup,
  schema: SchemaElement,
): Promise<IndexedColumnPages> {
  const column = rowGroup.columns.find((candidate) =>
    candidate.meta_data?.path_in_schema.join(".") === schema.name);
  if (!column?.column_index_offset || !column.column_index_length
    || !column.offset_index_offset || !column.offset_index_length) {
    throw new Error(`Parquet column ${schema.name} is missing its Page Index`);
  }
  const columnStart = Number(column.column_index_offset);
  const offsetStart = Number(column.offset_index_offset);
  const [columnBuffer, offsetBuffer] = await Promise.all([
    file.slice(columnStart, columnStart + column.column_index_length),
    file.slice(offsetStart, offsetStart + column.offset_index_length),
  ]);
  const columnIndex = readColumnIndex({ view: new DataView(columnBuffer), offset: 0 }, schema);
  const offsetIndex = readOffsetIndex({ view: new DataView(offsetBuffer), offset: 0 });
  const starts = offsetIndex.page_locations.map((location) => Number(location.first_row_index));
  if (columnIndex.null_pages.some(Boolean)
    || columnIndex.min_values.length !== starts.length
    || columnIndex.max_values.length !== starts.length) {
    throw new Error(`Parquet column ${schema.name} has an invalid Page Index`);
  }
  return {
    starts,
    minimums: columnIndex.min_values.map((value) => requiredNumber(value, schema.name)),
    maximums: columnIndex.max_values.map((value) => requiredNumber(value, schema.name)),
  };
}

function findSchemaElement(schema: ReturnType<typeof parquetSchema>, name: string): SchemaElement {
  const node = schema.children.find((child) => child.path.join(".") === name);
  if (!node) throw new Error(`Parquet schema is missing column ${name}`);
  return node.element;
}

function requiredNumber(value: unknown, column: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Parquet column ${column} has non-numeric Page Index statistics`);
  }
  return value;
}

function sameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

class MeteredBuffer implements AsyncBuffer {
  readonly byteLength: number;
  bytesFetched = 0;
  requests = 0;
  private readonly cached: Array<{ start: number; end: number; data: ArrayBuffer }> = [];

  constructor(private readonly source: AsyncBuffer) {
    this.byteLength = source.byteLength;
  }

  async prefetch(ranges: Array<{ start: number; end: number }>): Promise<void> {
    const cached = await Promise.all(ranges.map(async ({ start, end }) => ({
      start,
      end,
      data: await this.readSource(start, end),
    })));
    this.cached.push(...cached);
  }

  async slice(start: number, end?: number): Promise<ArrayBuffer> {
    const requestedEnd = end ?? this.byteLength;
    const cached = this.cached.find((entry) => start >= entry.start && requestedEnd <= entry.end);
    if (cached) {
      return cached.data.slice(start - cached.start, requestedEnd - cached.start);
    }
    return this.readSource(start, end);
  }

  private async readSource(start: number, end?: number): Promise<ArrayBuffer> {
    const value = await this.source.slice(start, end);
    this.requests += 1;
    this.bytesFetched += value.byteLength;
    return value;
  }
}

function projectedColumnSpan(
  rowGroup: RowGroup,
  columns: readonly string[],
): { start: number; end: number } {
  const selected = rowGroup.columns.filter((chunk) => {
    const name = chunk.meta_data?.path_in_schema[0];
    return name !== undefined && columns.includes(name);
  });
  if (selected.length !== columns.length) {
    throw new Error("Parquet Row Group is missing one or more XYZRGB columns");
  }
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const chunk of selected) {
    const metadata = chunk.meta_data!;
    const offset = metadata.dictionary_page_offset ?? metadata.data_page_offset;
    start = Math.min(start, Number(offset));
    end = Math.max(end, Number(offset + metadata.total_compressed_size));
  }
  return { start, end };
}

function parsePointCloudMetadata(metadata: FileMetaData): PointCloudMetadata {
  const value = metadata.key_value_metadata?.find((entry) => entry.key === "point_cloud")?.value;
  if (value === undefined) throw new Error("Parquet metadata is missing the point_cloud key");
  const parsed: unknown = JSON.parse(value);
  if (!isPointCloudMetadata(parsed)) throw new Error("Invalid point_cloud metadata");
  return parsed;
}

function isPointCloudMetadata(value: unknown): value is PointCloudMetadata {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === "0.1.0" &&
    isNumberTuple(item.scale, 3) && item.scale.every((number) => number > 0) &&
    isNumberTuple(item.offset, 3) &&
    isNumberTuple(item.bounds, 6) &&
    Array.isArray(item.level_row_group_ends) && item.level_row_group_ends.length > 0 &&
      item.level_row_group_ends.every(isNonNegativeInteger) &&
    Number.isInteger(item.voxel_edge_ratio) && Number(item.voxel_edge_ratio) >= 2 &&
    (item.crs === null || (typeof item.crs === "object" && !Array.isArray(item.crs)))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNumberTuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function queryFilter(bounds: QuantizedBounds): ParquetQueryFilter {
  return {
    $and: [
      { x: { $gte: bounds.min[0], $lte: bounds.max[0] } },
      { y: { $gte: bounds.min[1], $lte: bounds.max[1] } },
      { z: { $gte: bounds.min[2], $lte: bounds.max[2] } },
    ],
  };
}

export function planQuery(
  rowGroups: RowGroup[],
  bounds: QuantizedBounds,
  levelRowGroupEnds: number[],
  maxResolution: number,
): { rowGroupsRead: number; pointsInCandidateRowGroups: number } {
  let rowGroupsRead = 0;
  let pointsInCandidateRowGroups = 0;
  const rowGroupEnd = levelRowGroupEnds[maxResolution]!;
  for (const rowGroup of rowGroups.slice(0, rowGroupEnd)) {
    if (rowGroupMayMatch(rowGroup, bounds)) {
      rowGroupsRead += 1;
      pointsInCandidateRowGroups += Number(rowGroup.num_rows);
    }
  }
  return { rowGroupsRead, pointsInCandidateRowGroups };
}

function rowGroupMayMatch(
  rowGroup: RowGroup,
  bounds: QuantizedBounds,
): boolean {
  const ranges = columnRanges(rowGroup);
  return (
    overlaps(ranges.get("x"), bounds.min[0], bounds.max[0]) &&
    overlaps(ranges.get("y"), bounds.min[1], bounds.max[1]) &&
    overlaps(ranges.get("z"), bounds.min[2], bounds.max[2])
  );
}

function overlaps(range: [number, number] | undefined, min: number, max: number): boolean {
  // Missing statistics must remain a candidate: pruning must be conservative.
  return range === undefined || (range[1] >= min && range[0] <= max);
}

function boundsContain(outer: QuantizedBounds, inner: QuantizedBounds): boolean {
  return inner.min.every((minimum, axis) =>
    minimum >= outer.min[axis]! && inner.max[axis]! <= outer.max[axis]!);
}

function validateQuery(bounds: QuantizedBounds, maxResolution: number, levels: number): void {
  validateResolution(maxResolution, levels);
  for (let axis = 0; axis < 3; axis += 1) {
    if (!Number.isInteger(bounds.min[axis]) || !Number.isInteger(bounds.max[axis])) {
      throw new TypeError("quantized bounds must contain integers");
    }
    if (bounds.min[axis]! > bounds.max[axis]!) {
      throw new RangeError("each bounds.min value must be <= bounds.max");
    }
  }
}

function validateResolution(resolution: number, levels: number): void {
  if (!Number.isInteger(resolution) || resolution < 0 || resolution >= levels) {
    throw new RangeError(`maxResolution must be an integer from 0 to ${levels - 1}`);
  }
}

function validateRowGroupIndices(indices: number[], count: number): number[] {
  if (!Array.isArray(indices)) throw new TypeError("rowGroupIndices must be an array");
  const sorted = [...new Set(indices)].sort((left, right) => left - right);
  if (sorted.some((index) => !Number.isInteger(index) || index < 0 || index >= count)) {
    throw new RangeError(`Row Group indices must be integers from 0 to ${count - 1}`);
  }
  return sorted;
}

function validateLevelLayout(levelRowGroupEnds: number[], metadata: FileMetaData): void {
  let previous = 0;
  for (const end of levelRowGroupEnds) {
    if (end < previous || end > metadata.row_groups.length) {
      throw new Error("point_cloud level Row Group ends must be ordered and in range");
    }
    previous = end;
  }
  if (previous !== metadata.row_groups.length) {
    throw new Error("point_cloud levels do not cover every Parquet Row Group");
  }
}

function buildSpatialRowGroups(rowGroups: RowGroup[], metadata: PointCloudMetadata): SpatialRowGroup[] {
  let resolution = 0;
  let rowStart = 0;
  const lastResolution = metadata.level_row_group_ends.length - 1;
  return rowGroups.map((rowGroup, index) => {
    while (index >= metadata.level_row_group_ends[resolution]!) resolution += 1;
    const quantizedBounds = rowGroupBounds(rowGroup);
    const pointCount = Number(rowGroup.num_rows);
    const group: SpatialRowGroup = {
      index,
      resolution,
      pointCount,
      rowStart,
      rowEnd: rowStart + pointCount,
      geometricError: resolution === lastResolution ? 0 : voxelDiagonalAt(metadata, resolution),
      quantizedBounds,
      worldBounds: decodeBounds(quantizedBounds, metadata),
    };
    rowStart += pointCount;
    return group;
  });
}

function buildResolutionInfo(
  rowGroups: SpatialRowGroup[],
  metadata: PointCloudMetadata,
): ResolutionInfo[] {
  let rowGroupStart = 0;
  let rowStart = 0;
  const levelCount = metadata.level_row_group_ends.length;
  return metadata.level_row_group_ends.map((rowGroupEnd, resolution) => {
    const groups = rowGroups.slice(rowGroupStart, rowGroupEnd);
    const pointCount = groups.reduce((sum, group) => sum + group.pointCount, 0);
    const rowEnd = rowStart + pointCount;
    const info: ResolutionInfo = {
      resolution,
      rowGroupStart,
      rowGroupEnd,
      rowStart,
      rowEnd,
      pointCount,
      geometricError: resolution === levelCount - 1
        ? 0
        : voxelDiagonalAt(metadata, resolution),
      worldBounds: unionBounds(groups.map((group) => group.worldBounds)),
    };
    rowGroupStart = rowGroupEnd;
    rowStart = rowEnd;
    return info;
  });
}

function voxelDiagonalAt(metadata: PointCloudMetadata, resolution: number): number {
  const exponent = metadata.level_row_group_ends.length - 1 - resolution;
  return Math.sqrt(3) * Math.max(...metadata.scale) * metadata.voxel_edge_ratio ** exponent;
}

function rowGroupBounds(rowGroup: RowGroup): QuantizedBounds {
  const ranges = columnRanges(rowGroup);
  const axes = ["x", "y", "z"].map((name) => ranges.get(name));
  if (axes.some((range) => range === undefined)) {
    throw new Error("every Row Group must contain x/y/z statistics");
  }
  return {
    min: [axes[0]![0], axes[1]![0], axes[2]![0]],
    max: [axes[0]![1], axes[1]![1], axes[2]![1]],
  };
}

function columnRanges(rowGroup: RowGroup): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  for (const column of rowGroup.columns) {
    const name = column.meta_data?.path_in_schema.join(".");
    const statistics = column.meta_data?.statistics;
    const min = statistics?.min_value ?? statistics?.min;
    const max = statistics?.max_value ?? statistics?.max;
    if (name !== undefined && typeof min === "number" && typeof max === "number") {
      ranges.set(name, [min, max]);
    }
  }
  return ranges;
}

function decodeBounds(bounds: QuantizedBounds, metadata: PointCloudMetadata): WorldBounds {
  const decode = (value: number, axis: number) => value * metadata.scale[axis]! + metadata.offset[axis]!;
  return {
    min: [decode(bounds.min[0], 0), decode(bounds.min[1], 1), decode(bounds.min[2], 2)],
    max: [decode(bounds.max[0], 0), decode(bounds.max[1], 1), decode(bounds.max[2], 2)],
  };
}

function unionBounds(bounds: WorldBounds[]): WorldBounds | null {
  if (bounds.length === 0) return null;
  return bounds.slice(1).reduce<WorldBounds>((union, item) => ({
    min: [Math.min(union.min[0], item.min[0]), Math.min(union.min[1], item.min[1]), Math.min(union.min[2], item.min[2])],
    max: [Math.max(union.max[0], item.max[0]), Math.max(union.max[1], item.max[1]), Math.max(union.max[2], item.max[2])],
  }), { min: [...bounds[0]!.min], max: [...bounds[0]!.max] });
}
