import { Bounds, Copc, Key } from "copc";

export async function loadHierarchy(getter, rootPage) {
  const nodes = {};
  const pending = [rootPage];
  const seen = new Set();
  let hierarchyPages = 0;
  while (pending.length > 0) {
    const page = pending.pop();
    const id = `${page.pageOffset}:${page.pageLength}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hierarchyPages += 1;
    const subtree = await Copc.loadHierarchyPage(getter, page);
    Object.assign(nodes, subtree.nodes);
    for (const child of Object.values(subtree.pages)) {
      if (child !== undefined) pending.push(child);
    }
  }
  return { nodes, hierarchyPages };
}

function overlaps(a, b) {
  return a[3] >= b.min[0] && a[0] <= b.max[0]
    && a[4] >= b.min[1] && a[1] <= b.max[1]
    && a[5] >= b.min[2] && a[2] <= b.max[2];
}

export function selectCopcNodes(copc, nodes, bounds, maxDepth) {
  return Object.entries(nodes).flatMap(([key, node]) => {
    if (node === undefined || Key.parse(key)[0] > maxDepth) return [];
    return overlaps(Bounds.stepTo([...copc.info.cube], Key.parse(key)), bounds) ? [[key, node]] : [];
  });
}

export async function mapPool(items, workers, callback) {
  let cursor = 0;
  await Promise.all(workers.map(async (worker, workerIndex) => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await callback(items[index], worker, workerIndex);
    }
  }));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function aggregate(samples) {
  const numeric = Object.keys(samples[0]).filter((key) =>
    samples.every((sample) => typeof sample[key] === "number"));
  return Object.fromEntries(numeric.map((key) => [key, median(samples.map((sample) => sample[key]))]));
}
