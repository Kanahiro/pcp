import { describe, expect, it } from "vitest";
import type { ResolutionInfo, SpatialRowGroup, WorldBounds } from "@pointcloud-parquet/browser";
import { distanceToBounds, selectRowGroupsBySse } from "./sse";

const bounds: WorldBounds = { min: [0, 0, 0], max: [10, 10, 10] };
const resolutions = [
  { resolution: 0, geometricError: 8 },
  { resolution: 1, geometricError: 4 },
  { resolution: 2, geometricError: 0 },
] as ResolutionInfo[];
const rowGroups = [
  { index: 0, resolution: 0, pointCount: 10, worldBounds: bounds },
  { index: 1, resolution: 1, pointCount: 10, worldBounds: bounds },
  { index: 2, resolution: 2, pointCount: 10, worldBounds: bounds },
] as SpatialRowGroup[];

describe("distanceToBounds", () => {
  it("is zero inside and Euclidean outside an AABB", () => {
    expect(distanceToBounds([5, 5, 5], bounds)).toBe(0);
    expect(distanceToBounds([13, 14, 10], bounds)).toBe(5);
  });
});

describe("selectRowGroupsBySse", () => {
  it("keeps base coverage at distance and adds local refinements nearby", () => {
    const far = selectRowGroupsBySse(rowGroups, resolutions, bounds, [5, 5, 1000], 1000, 90, 5, 100);
    const near = selectRowGroupsBySse(rowGroups, resolutions, bounds, [5, 5, 110], 1000, 90, 5, 100);
    expect(far.rowGroupIndices).toEqual([0]);
    expect(near.rowGroupIndices).toEqual([0, 1, 2]);
  });

  it("selects nearby and distant Row Groups independently", () => {
    const shifted: WorldBounds = { min: [1000, 0, 0], max: [1010, 10, 10] };
    const groups = [
      rowGroups[0]!,
      rowGroups[1]!,
      { ...rowGroups[1]!, index: 2, worldBounds: shifted },
    ];
    const selection = selectRowGroupsBySse(
      groups,
      resolutions,
      { min: [0, 0, 0], max: [2000, 10, 10] },
      [5, 5, 110],
      1000,
      90,
      5,
      100,
    );
    expect(selection.rowGroupIndices).toEqual([0, 1]);
  });

  it("excludes Row Groups outside the camera frustum before applying SSE", () => {
    const shifted: WorldBounds = { min: [1000, 0, 0], max: [1010, 10, 10] };
    const groups = [
      rowGroups[0]!,
      rowGroups[1]!,
      { ...rowGroups[1]!, index: 2, worldBounds: shifted },
    ];
    const selection = selectRowGroupsBySse(
      groups,
      resolutions,
      { min: [0, 0, 0], max: [2000, 10, 10] },
      [5, 5, 20],
      1000,
      90,
      5,
      100,
      (groupBounds) => groupBounds !== shifted,
    );
    expect(selection.rowGroupIndices).toEqual([0, 1]);
  });

  it("keeps the highest-error refinements within the point budget", () => {
    const closerBounds: WorldBounds = { min: [0, 0, 20], max: [10, 10, 30] };
    const groups = [
      rowGroups[0]!,
      { ...rowGroups[1]!, pointCount: 60 },
      { ...rowGroups[1]!, index: 2, pointCount: 60, worldBounds: closerBounds },
    ];
    const selection = selectRowGroupsBySse(
      groups,
      resolutions,
      { min: [0, 0, 0], max: [10, 10, 30] },
      [5, 5, 40],
      1000,
      90,
      5,
      70,
    );
    expect(selection.rowGroupIndices).toEqual([0, 2]);
    expect(selection.selectedPointCount).toBe(70);
  });

  it("disables the point cap when the budget is infinite", () => {
    const selection = selectRowGroupsBySse(
      rowGroups,
      resolutions,
      bounds,
      [5, 5, 20],
      1000,
      90,
      5,
      Number.POSITIVE_INFINITY,
    );
    expect(selection.rowGroupIndices).toEqual([0, 1, 2]);
    expect(selection.selectedPointCount).toBe(30);
  });

  it("accepts a zero-pixel threshold as maximum refinement", () => {
    const selection = selectRowGroupsBySse(
      rowGroups,
      resolutions,
      bounds,
      [5, 5, 1000],
      1000,
      90,
      0,
      100,
    );
    expect(selection.rowGroupIndices).toEqual([0, 1, 2]);
  });

  it("keeps every Row Group containing the camera even beyond the point budget", () => {
    const groups = [
      rowGroups[0]!,
      { ...rowGroups[1]!, pointCount: 100 },
      { ...rowGroups[1]!, index: 2, worldBounds: { min: [20, 20, 20], max: [30, 30, 30] } },
    ] as SpatialRowGroup[];
    const selection = selectRowGroupsBySse(
      groups,
      resolutions,
      { min: [0, 0, 0], max: [30, 30, 30] },
      [5, 5, 5],
      1000,
      90,
      5,
      10,
    );
    expect(selection.rowGroupIndices).toEqual([0, 1]);
    expect(selection.selectedPointCount).toBe(110);
  });
});
