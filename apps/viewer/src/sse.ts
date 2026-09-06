import type { ResolutionInfo, SpatialRowGroup, WorldBounds } from "@pointcloud-parquet/browser";

export interface SpatialSseSelection {
  rowGroupIndices: number[];
  maxResolution: number;
  selectedByResolution: number[];
  selectedPointCount: number;
  nearestActivationPixels: number;
}

/**
 * Selects additive refinement Row Groups independently. L0 supplies the base
 * coverage. A group in Ln is activated when the error left by L(n-1), measured
 * at that group's own bbox, exceeds the pixel threshold.
 */
export function selectRowGroupsBySse(
  rowGroups: SpatialRowGroup[],
  resolutions: ResolutionInfo[],
  queryBounds: WorldBounds,
  cameraPosition: readonly [number, number, number],
  viewportHeight: number,
  verticalFovDegrees: number,
  pixelThreshold: number,
  pointBudget: number,
  intersectsView: (bounds: WorldBounds) => boolean = () => true,
): SpatialSseSelection {
  if (resolutions.length === 0) throw new RangeError("at least one resolution is required");
  if (!(viewportHeight > 0 && verticalFovDegrees > 0 && pixelThreshold >= 0 && pointBudget > 0)) {
    throw new RangeError("SSE camera parameters must be positive and the pixel threshold non-negative");
  }
  const pixelScale = viewportHeight / (2 * Math.tan(verticalFovDegrees * Math.PI / 360));
  const candidates: Array<{
    group: SpatialRowGroup;
    activationPixels: number;
    mandatory: boolean;
  }> = [];
  const selectedByResolution = Array.from({ length: resolutions.length }, () => 0);
  let nearestActivationPixels = 0;

  for (const group of rowGroups) {
    if (!boundsOverlap(group.worldBounds, queryBounds) || !intersectsView(group.worldBounds)) {
      continue;
    }
    const containsCamera = boundsContainPoint(group.worldBounds, cameraPosition);
    let activationPixels = Number.POSITIVE_INFINITY;
    if (group.resolution !== 0) {
      const parentError = resolutions[group.resolution - 1]!.geometricError;
      const distance = Math.max(distanceToBounds(cameraPosition, group.worldBounds), 1e-6);
      activationPixels = parentError * pixelScale / distance;
      nearestActivationPixels = Math.max(nearestActivationPixels, activationPixels);
      if (!containsCamera && activationPixels <= pixelThreshold) continue;
    }
    candidates.push({
      group,
      activationPixels,
      mandatory: group.resolution === 0 || containsCamera,
    });
  }

  // A fixed point budget keeps navigation responsive even when overlapping
  // Spatial Row Group AABBs can make many candidates appear close to the camera.
  candidates.sort((left, right) =>
    right.activationPixels - left.activationPixels ||
    left.group.resolution - right.group.resolution ||
    left.group.index - right.group.index);
  const selected: SpatialRowGroup[] = [];
  let selectedPointCount = 0;
  for (const candidate of candidates) {
    if (!candidate.mandatory && selectedPointCount + candidate.group.pointCount > pointBudget) continue;
    selected.push(candidate.group);
    selectedPointCount += candidate.group.pointCount;
    selectedByResolution[candidate.group.resolution]! += 1;
  }
  selected.sort((left, right) => left.index - right.index);
  const maxResolution = selected.reduce(
    (maximum, group) => Math.max(maximum, group.resolution),
    0,
  );
  return {
    rowGroupIndices: selected.map((group) => group.index),
    maxResolution,
    selectedByResolution,
    selectedPointCount,
    nearestActivationPixels,
  };
}

export function distanceToBounds(
  point: readonly [number, number, number],
  bounds: WorldBounds,
): number {
  let squared = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = point[axis]! < bounds.min[axis]!
      ? bounds.min[axis]! - point[axis]!
      : point[axis]! > bounds.max[axis]!
        ? point[axis]! - bounds.max[axis]!
        : 0;
    squared += delta * delta;
  }
  return Math.sqrt(squared);
}

function boundsOverlap(left: WorldBounds, right: WorldBounds): boolean {
  return left.max.every((maximum, axis) =>
    maximum >= right.min[axis]! && left.min[axis]! <= right.max[axis]!);
}

function boundsContainPoint(
  bounds: WorldBounds,
  point: readonly [number, number, number],
): boolean {
  return point.every((coordinate, axis) =>
    coordinate >= bounds.min[axis]! && coordinate <= bounds.max[axis]!);
}
