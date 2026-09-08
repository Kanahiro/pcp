import type { DecodedArray, ParquetScan } from "hyparquet";
import type { QuantizedBounds } from "./index.js";

export const POINT_COLUMNS = ["x", "y", "z", "red", "green", "blue"] as const;

/** Columnar point data. One resolution is shared by every point in the chunk. */
export interface QuantizedPointColumns {
  readonly resolution: number;
  readonly length: number;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly z: Int32Array;
  readonly red: Uint16Array;
  readonly green: Uint16Array;
  readonly blue: Uint16Array;
}

export async function readMatchingPointColumns(
  scan: ParquetScan,
  range: { rowStart: number; rowEnd: number },
  bounds: QuantizedBounds,
  resolution: number,
): Promise<QuantizedPointColumns> {
  const decoded = await Promise.all(POINT_COLUMNS.map((column) =>
    scan.readColumn({ ...range, column })));
  return selectPointColumns(decoded, bounds, resolution);
}

export function selectPointColumns(
  decoded: DecodedArray[],
  bounds: QuantizedBounds,
  resolution: number,
): QuantizedPointColumns {
  const [sourceX, sourceY, sourceZ, sourceRed, sourceGreen, sourceBlue] = decoded;
  if (!isCoordinateColumn(sourceX)
    || !isCoordinateColumn(sourceY)
    || !isCoordinateColumn(sourceZ)) {
    throw new TypeError("Parquet XYZ columns must decode to numeric arrays");
  }
  const length = sourceX.length;
  if (decoded.some((column) => column.length !== length)) {
    throw new Error("Parquet XYZRGB columns have different lengths");
  }

  const x = new Int32Array(length);
  const y = new Int32Array(length);
  const z = new Int32Array(length);
  const red = new Uint16Array(length);
  const green = new Uint16Array(length);
  const blue = new Uint16Array(length);
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    const pointX = sourceX[index]!;
    const pointY = sourceY[index]!;
    const pointZ = sourceZ[index]!;
    if (pointX < bounds.min[0] || pointX > bounds.max[0]
      || pointY < bounds.min[1] || pointY > bounds.max[1]
      || pointZ < bounds.min[2] || pointZ > bounds.max[2]) continue;
    x[count] = pointX;
    y[count] = pointY;
    z[count] = pointZ;
    red[count] = numericOrZero(sourceRed![index]);
    green[count] = numericOrZero(sourceGreen![index]);
    blue[count] = numericOrZero(sourceBlue![index]);
    count += 1;
  }
  return {
    resolution,
    length: count,
    x: x.subarray(0, count),
    y: y.subarray(0, count),
    z: z.subarray(0, count),
    red: red.subarray(0, count),
    green: green.subarray(0, count),
    blue: blue.subarray(0, count),
  };
}

export function concatenatePointColumns(
  parts: QuantizedPointColumns[],
  resolution: number,
): QuantizedPointColumns {
  if (parts.length === 1) return parts[0]!;
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result: QuantizedPointColumns = {
    resolution,
    length,
    x: new Int32Array(length),
    y: new Int32Array(length),
    z: new Int32Array(length),
    red: new Uint16Array(length),
    green: new Uint16Array(length),
    blue: new Uint16Array(length),
  };
  let offset = 0;
  for (const part of parts) {
    result.x.set(part.x, offset);
    result.y.set(part.y, offset);
    result.z.set(part.z, offset);
    result.red.set(part.red, offset);
    result.green.set(part.green, offset);
    result.blue.set(part.blue, offset);
    offset += part.length;
  }
  return result;
}

function numericOrZero(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number") throw new TypeError("Parquet RGB columns must contain numbers or nulls");
  return value;
}

function isCoordinateColumn(value: DecodedArray | undefined): value is Int32Array | number[] {
  return value instanceof Int32Array || Array.isArray(value);
}
