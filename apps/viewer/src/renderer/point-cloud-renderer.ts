import type { QuantizedBounds, WorldBounds } from "@pointcloud-parquet/browser";
import * as THREE from "three";
import { QuantizedPointMaterial } from "../point-material";
import type { CloudDescription, RenderedChunk } from "../worker-protocol";
import { AmbientOcclusion } from "./ambient-occlusion";
import type { SurfaceSettings } from "./surface-settings";

/** Owns GPU resources. It deliberately knows nothing about Parquet, queries, or LOD policy. */
export class PointCloudRenderer {
  readonly group = new THREE.Group();

  private readonly objects = new Map<number, THREE.Points>();
  private readonly material: QuantizedPointMaterial;
  private readonly ambientOcclusion = new AmbientOcclusion();
  private settings: SurfaceSettings;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly cloud: CloudDescription,
    private readonly origin: readonly [number, number, number],
    settings: SurfaceSettings,
    private readonly invalidate: () => void,
  ) {
    this.settings = settings;
    this.material = new QuantizedPointMaterial(
      cloud.metadata,
      origin,
      unionQuantizedBounds(cloud),
      settings.pointSize,
    );
    this.resize();
  }

  replace(chunk: RenderedChunk, queryBounds: WorldBounds): boolean {
    this.remove(chunk.rowGroupIndex);
    if (chunk.quantizedPositions.length === 0) {
      this.invalidate();
      return false;
    }
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(chunk.quantizedPositions, 3);
    position.gpuType = THREE.IntType;
    geometry.setAttribute("position", position);
    geometry.setAttribute("color", new THREE.BufferAttribute(chunk.colors, 3));
    this.setBounds(geometry, chunk.rowGroupIndex, queryBounds);
    const object = new THREE.Points(geometry, this.material);
    this.objects.set(chunk.rowGroupIndex, object);
    this.group.add(object);
    this.invalidate();
    return true;
  }

  retain(indices: ReadonlySet<number>): void {
    for (const index of this.objects.keys()) {
      if (!indices.has(index)) this.remove(index);
    }
    this.invalidate();
  }

  recolor(chunks: Array<{ rowGroupIndex: number; colors: Float32Array }>): void {
    for (const { rowGroupIndex, colors } of chunks) {
      this.objects.get(rowGroupIndex)?.geometry.setAttribute(
        "color",
        new THREE.BufferAttribute(colors, 3),
      );
    }
    this.invalidate();
  }

  update(settings: SurfaceSettings): void {
    this.settings = settings;
    this.material.pointSize = settings.pointSize;
    this.invalidate();
  }

  resize(): void {
    this.material.viewportScale = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y / 2;
    this.ambientOcclusion.resize(this.renderer);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    if (this.settings.representation === "normal") {
      this.renderer.render(scene, camera);
      return;
    }
    this.ambientOcclusion.render(
      this.renderer,
      scene,
      camera,
      this.group,
      this.settings.pointSize * this.settings.aoRadius,
      this.settings.aoStrength,
      this.settings.pointSize,
    );
  }

  indices(): number[] {
    return [...this.objects.keys()];
  }

  pointCount(): number {
    let count = 0;
    for (const object of this.objects.values()) {
      count += object.geometry.getAttribute("position").count;
    }
    return count;
  }

  boundingBox(): THREE.Box3 {
    const bounds = new THREE.Box3();
    for (const object of this.objects.values()) {
      if (object.geometry.boundingBox) bounds.union(object.geometry.boundingBox);
    }
    return bounds;
  }

  dispose(): void {
    for (const index of [...this.objects.keys()]) this.remove(index);
    this.material.dispose();
    this.ambientOcclusion.dispose();
    this.group.removeFromParent();
    this.invalidate();
  }

  private remove(index: number): void {
    const object = this.objects.get(index);
    if (!object) return;
    this.group.remove(object);
    object.geometry.dispose();
    this.objects.delete(index);
  }

  private setBounds(
    geometry: THREE.BufferGeometry,
    rowGroupIndex: number,
    queryBounds: WorldBounds,
  ): void {
    const bounds = this.cloud.rowGroups[rowGroupIndex]!.worldBounds;
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(
        Math.max(bounds.min[0], queryBounds.min[0]) - this.origin[0],
        Math.max(bounds.min[1], queryBounds.min[1]) - this.origin[1],
        Math.max(bounds.min[2], queryBounds.min[2]) - this.origin[2],
      ),
      new THREE.Vector3(
        Math.min(bounds.max[0], queryBounds.max[0]) - this.origin[0],
        Math.min(bounds.max[1], queryBounds.max[1]) - this.origin[1],
        Math.min(bounds.max[2], queryBounds.max[2]) - this.origin[2],
      ),
    );
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  }
}

function unionQuantizedBounds(cloud: CloudDescription): QuantizedBounds {
  const first = cloud.rowGroups[0];
  if (!first) throw new Error("point cloud has no Row Groups");
  return cloud.rowGroups.slice(1).reduce<QuantizedBounds>((union, group) => ({
    min: union.min.map((value, axis) =>
      Math.min(value, group.quantizedBounds.min[axis]!),
    ) as [number, number, number],
    max: union.max.map((value, axis) =>
      Math.max(value, group.quantizedBounds.max[axis]!),
    ) as [number, number, number],
  }), {
    min: [...first.quantizedBounds.min],
    max: [...first.quantizedBounds.max],
  });
}
