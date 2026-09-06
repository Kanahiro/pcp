import type {
  PointCloudMetadata,
  QueryMetrics,
  ResolutionInfo,
  SpatialPage,
  SpatialRowGroup,
  WorldBounds,
} from "@pointcloud-parquet/browser";
import type { ColorMode } from "./point-buffer";

export interface CloudDescription {
  metadata: PointCloudMetadata;
  metadataBytesFetched: number;
  resolutions: ResolutionInfo[];
  rowGroups: SpatialRowGroup[];
}

export interface RenderedQuery {
  metrics: QueryMetrics;
  workerElapsedMs: number;
}

export interface RenderedChunk {
  rowGroupIndex: number;
  quantizedPositions: Int32Array;
  colors: Float32Array;
}

export interface RecoloredPoints {
  colorChunks: Array<{ rowGroupIndex: number; colors: Float32Array }>;
}

export type WorkerCommand =
  | { kind: "open"; url: string }
  | { kind: "page-bounds" }
  | {
      kind: "query-level";
      bounds: WorldBounds;
      resolution: number;
      colorMode: ColorMode;
    }
  | {
      kind: "query-row-groups";
      bounds: WorldBounds;
      rowGroupIndices: number[];
      colorMode: ColorMode;
    }
  | { kind: "recolor"; colorMode: ColorMode };

export type WorkerRequest = WorkerCommand & { id: number };

export type WorkerResponse =
  | { id: number; ok: true; kind: "result"; payload: CloudDescription | SpatialPage[] | RenderedQuery | RecoloredPoints }
  | { id: number; ok: true; kind: "query-chunk"; payload: RenderedChunk }
  | { id: number; ok: false; error: string };
