import type { SpatialPage, WorldBounds } from "@pointcloud-parquet/browser";
import type { ColorMode } from "../point-buffer";
import type {
  CloudDescription,
  RecoloredPoints,
  RenderedChunk,
  RenderedQuery,
  WorkerCommand,
  WorkerResponse,
} from "../worker-protocol";

/** Streaming boundary used by the viewer; Parquet and Worker details stay behind it. */
export interface PointCloudReader {
  open(url: string): Promise<CloudDescription>;
  pageBounds(): Promise<SpatialPage[]>;
  readLevel(
    bounds: WorldBounds,
    resolution: number,
    colorMode: ColorMode,
    onChunk?: (chunk: RenderedChunk) => void,
  ): Promise<RenderedQuery>;
  readRowGroups(
    bounds: WorldBounds,
    rowGroupIndices: number[],
    colorMode: ColorMode,
    onChunk?: (chunk: RenderedChunk) => void,
  ): Promise<RenderedQuery>;
  recolor(colorMode: ColorMode): Promise<Array<{ rowGroupIndex: number; colors: Float32Array }>>;
}

/** Parquet reader proxy. It owns command ordering and transferable chunk delivery. */
export class ParquetPointCloudReader implements PointCloudReader {
  private readonly worker = new Worker(new URL("../point-cloud.worker.ts", import.meta.url), {
    type: "module",
    name: "point-cloud-parquet",
  });
  private readonly pending = new Map<number, {
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    onChunk?: (chunk: RenderedChunk) => void;
  }>();
  private nextId = 1;

  constructor() {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      if (!response.ok) {
        this.pending.delete(response.id);
        pending.reject(new Error(response.error));
      } else if (response.kind === "query-chunk") {
        pending.onChunk?.(response.payload);
      } else {
        this.pending.delete(response.id);
        pending.resolve(response.payload);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || "point cloud Worker failed");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  open(url: string): Promise<CloudDescription> {
    return this.send({ kind: "open", url });
  }

  pageBounds(): Promise<SpatialPage[]> {
    return this.send({ kind: "page-bounds" });
  }

  readLevel(
    bounds: WorldBounds,
    resolution: number,
    colorMode: ColorMode,
    onChunk?: (chunk: RenderedChunk) => void,
  ): Promise<RenderedQuery> {
    return this.send({ kind: "query-level", bounds, resolution, colorMode }, onChunk);
  }

  readRowGroups(
    bounds: WorldBounds,
    rowGroupIndices: number[],
    colorMode: ColorMode,
    onChunk?: (chunk: RenderedChunk) => void,
  ): Promise<RenderedQuery> {
    return this.send(
      { kind: "query-row-groups", bounds, rowGroupIndices, colorMode },
      onChunk,
    );
  }

  async recolor(
    colorMode: ColorMode,
  ): Promise<Array<{ rowGroupIndex: number; colors: Float32Array }>> {
    return (await this.send<RecoloredPoints>({ kind: "recolor", colorMode })).colorChunks;
  }

  private send<T>(command: WorkerCommand, onChunk?: (chunk: RenderedChunk) => void): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (payload: unknown) => void,
        reject,
        ...(onChunk ? { onChunk } : {}),
      });
      this.worker.postMessage({ ...command, id });
    });
  }
}
