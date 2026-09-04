import { type FileMetaData, type RowGroup } from "hyparquet";
export interface PointCloudMetadata {
    version: string;
    scale: [number, number, number];
    offset: [number, number, number];
    bounds: [number, number, number, number, number, number];
    level_row_group_ends: number[];
    base_voxel_size: number;
    coarsest_voxel_size?: number;
    hierarchy: string;
    spatial_order: string;
    source_las?: {
        point_format: number;
        extra_bytes_per_point: number;
        scan_angle_scale: number;
    };
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
export interface ResolutionInfo {
    resolution: number;
    rowGroupStart: number;
    rowGroupEnd: number;
    rowStart: number;
    rowEnd: number;
    pointCount: number;
    voxelSize: number;
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
    points: QuantizedPoint[];
    metrics: QueryMetrics;
}
export interface QueryChunk {
    rowGroupIndex: number;
    points: QuantizedPoint[];
}
export interface OpenOptions {
    byteLength?: number;
    fetch?: typeof globalThis.fetch;
    requestInit?: RequestInit;
}
export declare class PointCloudParquet {
    private readonly file;
    readonly metadata: PointCloudMetadata;
    readonly parquetMetadata: FileMetaData;
    readonly metadataBytesFetched: number;
    readonly rowGroups: SpatialRowGroup[];
    readonly resolutions: ResolutionInfo[];
    private constructor();
    static open(url: string, options?: OpenOptions): Promise<PointCloudParquet>;
    worldToQuantized(bounds: WorldBounds): QuantizedBounds;
    decodePosition(point: Pick<QuantizedPoint, "x" | "y" | "z">): [number, number, number];
    queryWorld(bounds: WorldBounds, maxResolution: number, onChunk?: (chunk: QueryChunk) => void): Promise<QueryResult>;
    queryQuantized(bounds: QuantizedBounds, maxResolution: number, onChunk?: (chunk: QueryChunk) => void): Promise<QueryResult>;
    queryRowGroupsWorld(bounds: WorldBounds, rowGroupIndices: number[], onChunk?: (chunk: QueryChunk) => void): Promise<QueryResult>;
    private readRowGroups;
    private emptyResult;
}
export declare function planQuery(rowGroups: RowGroup[], bounds: QuantizedBounds, levelRowGroupEnds: number[], maxResolution: number): {
    rowGroupsRead: number;
    pointsInCandidateRowGroups: number;
};
