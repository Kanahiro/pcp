import type { PointCloudMetadata, QuantizedPointColumns } from "@pointcloud-parquet/browser";

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

const ELEVATION_STOPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.00, 0.05, 0.22, 0.28],
  [0.28, 0.10, 0.55, 0.47],
  [0.56, 0.45, 0.83, 0.42],
  [0.78, 0.98, 0.73, 0.24],
  [1.00, 1.00, 0.35, 0.30],
];

export function resolutionColor(resolution: number): readonly [number, number, number] {
  return RESOLUTION_COLORS[resolution % RESOLUTION_COLORS.length]!;
}

export function buildPointBuffers(
  points: QuantizedPointColumns,
  metadata: PointCloudMetadata,
  colorMode: ColorMode,
): PointBuffers {
  const quantizedPositions = new Int32Array(points.length * 3);
  const colors = new Float32Array(points.length * 3);
  const levelColor = resolutionColor(points.resolution);
  const quantizedZMin = (metadata.bounds[2] - metadata.offset[2]) / metadata.scale[2];
  const quantizedZSpan = Math.max(
    (metadata.bounds[5] - metadata.bounds[2]) / metadata.scale[2],
    Number.EPSILON,
  );

  for (let index = 0; index < points.length; index += 1) {
    const offset = index * 3;
    const z = points.z[index]!;
    quantizedPositions[offset] = points.x[index]!;
    quantizedPositions[offset + 1] = points.y[index]!;
    quantizedPositions[offset + 2] = z;

    const red = points.red[index]!;
    const green = points.green[index]!;
    const blue = points.blue[index]!;
    if (colorMode === "rgb" && (red !== 0 || green !== 0 || blue !== 0)) {
      colors[offset] = srgbToLinear(red / 65_535);
      colors[offset + 1] = srgbToLinear(green / 65_535);
      colors[offset + 2] = srgbToLinear(blue / 65_535);
    } else if (colorMode === "resolution") {
      colors[offset] = levelColor[0];
      colors[offset + 1] = levelColor[1];
      colors[offset + 2] = levelColor[2];
    } else {
      writeElevationColor(colors, offset, (z - quantizedZMin) / quantizedZSpan);
    }
  }
  return { quantizedPositions, colors };
}

export function srgbToLinear(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.04045 ? clamped / 12.92 : ((clamped + 0.055) / 1.055) ** 2.4;
}

export function elevationColor(value: number): readonly [number, number, number] {
  const t = Math.min(1, Math.max(0, value));
  const upper = ELEVATION_STOPS.findIndex((stop) => t <= stop[0]);
  if (upper <= 0) return ELEVATION_STOPS[0]!.slice(1) as [number, number, number];
  const right = ELEVATION_STOPS[upper]!;
  const left = ELEVATION_STOPS[upper - 1]!;
  const mix = (t - left[0]) / (right[0] - left[0]);
  return [
    left[1] + (right[1] - left[1]) * mix,
    left[2] + (right[2] - left[2]) * mix,
    left[3] + (right[3] - left[3]) * mix,
  ];
}

function writeElevationColor(target: Float32Array, offset: number, value: number): void {
  const t = Math.min(1, Math.max(0, value));
  let upper = 0;
  while (upper < ELEVATION_STOPS.length - 1 && t > ELEVATION_STOPS[upper]![0]) upper += 1;
  if (upper === 0) {
    target[offset] = ELEVATION_STOPS[0]![1];
    target[offset + 1] = ELEVATION_STOPS[0]![2];
    target[offset + 2] = ELEVATION_STOPS[0]![3];
    return;
  }
  const right = ELEVATION_STOPS[upper]!;
  const left = ELEVATION_STOPS[upper - 1]!;
  const mix = (t - left[0]) / (right[0] - left[0]);
  target[offset] = left[1] + (right[1] - left[1]) * mix;
  target[offset + 1] = left[2] + (right[2] - left[2]) * mix;
  target[offset + 2] = left[3] + (right[3] - left[3]) * mix;
}
