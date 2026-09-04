import { describe, expect, it } from "vitest";
import type { ColumnChunk, RowGroup } from "hyparquet";
import { planQuery } from "./index.js";

function column(name: string, min: number, max: number): ColumnChunk {
  return {
    file_offset: 0n,
    meta_data: {
      type: "INT32",
      encodings: ["PLAIN"],
      path_in_schema: [name],
      codec: "ZSTD",
      num_values: 10n,
      total_uncompressed_size: 40n,
      total_compressed_size: 20n,
      data_page_offset: 0n,
      statistics: { min_value: min, max_value: max },
    },
  };
}

function group(minX: number, maxX: number): RowGroup {
  return {
    columns: [
      column("x", minX, maxX),
      column("y", 0, 10),
      column("z", 0, 10),
    ],
    total_byte_size: 160n,
    num_rows: 10n,
  };
}

describe("planQuery", () => {
  it("limits levels by their Row Group ranges and spatial statistics", () => {
    const plan = planQuery(
      [group(0, 10), group(50, 60), group(0, 10)],
      { min: [5, 2, 2], max: [15, 8, 8] },
      [1, 2, 3],
      1,
    );
    expect(plan).toEqual({ rowGroupsRead: 1, pointsInCandidateRowGroups: 10 });
  });
});
