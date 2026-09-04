/// <reference lib="webworker" />

import { PointCloudParquet, type QuantizedPoint } from "@pointcloud-parquet/browser";
import { buildPointBuffers } from "./point-buffer";
import type {
  CloudDescription,
  RecoloredPoints,
  RenderedQuery,
  WorkerRequest,
  WorkerResponse,
} from "./worker-protocol";

let cloud: PointCloudParquet | null = null;
let lastPointChunks = new Map<number, QuantizedPoint[]>();
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  // Serialize commands so a color change can never overtake the query whose
  // decoded points it is supposed to recolor.
  queue = queue.then(() => handle(event.data)).catch((error: unknown) => {
    respond({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
};

async function handle(request: WorkerRequest): Promise<void> {
  if (request.kind === "open") {
    cloud = await PointCloudParquet.open(request.url);
    lastPointChunks.clear();
    const description: CloudDescription = {
      metadata: cloud.metadata,
      metadataBytesFetched: cloud.metadataBytesFetched,
      resolutions: cloud.resolutions,
      rowGroups: cloud.rowGroups,
    };
    respond({ id: request.id, ok: true, kind: "result", payload: description });
    return;
  }
  if (!cloud) throw new Error("open a point cloud before querying it");

  if (request.kind === "query-level" || request.kind === "query-row-groups") {
    const started = performance.now();
    const renderedChunks = new Map<number, QuantizedPoint[]>();
    const emitChunk = ({ rowGroupIndex, points }: { rowGroupIndex: number; points: QuantizedPoint[] }) => {
      if (points.length > 0) renderedChunks.set(rowGroupIndex, points);
      const buffers = buildPointBuffers(points, cloud!.metadata, request.colorMode);
      respond(
        { id: request.id, ok: true, kind: "query-chunk", payload: { rowGroupIndex, ...buffers } },
        [buffers.quantizedPositions.buffer, buffers.colors.buffer],
      );
    };
    const result = request.kind === "query-level"
      ? await cloud.queryWorld(request.bounds, request.resolution, emitChunk)
      : await cloud.queryRowGroupsWorld(request.bounds, request.rowGroupIndices, emitChunk);
    // Preserve Row Group chunks in completion order. Flattening would copy
    // millions of object references just to recolor existing GPU buffers.
    lastPointChunks = renderedChunks;
    const payload: RenderedQuery = {
      metrics: result.metrics,
      workerElapsedMs: performance.now() - started,
    };
    respond({ id: request.id, ok: true, kind: "result", payload });
    return;
  }

  const colorChunks = [...lastPointChunks].map(([rowGroupIndex, points]) => ({
    rowGroupIndex,
    colors: buildPointBuffers(points, cloud!.metadata, request.colorMode).colors,
  }));
  const payload: RecoloredPoints = { colorChunks };
  respond(
    { id: request.id, ok: true, kind: "result", payload },
    colorChunks.map((chunk) => chunk.colors.buffer),
  );
}

function respond(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer });
}
