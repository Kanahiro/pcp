import * as THREE from "three";

const VERTEX_SHADER = `
precision highp float;
precision highp int;

uniform sampler2D pointDepth;
uniform sampler2D pointColor;
uniform mat4 sourceProjectionInverse;
uniform ivec2 gridSize;

in vec3 position;
out vec3 viewPosition;
out vec3 vertexColor;
out float validPoint;

void main() {
  int cellsX = gridSize.x - 1;
  int cellX = gl_InstanceID % cellsX;
  int cellY = gl_InstanceID / cellsX;
  vec2 pixel = vec2(cellX, cellY) + position.xy;
  vec2 uv = (pixel + 0.5) / vec2(gridSize);
  float depth = texture(pointDepth, uv).r;
  vec4 view = sourceProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  viewPosition = view.xyz / max(view.w, 0.000001);
  vertexColor = texture(pointColor, uv).rgb;
  validPoint = step(depth, 0.999999);
  gl_Position = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision highp float;

uniform float maximumEdgeLength;
uniform vec3 fogColor;
uniform float fogDensity;

in vec3 viewPosition;
in vec3 vertexColor;
in float validPoint;
out vec4 outputColor;

vec3 linearToSrgb(vec3 value) {
  bvec3 linearSegment = lessThanEqual(value, vec3(0.0031308));
  vec3 lower = value * 12.92;
  vec3 upper = 1.055 * pow(value, vec3(1.0 / 2.4)) - 0.055;
  return mix(upper, lower, linearSegment);
}

void main() {
  if (validPoint < 0.999) discard;
  vec3 dx = dFdx(viewPosition);
  vec3 dy = dFdy(viewPosition);
  if (max(length(dx), length(dy)) > maximumEdgeLength) discard;
  vec3 normal = normalize(cross(dx, dy));
  if (normal.z < 0.0) normal = -normal;
  float diffuse = 0.66 + 0.34 * max(dot(normal, normalize(vec3(-0.35, 0.45, 0.82))), 0.0);
  float fogDepth = -viewPosition.z;
  float fogFactor = 1.0 - exp(-fogDensity * fogDensity * fogDepth * fogDepth);
  vec3 color = mix(vertexColor * diffuse, fogColor, fogFactor);
  outputColor = vec4(linearToSrgb(color), 1.0);
}
`;

/** Turns a point depth buffer into a connected view-dependent triangle grid. */
export class ScreenSpaceMesh {
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.RawShaderMaterial;
  private readonly mesh: THREE.Mesh;
  private gridWidth = 1;
  private gridHeight = 1;

  constructor() {
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.target.texture.colorSpace = THREE.NoColorSpace;
    this.geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 1, 0, 1, 0, 0, 1, 1, 0,
    ], 3));
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        pointDepth: { value: this.target.depthTexture },
        pointColor: { value: this.target.texture },
        sourceProjectionInverse: { value: new THREE.Matrix4() },
        gridSize: { value: new THREE.Vector2(1, 1) },
        maximumEdgeLength: { value: 1 },
        fogColor: { value: new THREE.Color(0x111315) },
        fogDensity: { value: 0.00032 },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  resize(renderer: THREE.WebGLRenderer, resolutionScale: number): void {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const width = Math.max(2, Math.floor(size.x * resolutionScale));
    const height = Math.max(2, Math.floor(size.y * resolutionScale));
    if (width === this.gridWidth && height === this.gridHeight) return;
    this.gridWidth = width;
    this.gridHeight = height;
    this.target.setSize(width, height);
    this.geometry.instanceCount = (width - 1) * (height - 1);
    this.material.uniforms.gridSize!.value.set(width, height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    sourceScene: THREE.Scene,
    sourceCamera: THREE.PerspectiveCamera,
    pointGroup: THREE.Group,
    maximumEdgeLength: number,
    resolutionScale: number,
  ): void {
    this.resize(renderer, resolutionScale);
    const background = sourceScene.background;
    const groupVisible = pointGroup.visible;
    const autoClear = renderer.autoClear;
    const visibility = sourceScene.children.map((child) => child.visible);

    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x111315, 1);
    renderer.clear(true, true, true);
    sourceScene.children.forEach((child, index) => {
      child.visible = visibility[index]! && child === pointGroup;
    });
    renderer.render(sourceScene, sourceCamera);

    this.material.uniforms.sourceProjectionInverse!.value.copy(sourceCamera.projectionMatrixInverse);
    this.material.uniforms.maximumEdgeLength!.value = maximumEdgeLength;
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    renderer.render(this.scene, this.camera);

    sourceScene.children.forEach((child, index) => {
      child.visible = visibility[index]! && child !== pointGroup;
    });
    sourceScene.background = null;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(sourceScene, sourceCamera);

    sourceScene.children.forEach((child, index) => {
      child.visible = visibility[index]!;
    });
    pointGroup.visible = groupVisible;
    sourceScene.background = background;
    renderer.autoClear = autoClear;
  }

  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
