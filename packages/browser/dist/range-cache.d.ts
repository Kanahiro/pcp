import type { AsyncBuffer } from "hyparquet";
export interface RangeCoalescingOptions {
    /** Largest unread gap worth transferring to eliminate another request. */
    maxGapBytes?: number;
    /** Cap for combining reads; a single caller-requested range may be larger. */
    maxRequestBytes?: number;
}
/** Shared compressed-byte cache; each session meters only physical misses. */
export declare class RangeCache {
    private readonly source;
    private readonly maximumBytes;
    private readonly coalescing;
    private readonly ranges;
    private readonly pending;
    private cachedBytes;
    private clock;
    constructor(source: AsyncBuffer, maximumBytes?: number, coalescing?: RangeCoalescingOptions);
    session(): MeteredRangeSession;
    get byteLength(): number;
    cached(start: number, end: number): ArrayBuffer | undefined;
    read(start: number, end: number, meter: MeteredRangeSession): Promise<ArrayBuffer>;
    private insert;
}
export declare class MeteredRangeSession implements AsyncBuffer {
    private readonly cache;
    private readonly maxGapBytes;
    private readonly maxRequestBytes;
    bytesFetched: number;
    requests: number;
    private queue;
    private flushScheduled;
    constructor(cache: RangeCache, maxGapBytes: number, maxRequestBytes: number);
    get byteLength(): number;
    prefetch(ranges: Array<{
        start: number;
        end: number;
    }>): Promise<void>;
    slice(start: number, end?: number): Promise<ArrayBuffer>;
    private flush;
    private readBatch;
}
