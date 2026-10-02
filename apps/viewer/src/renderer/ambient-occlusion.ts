import * as THREE from "three";

const VERTEX_SHADER = `
precision highp float;
in vec3 position;
out vec2 uv;
void main() {
  uv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;
uniform sampler2D pointColor;
uniform sampler2D pointDepth;
uniform mat4 projection;
uniform mat4 projectionInverse;
uniform vec2 texelSize;
uniform float radius;
uniform float strength;
uniform float pointSize;
uniform vec3 backgroundColor;
in vec2 uv;
out vec4 outputColor;

vec3 viewPosition(vec2 coord, float depth) {
  vec4 position = projectionInverse * vec4(coord * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  return position.xyz / position.w;
}

void main() {
  vec3 color = texture(pointColor, uv).rgb;
  float depth = texture(pointDepth, uv).r;
  if (depth >= 0.999999) {
    outputColor = vec4(backgroundColor, 1.0);
    return;
  }

  vec3 center = viewPosition(uv, depth);
  float worldPerPixel = -center.z * texelSize.y * 2.0 / projection[1][1];
  // Keep a minimum screen footprint so distant points still have enough
  // neighbors to estimate occlusion at the current zoom level.
  float effectiveRadius = max(radius, worldPerPixel * 8.0);
  float pixelRadius = clamp(effectiveRadius / worldPerPixel, 8.0, 40.0);
  // Pick the nearer neighbor on each axis so silhouettes do not create a
  // spurious surface normal across a depth discontinuity. Sample beyond
  // the current point sprite; its flat depth is not a surface normal.
  float normalStep = clamp(pointSize / (projection[1][1] * worldPerPixel), 2.0, 48.0);
  vec2 dx = vec2(texelSize.x * normalStep, 0.0);
  vec2 dy = vec2(0.0, texelSize.y * normalStep);
  float depthLeft = texture(pointDepth, uv - dx).r;
  float depthRight = texture(pointDepth, uv + dx).r;
  float depthDown = texture(pointDepth, uv - dy).r;
  float depthUp = texture(pointDepth, uv + dy).r;
  vec3 x = abs(depthLeft - depth) < abs(depthRight - depth)
    ? center - viewPosition(uv - dx, depthLeft)
    : viewPosition(uv + dx, depthRight) - center;
  vec3 y = abs(depthDown - depth) < abs(depthUp - depth)
    ? center - viewPosition(uv - dy, depthDown)
    : viewPosition(uv + dy, depthUp) - center;
  vec3 crossProduct = cross(x, y);
  vec3 normal = length(x) > effectiveRadius || length(y) > effectiveRadius || length(crossProduct) < 0.000001
    ? vec3(0.0, 0.0, 1.0)
    : normalize(crossProduct);
  if (normal.z < 0.0) normal = -normal;

  float angle = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831853;
  float occlusion = 0.0;
  for (int directionIndex = 0; directionIndex < 8; directionIndex++) {
    float directionAngle = angle + float(directionIndex) * 0.78539816;
    vec2 direction = vec2(cos(directionAngle), sin(directionAngle));
    float horizon = 0.0;
    for (int stepIndex = 1; stepIndex <= 4; stepIndex++) {
      vec2 sampleUv = uv + direction * texelSize * pixelRadius * float(stepIndex) / 4.0;
      if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) continue;
      float sampleDepth = texture(pointDepth, sampleUv).r;
      if (sampleDepth >= 0.999999) continue;
      vec3 offset = viewPosition(sampleUv, sampleDepth) - center;
      float distance = length(offset);
      if (distance < worldPerPixel * 0.5 || distance > effectiveRadius) continue;
      float elevation = max(dot(normal, offset) / distance - 0.08, 0.0);
      float falloff = 1.0 - smoothstep(effectiveRadius * 0.5, effectiveRadius, distance);
      horizon = max(horizon, elevation * falloff);
    }
    occlusion += horizon;
  }
  float shade = 1.0 - min(0.8, strength * occlusion / 8.0);
  outputColor = vec4(color * shade, 1.0);
}
`;

/** Applies depth-based ambient occlusion only to the point cloud. */
export class AmbientOcclusion {
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material: THREE.RawShaderMaterial;

  constructor() {
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        pointColor: { value: this.target.texture },
        pointDepth: { value: this.target.depthTexture },
        projection: { value: new THREE.Matrix4() },
        projectionInverse: { value: new THREE.Matrix4() },
        texelSize: { value: new THREE.Vector2(1, 1) },
        radius: { value: 1 },
        strength: { value: 1 },
        pointSize: { value: 1 },
        backgroundColor: { value: new THREE.Color() },
      },
    });
    this.scene.add(new THREE.Mesh(this.geometry, this.material));
  }

  resize(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.target.width === size.x && this.target.height === size.y) return;
    this.target.setSize(size.x, size.y);
    this.material.uniforms.texelSize!.value.set(1 / size.x, 1 / size.y);
  }

  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    pointGroup: THREE.Group,
    radius: number,
    strength: number,
    pointSize: number,
  ): void {
    this.resize(renderer);
    const originalTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const visibility = scene.children.map((child) => child.visible);
    const background = scene.background;
    try {
      this.material.uniforms.backgroundColor!.value
        .copy(background instanceof THREE.Color ? background : clearColor)
        .convertLinearToSRGB();
      scene.children.forEach((child, index) => {
        child.visible = visibility[index]! && child === pointGroup;
      });
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0x111315, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);

      this.material.uniforms.projection!.value.copy(camera.projectionMatrix);
      this.material.uniforms.projectionInverse!.value.copy(camera.projectionMatrixInverse);
      this.material.uniforms.radius!.value = radius;
      this.material.uniforms.strength!.value = strength;
      this.material.uniforms.pointSize!.value = pointSize;
      renderer.setRenderTarget(originalTarget);
      renderer.autoClear = true;
      renderer.render(this.scene, this.camera);

      scene.children.forEach((child, index) => {
        child.visible = visibility[index]! && child !== pointGroup;
      });
      scene.background = null;
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(scene, camera);
    } finally {
      scene.children.forEach((child, index) => { child.visible = visibility[index]!; });
      scene.background = background;
      renderer.autoClear = autoClear;
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.setRenderTarget(originalTarget);
    }
  }

  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
