import type { PointCloudMetadata, QuantizedPoint } from "@pointcloud-parquet/browser";

export type ColorMode = "rgb" | "elevation" | "resolution";

export interface PointBuffers {
  quantizedPositions: Int32Array;
  colors: Float32Array;
}

const RESOLUTION_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [0.18, 0.95, 0.70],
  [0.29, 0.67, 1.0],
  [0.69, 0.43, 1.0],
  [1.0, 0.46, 0.62],
  [1.0, 0.76, 0.30],
  [0.83, 0.92, 0.42],
  [0.25, 0.90, 0.95],
  [0.95, 0.25, 0.22],
];

export function resolutionColor(resolution: number): readonly [number, number, number] {
  return RESOLUTION_COLORS[resolution % RESOLUTION_COLORS.length]!;
}

export function buildPointBuffers(
  points: QuantizedPoint[],
  metadata: PointCloudMetadata,
  colorMode: ColorMode,
): PointBuffers {
  const quantizedPositions = new Int32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const quantizedZMin = (metadata.bounds[2] - metadata.offset[2]) / metadata.scale[2];
  const quantizedZSpan = Math.max(
    (metadata.bounds[5] - metadata.bounds[2]) / metadata.scale[2],
    Number.EPSILON,
  );

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const offset = index * 3;
    quantizedPositions[offset] = point.x;
    quantizedPositions[offset + 1] = point.y;
    quantizedPositions[offset + 2] = point.z;

    const normalizedHeight = (point.z - quantizedZMin) / quantizedZSpan;
    const color = colorForPoint(point, colorMode, normalizedHeight);
    colors[offset] = color[0];
    colors[offset + 1] = color[1];
    colors[offset + 2] = color[2];
  }
  return { quantizedPositions, colors };
}

function colorForPoint(
  point: QuantizedPoint,
  mode: ColorMode,
  normalizedHeight: number,
): readonly [number, number, number] {
  if (mode === "rgb" && point.red !== null && point.green !== null && point.blue !== null) {
    if (point.red !== 0 || point.green !== 0 || point.blue !== 0) {
      return [srgbToLinear(point.red / 65_535), srgbToLinear(point.green / 65_535), srgbToLinear(point.blue / 65_535)];
    }
  }
  if (mode === "resolution") {
    return resolutionColor(point.resolution);
  }
  return elevationColor(normalizedHeight);
}

export function srgbToLinear(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.04045 ? clamped / 12.92 : ((clamped + 0.055) / 1.055) ** 2.4;
}

export function elevationColor(value: number): readonly [number, number, number] {
  const t = Math.min(1, Math.max(0, value));
  const stops: ReadonlyArray<readonly [number, number, number, number]> = [
    [0.00, 0.05, 0.22, 0.28],
    [0.28, 0.10, 0.55, 0.47],
    [0.56, 0.45, 0.83, 0.42],
    [0.78, 0.98, 0.73, 0.24],
    [1.00, 1.00, 0.35, 0.30],
  ];
  const upper = stops.findIndex((stop) => t <= stop[0]);
  if (upper <= 0) return stops[0]!.slice(1) as [number, number, number];
  const right = stops[upper]!;
  const left = stops[upper - 1]!;
  const mix = (t - left[0]) / (right[0] - left[0]);
  return [
    left[1] + (right[1] - left[1]) * mix,
    left[2] + (right[2] - left[2]) * mix,
    left[3] + (right[3] - left[3]) * mix,
  ];
}
