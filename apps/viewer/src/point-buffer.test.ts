import { describe, expect, it } from "vitest";
import type { PointCloudMetadata, QuantizedPointColumns } from "@pointcloud-parquet/browser";
import { buildPointBuffers, elevationColor, srgbToLinear } from "./point-buffer";

const metadata: PointCloudMetadata = {
  version: "0.1.0",
  scale: [0.01, 0.01, 0.01],
  offset: [100, 200, 300],
  bounds: [100, 200, 300, 110, 210, 310],
  level_row_group_ends: [1],
  voxel_edge_ratio: 2,
  crs: null,
};

describe("buildPointBuffers", () => {
  it("keeps Parquet coordinates quantized for the integer GPU attribute", () => {
    const points = columns({ x: [-123], y: [456], z: [789] });
    const result = buildPointBuffers(points, metadata, "elevation");
    expect(result.quantizedPositions).toBeInstanceOf(Int32Array);
    expect(Array.from(result.quantizedPositions)).toEqual([-123, 456, 789]);
  });

  it("uses LAS 16-bit RGB values", () => {
    const points = columns({ red: [65_535], green: [0], blue: [32_768] });
    const result = buildPointBuffers(points, metadata, "rgb");
    expect(result.colors[0]).toBeCloseTo(1);
    expect(result.colors[1]).toBe(0);
    expect(result.colors[2]).toBeCloseTo(srgbToLinear(32_768 / 65_535));
  });
});

function columns(values: {
  x?: number[];
  y?: number[];
  z?: number[];
  red?: number[];
  green?: number[];
  blue?: number[];
}): QuantizedPointColumns {
  const length = values.x?.length ?? values.red?.length ?? 1;
  return {
    resolution: 0,
    length,
    x: values.x ? new Int32Array(values.x) : new Int32Array(length),
    y: values.y ? new Int32Array(values.y) : new Int32Array(length),
    z: values.z ? new Int32Array(values.z) : new Int32Array(length),
    red: values.red ? new Uint16Array(values.red) : new Uint16Array(length),
    green: values.green ? new Uint16Array(values.green) : new Uint16Array(length),
    blue: values.blue ? new Uint16Array(values.blue) : new Uint16Array(length),
  };
}

describe("elevationColor", () => {
  it("clamps values outside the elevation range", () => {
    expect(elevationColor(-1)).toEqual(elevationColor(0));
    expect(elevationColor(2)).toEqual(elevationColor(1));
  });
});
