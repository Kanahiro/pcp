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

  it("coalesces concurrent nearby reads and returns their exact slices", async () => {
    const source = new MemoryBuffer();
    const cache = new RangeCache(source, 32, { maxGapBytes: 2, maxRequestBytes: 16 });
    const session = cache.session();
    const [first, second, third] = await Promise.all([
      session.slice(2, 6),
      session.slice(8, 11),
      session.slice(11, 14),
    ]);

    expect([...new Uint8Array(first)]).toEqual([2, 3, 4, 5]);
    expect([...new Uint8Array(second)]).toEqual([8, 9, 10]);
    expect([...new Uint8Array(third)]).toEqual([11, 12, 13]);
    expect({ requests: session.requests, bytes: session.bytesFetched }).toEqual({
      requests: 1,
      bytes: 12,
    });
    expect(source.requests).toBe(1);
  });

  it("does not cross the maximum request size", async () => {
    const source = new MemoryBuffer();
    const cache = new RangeCache(source, 32, { maxGapBytes: 32, maxRequestBytes: 8 });
    const session = cache.session();
    await Promise.all([session.slice(0, 4), session.slice(6, 10)]);

    expect({ requests: session.requests, bytes: session.bytesFetched }).toEqual({
      requests: 2,
      bytes: 8,
    });
  });

  it("does not delay a later read to wait for more work", async () => {
    const source = new MemoryBuffer();
    const cache = new RangeCache(source, 32);
    const session = cache.session();
    await session.slice(0, 4);
    await session.slice(8, 12);

    expect(session.requests).toBe(2);
  });
});
