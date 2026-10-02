import type { PointCloudMetadata, QuantizedBounds } from "@pointcloud-parquet/browser";
import * as THREE from "three";

const VERTEX_SHADER = `
precision highp float;
precision highp int;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform ivec3 quantizedOrigin;
uniform vec3 coordinateScale;
uniform vec3 offsetFromOrigin;
uniform float pointSize;
uniform float viewportScale;

in ivec3 position;
in vec3 color;
out vec3 vertexColor;
out float fogDepth;

void main() {
  // Subtract while values are still integers. Converting absolute LAS INT32
  // coordinates to float first would discard low bits before applying scale.
  vec3 decodedPosition = vec3(position - quantizedOrigin) * coordinateScale + offsetFromOrigin;
  vec4 viewPosition = modelViewMatrix * vec4(decodedPosition, 1.0);
  gl_Position = projectionMatrix * viewPosition;
  gl_PointSize = pointSize * viewportScale / max(-viewPosition.z, 0.0001);
  vertexColor = color;
  fogDepth = -viewPosition.z;
}
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform vec3 fogColor;
uniform float fogDensity;

in vec3 vertexColor;
in float fogDepth;
out vec4 outputColor;

vec3 linearToSrgb(vec3 value) {
  bvec3 linearSegment = lessThanEqual(value, vec3(0.0031308));
  vec3 lower = value * 12.92;
  vec3 upper = 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055;
  return mix(upper, lower, linearSegment);
}

void main() {
  float fogFactor = 1.0 - exp(-fogDensity * fogDensity * fogDepth * fogDepth);
  vec3 color = mix(vertexColor, fogColor, fogFactor);
  outputColor = vec4(linearToSrgb(color), 1.0);
}
`;

export class QuantizedPointMaterial extends THREE.RawShaderMaterial {
  constructor(
    metadata: PointCloudMetadata,
    worldOrigin: readonly [number, number, number],
    quantizedBounds: QuantizedBounds,
    pointSize: number,
  ) {
    const quantizedOrigin = quantizedBounds.min.map((minimum, axis) =>
      Math.trunc(minimum + (quantizedBounds.max[axis]! - minimum) / 2),
    ) as [number, number, number];
    const offsetFromOrigin = quantizedOrigin.map((value, axis) =>
      value * metadata.scale[axis]! + metadata.offset[axis]! - worldOrigin[axis]!,
    );
    super({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: {
        quantizedOrigin: { value: new Int32Array(quantizedOrigin) },
        coordinateScale: { value: new THREE.Vector3(...metadata.scale) },
        offsetFromOrigin: { value: new THREE.Vector3(...offsetFromOrigin) },
        pointSize: { value: pointSize },
        viewportScale: { value: 1 },
        fogColor: { value: new THREE.Color(0x111315) },
        fogDensity: { value: 0.00032 },
      },
    });
  }

  set pointSize(value: number) {
    this.uniforms.pointSize!.value = value;
  }

  set viewportScale(value: number) {
    this.uniforms.viewportScale!.value = value;
  }
}
