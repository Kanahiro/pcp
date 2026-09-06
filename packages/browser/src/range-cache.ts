import type { AsyncBuffer } from "hyparquet";

interface CachedRange {
  start: number;
  end: number;
  data: ArrayBuffer;
  lastUsed: number;
}

export interface RangeCoalescingOptions {
  /** Largest unread gap worth transferring to eliminate another request. */
  maxGapBytes?: number;
  /** Cap for combining reads; a single caller-requested range may be larger. */
  maxRequestBytes?: number;
}

interface QueuedRead {
  start: number;
  end: number;
  resolve: (data: ArrayBuffer) => void;
  reject: (error: unknown) => void;
}

interface ReadBatch {
  start: number;
  end: number;
  reads: QueuedRead[];
}

const DEFAULT_MAX_GAP_BYTES = 32 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Shared compressed-byte cache; each session meters only physical misses. */
export class RangeCache {
  private readonly ranges: CachedRange[] = [];
  private readonly pending = new Map<string, Promise<ArrayBuffer>>();
  private cachedBytes = 0;
  private clock = 0;

  constructor(
    private readonly source: AsyncBuffer,
    private readonly maximumBytes = 64 * 1024 * 1024,
    private readonly coalescing: RangeCoalescingOptions = {},
  ) {
    validateNonNegativeInteger(coalescing.maxGapBytes, "maxGapBytes");
    validatePositiveInteger(coalescing.maxRequestBytes, "maxRequestBytes");
  }

  session(): MeteredRangeSession {
    return new MeteredRangeSession(
      this,
      this.coalescing.maxGapBytes ?? DEFAULT_MAX_GAP_BYTES,
      this.coalescing.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    );
  }

  get byteLength(): number {
    return this.source.byteLength;
  }

  cached(start: number, end: number): ArrayBuffer | undefined {
    const cached = this.ranges.find((range) => start >= range.start && end <= range.end);
    if (cached) {
      cached.lastUsed = ++this.clock;
      if (start === cached.start && end === cached.end) return cached.data;
      return cached.data.slice(start - cached.start, end - cached.start);
    }
    return undefined;
  }

  async read(start: number, end: number, meter: MeteredRangeSession): Promise<ArrayBuffer> {
    const cached = this.cached(start, end);
    if (cached !== undefined) return cached;

    const key = `${start}:${end}`;
    const existing = this.pending.get(key);
    if (existing) return existing;

    const request = Promise.resolve(this.source.slice(start, end));
    this.pending.set(key, request);
    meter.requests += 1;
    try {
      const data = await request;
      meter.bytesFetched += data.byteLength;
      this.insert({ start, end, data, lastUsed: ++this.clock });
      return data;
    } finally {
      this.pending.delete(key);
    }
  }

  private insert(range: CachedRange): void {
    if (range.data.byteLength > this.maximumBytes) return;
    for (let index = this.ranges.length - 1; index >= 0; index -= 1) {
      const existing = this.ranges[index]!;
      if (existing.start >= range.start && existing.end <= range.end) {
        this.cachedBytes -= existing.data.byteLength;
        this.ranges.splice(index, 1);
      }
    }
    this.ranges.push(range);
    this.cachedBytes += range.data.byteLength;
    while (this.cachedBytes > this.maximumBytes) {
      let oldestIndex = 0;
      for (let index = 1; index < this.ranges.length; index += 1) {
        if (this.ranges[index]!.lastUsed < this.ranges[oldestIndex]!.lastUsed) oldestIndex = index;
      }
      const [removed] = this.ranges.splice(oldestIndex, 1);
      this.cachedBytes -= removed!.data.byteLength;
    }
  }
}

export class MeteredRangeSession implements AsyncBuffer {
  bytesFetched = 0;
  requests = 0;
  private queue: QueuedRead[] = [];
  private flushScheduled = false;

  constructor(
    private readonly cache: RangeCache,
    private readonly maxGapBytes: number,
    private readonly maxRequestBytes: number,
  ) {}

  get byteLength(): number {
    return this.cache.byteLength;
  }

  async prefetch(ranges: Array<{ start: number; end: number }>): Promise<void> {
    await Promise.all(ranges.map(({ start, end }) => this.slice(start, end)));
  }

  slice(start: number, end = this.byteLength): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > this.byteLength) {
      return Promise.reject(new RangeError("invalid byte range"));
    }
    const cached = this.cache.cached(start, end);
    if (cached !== undefined) return Promise.resolve(cached);

    const result = new Promise<ArrayBuffer>((resolve, reject) => {
      this.queue.push({ start, end, resolve, reject });
    });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      // Hyparquet starts sibling column/page reads synchronously. A microtask
      // captures that batch without adding timer latency to isolated reads.
      queueMicrotask(() => this.flush());
    }
    return result;
  }

  private flush(): void {
    this.flushScheduled = false;
    const queued = this.queue;
    this.queue = [];
    const misses = queued.filter((read) => {
      const cached = this.cache.cached(read.start, read.end);
      if (cached === undefined) return true;
      read.resolve(cached);
      return false;
    });
    for (const batch of coalesce(misses, this.maxGapBytes, this.maxRequestBytes)) {
      void this.readBatch(batch);
    }
  }

  private async readBatch(batch: ReadBatch): Promise<void> {
    try {
      const data = await this.cache.read(batch.start, batch.end, this);
      for (const read of batch.reads) {
        read.resolve(data.slice(read.start - batch.start, read.end - batch.start));
      }
    } catch (error) {
      for (const read of batch.reads) read.reject(error);
    }
  }
}

function coalesce(reads: QueuedRead[], maxGapBytes: number, maxRequestBytes: number): ReadBatch[] {
  const sorted = [...reads].sort((left, right) => left.start - right.start || left.end - right.end);
  const batches: ReadBatch[] = [];
  for (const read of sorted) {
    const previous = batches.at(-1);
    const combinedEnd = Math.max(previous?.end ?? read.end, read.end);
    if (previous !== undefined
      && read.start - previous.end <= maxGapBytes
      && combinedEnd - previous.start <= maxRequestBytes) {
      previous.end = combinedEnd;
      previous.reads.push(read);
    } else {
      batches.push({ start: read.start, end: read.end, reads: [read] });
    }
  }
  return batches;
}

function validateNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
