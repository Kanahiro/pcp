import { type FileMetaData, type RowGroup } from "hyparquet";
import { type QuantizedPointColumns } from "./point-columns.js";
import { type RangeCoalescingOptions } from "./range-cache.js";
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
export declare class PointCloudParquet {
    private readonly file;
    private readonly compressors;
    readonly metadata: PointCloudMetadata;
    readonly parquetMetadata: FileMetaData;
    readonly metadataBytesFetched: number;
    readonly rowGroups: SpatialRowGroup[];
    readonly resolutions: ResolutionInfo[];
    private pageBoundsPromise;
    private constructor();
    static open(url: string, options?: OpenOptions): Promise<PointCloudParquet>;
    worldToQuantized(bounds: WorldBounds): QuantizedBounds;
    decodePosition(point: Pick<QuantizedPoint, "x" | "y" | "z">): [number, number, number];
    queryWorld(bounds: WorldBounds, maxResolution: number, onChunk?: (chunk: QueryChunk) => void): Promise<QueryResult>;
    queryQuantized(bounds: QuantizedBounds, maxResolution: number, onChunk?: (chunk: QueryChunk) => void): Promise<QueryResult>;
    queryRowGroupsWorld(bounds: WorldBounds, rowGroupIndices: number[], onChunk?: (chunk: QueryChunk) => void): Promise<QueryResult>;
    /** Loads coordinate Page Indexes lazily and exposes no Parquet index details. */
    pageBounds(): Promise<SpatialPage[]>;
    private readRowGroups;
    private readPageBounds;
    private emptyResult;
}
export declare function planQuery(rowGroups: RowGroup[], bounds: QuantizedBounds, levelRowGroupEnds: number[], maxResolution: number): {
    rowGroupsRead: number;
    pointsInCandidateRowGroups: number;
};
