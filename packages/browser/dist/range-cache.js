/** Shared compressed-byte cache; each session meters only physical misses. */
export class RangeCache {
    source;
    maximumBytes;
    ranges = [];
    pending = new Map();
    cachedBytes = 0;
    clock = 0;
    constructor(source, maximumBytes = 64 * 1024 * 1024) {
        this.source = source;
        this.maximumBytes = maximumBytes;
    }
    session() {
        return new MeteredRangeSession(this);
    }
    get byteLength() {
        return this.source.byteLength;
    }
    async read(start, end, meter) {
        const cached = this.ranges.find((range) => start >= range.start && end <= range.end);
        if (cached) {
            cached.lastUsed = ++this.clock;
            if (start === cached.start && end === cached.end)
                return cached.data;
            return cached.data.slice(start - cached.start, end - cached.start);
        }
        const key = `${start}:${end}`;
        const existing = this.pending.get(key);
        if (existing)
            return existing;
        const request = Promise.resolve(this.source.slice(start, end));
        this.pending.set(key, request);
        meter.requests += 1;
        try {
            const data = await request;
            meter.bytesFetched += data.byteLength;
            this.insert({ start, end, data, lastUsed: ++this.clock });
            return data;
        }
        finally {
            this.pending.delete(key);
        }
    }
    insert(range) {
        if (range.data.byteLength > this.maximumBytes)
            return;
        for (let index = this.ranges.length - 1; index >= 0; index -= 1) {
            const existing = this.ranges[index];
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
                if (this.ranges[index].lastUsed < this.ranges[oldestIndex].lastUsed)
                    oldestIndex = index;
            }
            const [removed] = this.ranges.splice(oldestIndex, 1);
            this.cachedBytes -= removed.data.byteLength;
        }
    }
}
export class MeteredRangeSession {
    cache;
    bytesFetched = 0;
    requests = 0;
    constructor(cache) {
        this.cache = cache;
    }
    get byteLength() {
        return this.cache.byteLength;
    }
    async prefetch(ranges) {
        await Promise.all(ranges.map(({ start, end }) => this.cache.read(start, end, this)));
    }
    slice(start, end = this.byteLength) {
        return this.cache.read(start, end, this);
    }
}
