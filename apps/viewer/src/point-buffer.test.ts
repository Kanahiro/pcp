import { describe, expect, it } from "vitest";
import type { PointCloudMetadata, QuantizedPoint } from "@pointcloud-parquet/browser";
import { buildPointBuffers, elevationColor, srgbToLinear } from "./point-buffer";

const metadata: PointCloudMetadata = {
  version: "0.1.0",
  scale: [0.01, 0.01, 0.01],
  offset: [100, 200, 300],
  bounds: [100, 200, 300, 110, 210, 310],
  level_row_group_ends: [1],
  base_voxel_size: 0.01,
  hierarchy: "additive",
  spatial_order: "hilbert-3d",
};

describe("buildPointBuffers", () => {
  it("decodes quantized positions relative to the dataset origin", () => {
    const point: QuantizedPoint = { resolution: 0, x: 100, y: 200, z: 300, red: null, green: null, blue: null };
    const result = buildPointBuffers([point], metadata, [100, 200, 300], "elevation");
    expect(Array.from(result.positions)).toEqual([1, 2, 3]);
  });

  it("uses LAS 16-bit RGB values", () => {
    const point: QuantizedPoint = { resolution: 0, x: 0, y: 0, z: 0, red: 65_535, green: 0, blue: 32_768 };
    const result = buildPointBuffers([point], metadata, [100, 200, 300], "rgb");
    expect(result.colors[0]).toBeCloseTo(1);
    expect(result.colors[1]).toBe(0);
    expect(result.colors[2]).toBeCloseTo(srgbToLinear(32_768 / 65_535));
  });
});

describe("elevationColor", () => {
  it("clamps values outside the elevation range", () => {
    expect(elevationColor(-1)).toEqual(elevationColor(0));
    expect(elevationColor(2)).toEqual(elevationColor(1));
  });
});
