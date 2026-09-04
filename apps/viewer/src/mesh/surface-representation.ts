export type SurfaceRepresentation = "normal" | "screen-mesh";

export interface SurfaceSettings {
  representation: SurfaceRepresentation;
  pointSize: number;
  meshEdgeThreshold: number;
  meshResolutionScale: number;
}
