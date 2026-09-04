import { describe, expect, it } from "vitest";
import type { AsyncBuffer } from "hyparquet";
import { RangeCache } from "./range-cache.js";

class MemoryBuffer implements AsyncBuffer {
  readonly byteLength = 32;
  requests = 0;

  async slice(start: number, end = this.byteLength): Promise<ArrayBuffer> {
    this.requests += 1;
    return Uint8Array.from({ length: end - start }, (_, index) => start + index).buffer;
  }
}

describe("RangeCache", () => {
  it("meters a range once and serves covered reads from the shared cache", async () => {
    const source = new MemoryBuffer();
    const cache = new RangeCache(source, 32);
    const first = cache.session();
    expect([...new Uint8Array(await first.slice(4, 12))]).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect({ requests: first.requests, bytes: first.bytesFetched }).toEqual({ requests: 1, bytes: 8 });

    const second = cache.session();
    expect([...new Uint8Array(await second.slice(6, 9))]).toEqual([6, 7, 8]);
    expect({ requests: second.requests, bytes: second.bytesFetched }).toEqual({ requests: 0, bytes: 0 });
    expect(source.requests).toBe(1);
  });
});
