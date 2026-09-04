import type { AsyncBuffer } from "hyparquet";
/** Shared compressed-byte cache; each session meters only physical misses. */
export declare class RangeCache {
    private readonly source;
    private readonly maximumBytes;
    private readonly ranges;
    private readonly pending;
    private cachedBytes;
    private clock;
    constructor(source: AsyncBuffer, maximumBytes?: number);
    session(): MeteredRangeSession;
    get byteLength(): number;
    read(start: number, end: number, meter: MeteredRangeSession): Promise<ArrayBuffer>;
    private insert;
}
export declare class MeteredRangeSession implements AsyncBuffer {
    private readonly cache;
    bytesFetched: number;
    requests: number;
    constructor(cache: RangeCache);
    get byteLength(): number;
    prefetch(ranges: Array<{
        start: number;
        end: number;
    }>): Promise<void>;
    slice(start: number, end?: number): Promise<ArrayBuffer>;
}
