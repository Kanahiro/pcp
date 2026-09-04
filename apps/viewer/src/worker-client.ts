import type { ColorMode } from "./point-buffer";
import type {
  CloudDescription,
  RecoloredPoints,
  RenderedChunk,
  RenderedQuery,
  WorkerCommand,
  WorkerResponse,
} from "./worker-protocol";
import type { WorldBounds } from "@pointcloud-parquet/browser";

export class PointCloudWorkerClient {
  private readonly worker = new Worker(new URL("./point-cloud.worker.ts", import.meta.url), {
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

  query(
    bounds: WorldBounds,
    resolution: number,
    origin: [number, number, number],
    colorMode: ColorMode,
    onChunk?: (chunk: RenderedChunk) => void,
  ): Promise<RenderedQuery> {
    return this.send({ kind: "query-level", bounds, resolution, origin, colorMode }, onChunk);
  }

  queryRowGroups(
    bounds: WorldBounds,
    rowGroupIndices: number[],
    origin: [number, number, number],
    colorMode: ColorMode,
    onChunk?: (chunk: RenderedChunk) => void,
  ): Promise<RenderedQuery> {
    return this.send(
      { kind: "query-row-groups", bounds, rowGroupIndices, origin, colorMode },
      onChunk,
    );
  }

  recolor(colorMode: ColorMode): Promise<RecoloredPoints> {
    return this.send({ kind: "recolor", colorMode });
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
