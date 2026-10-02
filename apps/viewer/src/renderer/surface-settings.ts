export type SurfaceRepresentation = "normal" | "ambient-occlusion";

export interface SurfaceSettings {
  representation: SurfaceRepresentation;
  pointSize: number;
  aoRadius: number;
  aoStrength: number;
}
