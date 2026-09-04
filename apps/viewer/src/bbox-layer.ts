import type { WorldBounds } from "@pointcloud-parquet/browser";
import * as THREE from "three";
import { resolutionColor } from "./point-buffer";
import type { CloudDescription } from "./worker-protocol";

type BoundsItem = { worldBounds: WorldBounds; resolution: number };

export class BoundingBoxLayers {
  readonly group = new THREE.Group();
  private readonly resolutionGroup = new THREE.Group();
  private readonly rowGroupGroup = new THREE.Group();
  private readonly rowGroups: BoundsItem[];
  private readonly origin: readonly [number, number, number];
  private selectedLines: THREE.LineSegments;

  constructor(cloud: CloudDescription, origin: readonly [number, number, number]) {
    this.rowGroups = cloud.rowGroups;
    this.origin = origin;
    const resolutions = cloud.resolutions
      .filter((level) => level.worldBounds !== null)
      .map((level) => ({ worldBounds: level.worldBounds!, resolution: level.resolution }));
    this.resolutionGroup.add(boxLines(resolutions, origin, 0.72));
    this.rowGroupGroup.add(boxLines(this.rowGroups, origin, 0.14));
    this.selectedLines = boxLines([], origin, 0.95);
    this.rowGroupGroup.add(this.selectedLines);
    this.group.add(this.resolutionGroup, this.rowGroupGroup);
    this.resolutionGroup.visible = false;
    this.rowGroupGroup.visible = true;
  }

  setResolutionVisible(visible: boolean): void {
    this.resolutionGroup.visible = visible;
  }

  setRowGroupsVisible(visible: boolean): void {
    this.rowGroupGroup.visible = visible;
  }

  setSelectedRowGroups(indices: number[]): void {
    this.rowGroupGroup.remove(this.selectedLines);
    disposeLines(this.selectedLines);
    this.selectedLines = boxLines(
      indices.map((index) => this.rowGroups[index]!).filter(Boolean),
      this.origin,
      0.95,
    );
    this.rowGroupGroup.add(this.selectedLines);
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.LineSegments) disposeLines(object);
    });
    this.group.removeFromParent();
  }
}

function boxLines(
  items: BoundsItem[],
  origin: readonly [number, number, number],
  opacity: number,
): THREE.LineSegments {
  const positions: number[] = [];
  const colors: number[] = [];
  const edges = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  for (const item of items) {
    const { min, max } = item.worldBounds;
    const corners = [
      [min[0], min[1], min[2]], [max[0], min[1], min[2]],
      [max[0], max[1], min[2]], [min[0], max[1], min[2]],
      [min[0], min[1], max[2]], [max[0], min[1], max[2]],
      [max[0], max[1], max[2]], [min[0], max[1], max[2]],
    ];
    const color = resolutionColor(item.resolution);
    for (const cornerIndex of edges) {
      const corner = corners[cornerIndex]!;
      positions.push(corner[0]! - origin[0], corner[1]! - origin[1], corner[2]! - origin[2]);
      colors.push(color[0], color[1], color[2]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.renderOrder = opacity > 0.5 ? 3 : 2;
  return lines;
}

function disposeLines(lines: THREE.LineSegments): void {
  lines.geometry.dispose();
  (lines.material as THREE.Material).dispose();
}
