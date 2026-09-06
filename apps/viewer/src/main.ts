import type { QueryMetrics, WorldBounds } from "@pointcloud-parquet/browser";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import "./style.css";
import { BoundingBoxLayers } from "./bbox-layer";
import type { SurfaceRepresentation, SurfaceSettings } from "./mesh/surface-representation";
import type { ColorMode } from "./point-buffer";
import { ParquetPointCloudReader } from "./reader/point-cloud-reader";
import { PointCloudRenderer } from "./renderer/point-cloud-renderer";
import { selectRowGroupsBySse, type SpatialSseSelection } from "./sse";
import type { CloudDescription, RenderedChunk } from "./worker-protocol";

const DEFAULT_URL = "https://cogp-demo.spatialty.io/temp/114112.parquet";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main class="shell">
    <section class="viewport" aria-label="3D point cloud viewport">
      <canvas id="scene"></canvas>
      <div class="viewport-topline">
        <strong>PCP</strong><span>Point Cloud Parquet demo</span>
      </div>
      <div class="sse-hud" id="sse-hud"><span>Auto SSE</span><strong>L0</strong><small>— px</small></div>
      <div class="view-hint">Drag to orbit · Scroll to zoom · Right-drag to pan</div>
      <button class="fit-button" id="fit-view" title="Fit point cloud in view">Fit view</button>
      <div class="empty-state" id="empty-state">
        <p>Opening Parquet metadata…</p>
      </div>
    </section>

    <aside class="panel">
      <header class="panel-header">
        <h1>PCP</h1>
        <p class="product-name">Point Cloud Parquet</p>
        <p class="lede">Browser streaming and spatial LOD demo</p>
      </header>

      <form id="controls">
        <section class="control-section source-section">
          <label for="url">Parquet source</label>
          <div class="url-row">
            <input id="url" type="url" value="${DEFAULT_URL}" spellcheck="false" />
            <button id="open" type="submit">Open</button>
          </div>
          <div class="status-row"><span class="status-dot" id="status-dot"></span><span id="status">Connecting…</span></div>
        </section>

        <section class="control-section">
          <div class="section-heading"><span>Rendering</span><small id="level-caption">L0</small></div>
          <fieldset>
            <legend>Surface</legend>
            <div class="segmented two-up" id="surface-mode">
              <label><input type="radio" name="surface" value="normal" checked><span>Normal</span></label>
              <label><input type="radio" name="surface" value="screen-mesh"><span>Screen mesh</span></label>
            </div>
          </fieldset>
          <div class="mesh-controls" id="mesh-controls" hidden>
            <label for="mesh-edge">Maximum mesh edge</label>
            <div class="range-row">
              <input id="mesh-edge" type="range" min="1" max="12" value="4" step="0.5" />
              <output id="mesh-edge-value">4×</output>
            </div>
          </div>
          <label class="switch-row" for="auto-lod"><span><b>Automatic LOD</b><small>Per-Row Group geometric error</small></span><input id="auto-lod" type="checkbox" checked><i></i></label>
          <label for="sse-threshold">SSE threshold</label>
          <div class="range-row">
            <input id="sse-threshold" type="range" min="0" max="32" value="8" step="0.5" />
            <output id="sse-threshold-value">8 px</output>
          </div>
          <div class="lod-distribution" id="lod-distribution">Awaiting Row Group selection</div>
          <label for="point-budget">Point budget</label>
          <div class="range-row">
            <input id="point-budget" type="range" min="100000" max="2050000" value="2050000" step="50000" aria-valuetext="Unlimited" />
            <output id="point-budget-value">∞</output>
          </div>
          <label for="resolution">Maximum resolution</label>
          <div class="range-row">
            <input id="resolution" type="range" min="0" max="4" value="0" step="1" disabled />
            <output id="resolution-value">0</output>
          </div>
          <label for="point-size">Point size</label>
          <div class="range-row">
            <input id="point-size" type="range" min="0.5" max="5" value="1.5" step="0.1" />
            <output id="point-size-value">1.5</output>
          </div>
          <fieldset>
            <legend>Color</legend>
            <div class="segmented" id="color-mode">
              <label><input type="radio" name="color" value="rgb" checked><span>RGB</span></label>
              <label><input type="radio" name="color" value="elevation"><span>Elevation</span></label>
              <label><input type="radio" name="color" value="resolution"><span>LOD</span></label>
            </div>
          </fieldset>
          <fieldset class="bbox-fieldset">
            <legend>Spatial bounds</legend>
            <div class="segmented two-up" id="bbox-mode">
              <label><input id="show-page-bounds" type="checkbox"><span>Page bbox</span></label>
              <label><input id="show-row-group-bounds" type="checkbox"><span>Row Group bbox</span></label>
            </div>
            <small class="bbox-legend">Bright: loaded · Faint: available</small>
          </fieldset>
        </section>

        <section class="control-section bounds-section">
          <div class="section-heading"><span>World bounds</span><button type="button" id="reset-bounds">Full extent</button></div>
          <div class="bounds-head"><span></span><span>Min</span><span>Max</span></div>
          ${axisInputs("X", "x")}${axisInputs("Y", "y")}${axisInputs("Z", "z")}
          <button class="query-button" id="query" type="button" disabled>Query and render</button>
        </section>
      </form>

      <section class="metrics" aria-live="polite">
        <div class="section-heading"><span>Query telemetry</span><small id="query-time">—</small></div>
        <div class="metric-grid">
          ${metric("points", "Points drawn")}
          ${metric("bytes", "Transferred")}
          ${metric("requests", "Range requests")}
          ${metric("row-groups", "Row Groups read")}
          ${metric("pruned", "Row Groups pruned")}
          ${metric("candidates", "Candidate points")}
        </div>
      </section>

      <footer id="dataset-meta">Awaiting dataset metadata</footer>
    </aside>
  </main>
`;

function axisInputs(label: string, key: string): string {
  return `<div class="axis-row"><b>${label}</b><input id="${key}-min" type="number" step="any"><input id="${key}-max" type="number" step="any"></div>`;
}

function metric(id: string, label: string): string {
  return `<div class="metric"><strong id="metric-${id}">—</strong><span>${label}</span></div>`;
}

const canvas = element<HTMLCanvasElement>("scene");
const viewport = canvas.parentElement!;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111315);
scene.fog = new THREE.FogExp2(0x111315, 0.00032);
const camera = new THREE.PerspectiveCamera(43, 1, 0.01, 1_000_000);
camera.up.set(0, 0, 1);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
const controls = new OrbitControls(camera, viewport);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.addEventListener("start", () => viewport.classList.add("is-dragging"));
let renderDirty = true;

const pointCloudReader = new ParquetPointCloudReader();
let cloud: CloudDescription | null = null;
let pointCloudRenderer: PointCloudRenderer | null = null;
let boundingBoxes: BoundingBoxLayers | null = null;
let loadingPageBounds: BoundingBoxLayers | null = null;
let origin: [number, number, number] = [0, 0, 0];
let fullBounds: WorldBounds | null = null;
let isBusy = false;
let loadedSelectionKey = "";
let autoLodTimer: ReturnType<typeof setTimeout> | undefined;
let autoLodPending = false;
let autoLodImmediate = false;
let lastAutoLodAt = Number.NEGATIVE_INFINITY;

const AUTO_LOD_INTERVAL_MS = 250;

controls.addEventListener("change", () => {
  requestRender();
  scheduleAutomaticLod();
});

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(viewport);
renderer.setAnimationLoop(() => {
  const cameraChanged = controls.update();
  if (renderDirty || cameraChanged) {
    if (pointCloudRenderer) pointCloudRenderer.render(scene, camera);
    else renderer.render(scene, camera);
    renderDirty = false;
  }
});

element<HTMLFormElement>("controls").addEventListener("submit", (event) => {
  event.preventDefault();
  void openDataset();
});
element<HTMLButtonElement>("query").addEventListener("click", () => {
  if (element<HTMLInputElement>("auto-lod").checked) {
    loadedSelectionKey = "";
    void applyAutomaticLod(true);
  } else {
    void queryAndRender({ fit: true });
  }
});
element<HTMLInputElement>("resolution").addEventListener("input", () => {
  updateResolutionLabel();
  if (!element<HTMLInputElement>("auto-lod").checked) {
    updateSseHud(Number(element<HTMLInputElement>("resolution").value), undefined);
  }
});
element<HTMLInputElement>("auto-lod").addEventListener("change", updateAutoLod);
element<HTMLInputElement>("sse-threshold").addEventListener("input", () => {
  updateSseThreshold();
  scheduleAutomaticLod();
});
element<HTMLInputElement>("point-budget").addEventListener("input", () => {
  updatePointBudget();
  scheduleAutomaticLod();
});
element<HTMLInputElement>("point-size").addEventListener("input", updatePointSize);
element<HTMLDivElement>("surface-mode").addEventListener("change", updateSurfaceMode);
element<HTMLInputElement>("mesh-edge").addEventListener("input", updateSurfaceMode);
element<HTMLDivElement>("color-mode").addEventListener("change", recolor);
element<HTMLInputElement>("show-page-bounds").addEventListener("change", () => {
  void updateBoundingBoxes();
});
element<HTMLInputElement>("show-row-group-bounds").addEventListener("change", updateBoundingBoxes);
element<HTMLButtonElement>("reset-bounds").addEventListener("click", () => {
  if (fullBounds) setBoundsInputs(fullBounds);
});
const fitButton = element<HTMLButtonElement>("fit-view");
fitButton.addEventListener("pointerdown", (event) => event.stopPropagation());
fitButton.addEventListener("click", fitView);
controls.addEventListener("end", () => {
  viewport.classList.remove("is-dragging");
  scheduleAutomaticLod(true);
});

void openDataset();

async function openDataset(): Promise<void> {
  if (isBusy) return;
  setBusy(true, "Opening Parquet metadata…");
  try {
    const url = element<HTMLInputElement>("url").value.trim();
    cloud = await pointCloudReader.open(url);
    const bounds = cloud.metadata.bounds;
    fullBounds = { min: [bounds[0], bounds[1], bounds[2]], max: [bounds[3], bounds[4], bounds[5]] };
    origin = [
      (bounds[0] + bounds[3]) / 2,
      (bounds[1] + bounds[4]) / 2,
      (bounds[2] + bounds[5]) / 2,
    ];
    boundingBoxes?.dispose();
    pointCloudRenderer?.dispose();
    boundingBoxes = new BoundingBoxLayers(cloud, origin);
    scene.add(boundingBoxes.group);
    pointCloudRenderer = new PointCloudRenderer(
      renderer,
      cloud,
      origin,
      surfaceSettings(),
      requestRender,
    );
    scene.add(pointCloudRenderer.group);
    updateBoundingBoxes();
    setBoundsInputs(fullBounds);
    const resolution = element<HTMLInputElement>("resolution");
    resolution.max = String(cloud.resolutions.length - 1);
    resolution.value = "0";
    loadedSelectionKey = "";
    updateAutoLod();
    element<HTMLButtonElement>("query").disabled = false;
    updateResolutionLabel();
    updateDatasetMeta();
    await queryAndRender({ nested: true, fit: true, resolution: 0, selectionKey: "level:0" });
    scheduleAutomaticLod();
  } catch (error) {
    setFailure(error);
  } finally {
    setBusy(false);
  }
}

async function queryAndRender(options: {
  nested?: boolean;
  fit?: boolean;
  resolution?: number;
  rowGroupIndices?: number[];
  selectionKey?: string;
} = {}): Promise<void> {
  const { nested = false, fit = false } = options;
  if (!cloud || (isBusy && !nested)) return;
  if (!nested) setBusy(true, "Fetching selected Row Groups…");
  else setStatus("Fetching L0 points…", "loading");
  try {
    const resolution = options.resolution ?? Number(element<HTMLInputElement>("resolution").value);
    const bounds = readBoundsInputs();
    const selectedGroups = options.rowGroupIndices
      ?? Array.from({ length: cloud.metadata.level_row_group_ends[resolution]! }, (_, index) => index);
    const loadedGroupIndices: number[] = [];
    const visibleGroupIndices: number[] = [];
    boundingBoxes?.setLoadedRowGroups(pointCloudRenderer?.indices() ?? [], bounds);
    const retainedPointCount = renderedPointCount();
    if (retainedPointCount > 0) {
      setStatus(`${formatInteger(retainedPointCount)} points visible · fetching refinement…`, "loading");
    }
    let loadedGroups = 0;
    const onChunk = (chunk: RenderedChunk) => {
      loadedGroups += 1;
      loadedGroupIndices.push(chunk.rowGroupIndex);
      if (replaceRenderedChunk(chunk, bounds)) {
        visibleGroupIndices.push(chunk.rowGroupIndex);
      }
      boundingBoxes?.setLoadedRowGroups(pointCloudRenderer!.indices(), bounds);
      setStatus(
        `${formatInteger(renderedPointCount())} points visible · ${loadedGroups}/${selectedGroups.length} Row Groups`,
        "loading",
      );
      element<HTMLDivElement>("empty-state").classList.add("hidden");
    };
    const result = options.rowGroupIndices
      ? await pointCloudReader.readRowGroups(
          bounds,
          options.rowGroupIndices,
          selectedColorMode(),
          onChunk,
        )
      : await pointCloudReader.readLevel(bounds, resolution, selectedColorMode(), onChunk);
    loadedSelectionKey = options.selectionKey ?? `level:${resolution}:${boundsKey(bounds)}`;
    retainRenderedGroups(new Set(visibleGroupIndices));
    boundingBoxes?.setLoadedRowGroups(loadedGroupIndices, bounds);
    updateMetrics(result.metrics, result.workerElapsedMs);
    setStatus(`${formatInteger(result.metrics.pointsMatched)} points ready`, "ready");
    element<HTMLDivElement>("empty-state").classList.add("hidden");
    if (fit) fitView();
  } catch (error) {
    setFailure(error);
  } finally {
    if (!nested) {
      setBusy(false);
      if (autoLodPending) scheduleAutomaticLod(autoLodImmediate);
    }
  }
}

function replaceRenderedChunk(
  chunk: RenderedChunk,
  queryBounds: WorldBounds,
): boolean {
  if (!pointCloudRenderer) return false;
  return pointCloudRenderer.replace(chunk, queryBounds);
}

function retainRenderedGroups(indices: Set<number>): void {
  pointCloudRenderer?.retain(indices);
}

function renderedPointCount(): number {
  return pointCloudRenderer?.pointCount() ?? 0;
}

function fitView(): void {
  const renderedBounds = pointCloudRenderer?.boundingBox() ?? new THREE.Box3();
  const pointSphere = renderedBounds.isEmpty()
    ? null
    : renderedBounds.getBoundingSphere(new THREE.Sphere());
  const sphere = pointSphere?.radius ? pointSphere : datasetBoundingSphere();
  if (!sphere || sphere.radius === 0) return;
  const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  const direction = new THREE.Vector3(0.85, -1.1, 0.78).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(direction, distance * 0.82);
  camera.near = Math.max(distance / 10_000, 0.01);
  camera.far = Math.max(distance * 20, 1_000);
  camera.updateProjectionMatrix();
  controls.update();
  requestRender();
  scheduleAutomaticLod();
}

function datasetBoundingSphere(): THREE.Sphere | null {
  if (!fullBounds) return null;
  const box = new THREE.Box3(
    new THREE.Vector3(
      fullBounds.min[0] - origin[0],
      fullBounds.min[1] - origin[1],
      fullBounds.min[2] - origin[2],
    ),
    new THREE.Vector3(
      fullBounds.max[0] - origin[0],
      fullBounds.max[1] - origin[1],
      fullBounds.max[2] - origin[2],
    ),
  );
  return box.getBoundingSphere(new THREE.Sphere());
}

async function recolor(): Promise<void> {
  if (!pointCloudRenderer || pointCloudRenderer.pointCount() === 0 || isBusy) return;
  try {
    pointCloudRenderer.recolor(await pointCloudReader.recolor(selectedColorMode()));
  } catch (error) {
    setFailure(error);
  }
}

function updatePointSize(): void {
  const value = element<HTMLInputElement>("point-size").value;
  element<HTMLOutputElement>("point-size-value").value = value;
  pointCloudRenderer?.update(surfaceSettings());
}

function updateSurfaceMode(): void {
  const settings = surfaceSettings();
  element<HTMLElement>("mesh-controls").hidden = settings.representation !== "screen-mesh";
  element<HTMLOutputElement>("mesh-edge-value").value = `${settings.meshEdgeThreshold}×`;
  pointCloudRenderer?.update(settings);
}

function surfaceSettings(): SurfaceSettings {
  const representation = document.querySelector<HTMLInputElement>(
    'input[name="surface"]:checked',
  )!.value as SurfaceRepresentation;
  return {
    representation,
    pointSize: Number(element<HTMLInputElement>("point-size").value),
    meshEdgeThreshold: Number(element<HTMLInputElement>("mesh-edge").value),
    // Half resolution caps reconstruction at roughly one quarter of the
    // viewport cells while preserving enough detail for visual comparison.
    meshResolutionScale: 0.5,
  };
}

function updateResolutionLabel(): void {
  const value = element<HTMLInputElement>("resolution").value;
  element<HTMLOutputElement>("resolution-value").value = value;
  element<HTMLElement>("level-caption").textContent = `L0 → L${value}`;
}

function updateAutoLod(): void {
  const automatic = element<HTMLInputElement>("auto-lod").checked;
  element<HTMLInputElement>("resolution").disabled = automatic || cloud === null;
  element<HTMLInputElement>("sse-threshold").disabled = !automatic;
  element<HTMLInputElement>("point-budget").disabled = !automatic;
  element<HTMLElement>("sse-hud").classList.toggle("manual", !automatic);
  if (automatic) scheduleAutomaticLod();
  else updateSseHud(Number(element<HTMLInputElement>("resolution").value), undefined);
}

function updateSseThreshold(): void {
  const value = element<HTMLInputElement>("sse-threshold").value;
  element<HTMLOutputElement>("sse-threshold-value").value = `${value} px`;
}

function updatePointBudget(): void {
  const input = element<HTMLInputElement>("point-budget");
  const unlimited = input.valueAsNumber === Number(input.max);
  const label = unlimited ? "∞" : formatCompact(input.valueAsNumber);
  input.setAttribute("aria-valuetext", unlimited ? "Unlimited" : label);
  element<HTMLOutputElement>("point-budget-value").value = label;
}

function readPointBudget(): number {
  const input = element<HTMLInputElement>("point-budget");
  return input.valueAsNumber === Number(input.max)
    ? Number.POSITIVE_INFINITY
    : input.valueAsNumber;
}

function scheduleAutomaticLod(immediate = false): void {
  if (!element<HTMLInputElement>("auto-lod").checked || !cloud) return;
  autoLodPending = true;
  autoLodImmediate ||= immediate;
  if (autoLodTimer !== undefined) {
    if (!autoLodImmediate) return;
    clearTimeout(autoLodTimer);
  }
  const elapsed = performance.now() - lastAutoLodAt;
  const delay = autoLodImmediate ? 0 : Math.max(0, AUTO_LOD_INTERVAL_MS - elapsed);
  autoLodTimer = setTimeout(() => {
    autoLodTimer = undefined;
    if (!autoLodPending) return;
    const wasImmediate = autoLodImmediate;
    autoLodPending = false;
    autoLodImmediate = false;
    lastAutoLodAt = performance.now();
    void applyAutomaticLod(false, wasImmediate);
  }, delay);
}

async function applyAutomaticLod(fit = false, wasImmediate = false): Promise<void> {
  if (!cloud || !element<HTMLInputElement>("auto-lod").checked) return;
  const cameraWorld: [number, number, number] = [
    camera.position.x + origin[0],
    camera.position.y + origin[1],
    camera.position.z + origin[2],
  ];
  const bounds = readBoundsInputs();
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const localBounds = new THREE.Box3();
  const selection = selectRowGroupsBySse(
    cloud.rowGroups,
    cloud.resolutions,
    bounds,
    cameraWorld,
    viewport.clientHeight,
    camera.fov,
    Number(element<HTMLInputElement>("sse-threshold").value),
    readPointBudget(),
    (worldBounds) => {
      localBounds.min.set(
        worldBounds.min[0] - origin[0],
        worldBounds.min[1] - origin[1],
        worldBounds.min[2] - origin[2],
      );
      localBounds.max.set(
        worldBounds.max[0] - origin[0],
        worldBounds.max[1] - origin[1],
        worldBounds.max[2] - origin[2],
      );
      return frustum.intersectsBox(localBounds);
    },
  );
  updateSpatialSseHud(selection);
  const selectionKey = `groups:${selection.rowGroupIndices.join(",")}:${boundsKey(bounds)}`;
  if (selectionKey === loadedSelectionKey) return;
  if (isBusy) {
    // Let the in-flight refinement finish and remain visible. Treating camera
    // motion as cancellation starves loading while OrbitControls is damping.
    autoLodPending = true;
    autoLodImmediate ||= wasImmediate;
    return;
  }
  element<HTMLInputElement>("resolution").value = String(selection.maxResolution);
  updateResolutionLabel();
  await queryAndRender({
    resolution: selection.maxResolution,
    rowGroupIndices: selection.rowGroupIndices,
    selectionKey,
    fit,
  });
}

function updateSseHud(resolution: number, pixels: number | undefined): void {
  const hud = element<HTMLElement>("sse-hud");
  hud.querySelector("span")!.textContent = pixels === undefined ? "Manual LOD" : "Auto SSE";
  hud.querySelector("strong")!.textContent = `L${resolution}`;
  hud.querySelector("small")!.textContent = pixels === undefined ? "fixed" : `${pixels.toFixed(2)} px`;
  if (pixels === undefined && cloud) {
    setText("lod-distribution", cloud.resolutions
      .map((level) => `L${level.resolution} ${level.resolution <= resolution ? level.rowGroupEnd - level.rowGroupStart : 0}/${level.rowGroupEnd - level.rowGroupStart}`)
      .join(" · "));
  }
}

function updateSpatialSseHud(selection: SpatialSseSelection): void {
  const hud = element<HTMLElement>("sse-hud");
  hud.querySelector("span")!.textContent = "Spatial SSE";
  hud.querySelector("strong")!.textContent = `L0–L${selection.maxResolution}`;
  hud.querySelector("small")!.textContent = `${selection.rowGroupIndices.length} RG · ${formatCompact(selection.selectedPointCount)} pts`;
  if (cloud) {
    setText("lod-distribution", selection.selectedByResolution
      .map((count, resolution) => `L${resolution} ${count}/${cloud!.resolutions[resolution]!.rowGroupEnd - cloud!.resolutions[resolution]!.rowGroupStart}`)
      .join(" · "));
  }
}

async function updateBoundingBoxes(): Promise<void> {
  const layer = boundingBoxes;
  if (!layer) return;
  const showPages = element<HTMLInputElement>("show-page-bounds").checked;
  layer.setPagesVisible(showPages);
  layer.setRowGroupsVisible(element<HTMLInputElement>("show-row-group-bounds").checked);
  requestRender();
  if (!showPages || layer.hasPages() || loadingPageBounds === layer) return;
  loadingPageBounds = layer;
  try {
    const pages = await pointCloudReader.pageBounds();
    if (boundingBoxes !== layer) return;
    layer.setPages(pages);
    requestRender();
  } catch (error) {
    element<HTMLInputElement>("show-page-bounds").checked = false;
    layer.setPagesVisible(false);
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Page bbox unavailable: ${message}`, "error");
  } finally {
    if (loadingPageBounds === layer) loadingPageBounds = null;
  }
}

function updateMetrics(metrics: QueryMetrics, workerElapsedMs: number): void {
  setText("metric-points", formatInteger(metrics.pointsMatched));
  setText("metric-bytes", formatBytes(metrics.bytesFetched));
  setText("metric-requests", formatInteger(metrics.rangeRequests));
  setText("metric-row-groups", `${metrics.rowGroupsRead} / ${metrics.rowGroupsTotal}`);
  setText("metric-pruned", formatInteger(metrics.rowGroupsPruned));
  setText("metric-candidates", formatInteger(metrics.pointsInCandidateRowGroups));
  setText("query-time", `${workerElapsedMs.toFixed(0)} ms worker`);
}

function updateDatasetMeta(): void {
  if (!cloud) return;
  const meta = cloud.metadata;
  element<HTMLElement>("dataset-meta").innerHTML = `
    <span>×${meta.voxel_edge_ratio} voxel</span><span>${cloud.resolutions.length} levels</span>
    <span>${cloud.rowGroups.length} Row Groups</span>
    <span>metadata ${meta.version}</span><span>${formatBytes(cloud.metadataBytesFetched)} footer</span>
    <small>scale ${meta.scale.map((value) => formatCoordinate(value)).join(" / ")}</small>`;
}

function readBoundsInputs(): WorldBounds {
  const values = ["x-min", "y-min", "z-min", "x-max", "y-max", "z-max"].map((id) => Number(element<HTMLInputElement>(id).value));
  if (!values.every(Number.isFinite)) throw new Error("All bounds must be finite numbers");
  return { min: [values[0]!, values[1]!, values[2]!], max: [values[3]!, values[4]!, values[5]!] };
}

function setBoundsInputs(bounds: WorldBounds): void {
  (["x", "y", "z"] as const).forEach((axis, index) => {
    element<HTMLInputElement>(`${axis}-min`).value = formatCoordinate(bounds.min[index]!);
    element<HTMLInputElement>(`${axis}-max`).value = formatCoordinate(bounds.max[index]!);
  });
}

function selectedColorMode(): ColorMode {
  return document.querySelector<HTMLInputElement>('input[name="color"]:checked')!.value as ColorMode;
}

function setBusy(value: boolean, message?: string): void {
  isBusy = value;
  element<HTMLButtonElement>("open").disabled = value;
  element<HTMLButtonElement>("query").disabled = value || cloud === null;
  if (message) setStatus(message, "loading");
}

function setFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(message, "error");
  const empty = element<HTMLDivElement>("empty-state");
  empty.classList.remove("hidden");
  empty.querySelector("p")!.textContent = "Could not load the dataset. Start the Range server and try again.";
}

function setStatus(message: string, state: "loading" | "ready" | "error"): void {
  setText("status", message);
  element<HTMLElement>("status-dot").dataset.state = state;
}

function resize(): void {
  const { clientWidth, clientHeight } = viewport;
  if (clientWidth === 0 || clientHeight === 0) return;
  renderer.setSize(clientWidth, clientHeight, false);
  pointCloudRenderer?.resize();
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
  requestRender();
  scheduleAutomaticLod();
}

function requestRender(): void {
  renderDirty = true;
}

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setText(id: string, text: string): void {
  element<HTMLElement>(id).textContent = text;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 })
    .format(value)
    .toLowerCase();
}

function formatBytes(value: number): string {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)} kB`;
  return `${(value / 1_000_000).toFixed(2)} MB`;
}

function formatCoordinate(value: number): string {
  return Number(value.toFixed(6)).toString();
}

function boundsKey(bounds: WorldBounds): string {
  return [...bounds.min, ...bounds.max].join(",");
}
