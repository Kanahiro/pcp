import { describe, expect, it } from "vitest";
import { concatenatePointColumns, selectPointColumns } from "./point-columns.js";

describe("selectPointColumns", () => {
  it("filters XYZ in one pass and packs nullable colors into typed columns", () => {
    const selected = selectPointColumns(
      [
        new Int32Array([0, 5, 10]),
        new Int32Array([1, 6, 11]),
        new Int32Array([2, 7, 12]),
        [null, 100, 200],
        [null, 101, 201],
        [null, 102, 202],
      ],
      { min: [4, 5, 6], max: [10, 10, 10] },
      3,
    );

    expect(selected.resolution).toBe(3);
    expect(selected.length).toBe(1);
    expect(Array.from(selected.x)).toEqual([5]);
    expect(Array.from(selected.y)).toEqual([6]);
    expect(Array.from(selected.z)).toEqual([7]);
    expect(Array.from(selected.red)).toEqual([100]);
    expect(Array.from(selected.green)).toEqual([101]);
    expect(Array.from(selected.blue)).toEqual([102]);
  });
});

describe("concatenatePointColumns", () => {
  it("joins physical scan ranges without creating point objects", () => {
    const first = selectPointColumns(
      [new Int32Array([1]), new Int32Array([2]), new Int32Array([3]), [4], [5], [6]],
      { min: [0, 0, 0], max: [10, 10, 10] },
      1,
    );
    const second = selectPointColumns(
      [new Int32Array([7]), new Int32Array([8]), new Int32Array([9]), [10], [11], [12]],
      { min: [0, 0, 0], max: [10, 10, 10] },
      1,
    );

    const result = concatenatePointColumns([first, second], 1);
    expect(result.length).toBe(2);
    expect(Array.from(result.x)).toEqual([1, 7]);
    expect(Array.from(result.blue)).toEqual([6, 12]);
  });
});
