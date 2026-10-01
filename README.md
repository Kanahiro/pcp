# Point Cloud Parquet (PCP)

PCP is an experimental way to store LAS/LAZ point clouds in a single Parquet file for spatial, progressive loading. It combines additive levels of detail (LOD), 3D spatial ordering, and Parquet's standard statistics and Page Index. The repository contains a Rust converter, a browser reader, and a Three.js viewer.

The result is ordinary Parquet: analytical tools can read its columns. Interpreting coordinates and LOD requires PCP's `point_cloud` metadata. This is a proof of concept, not a GeoParquet or COPC file.

## Try it

Requires Rust with edition 2024 support, Node.js 24, and pnpm 12. No sample point cloud is included.

```sh
cargo run --release -p pcp-convert -- ./input.laz --output points.parquet
pnpm install
pnpm serve . 8080
```

In another terminal, run `pnpm dev:viewer`. Set **Parquet source** to `http://127.0.0.1:8080/points.parquet` and select **Open**. The viewer initially points to an external demo file. The included Range server listens only on `127.0.0.1` and is intended for local development.

The [browser reader](packages/browser) can also be used directly:

```js
import { PointCloudParquet } from "@pointcloud-parquet/browser";

const cloud = await PointCloudParquet.open("http://127.0.0.1:8080/points.parquet");
const { chunks, metrics } = await cloud.queryWorld(
  { min: [123000, 456000, 0], max: [123100, 456100, 100] },
  0, // L0 only; use cloud.resolutions.length - 1 for all points
);
```

`queryWorld` accepts a bounding box in the file's CRS and returns quantized integer XYZ and UInt16 RGB arrays. It does not reproject coordinates. Use `cloud.decodePosition()` to recover real coordinates. The reader currently returns XYZRGB only; missing RGB values become zero. A remote source must support HTTP Range and HEAD, with CORS and exposed `Content-Length`, `Content-Range`, and `Accept-Ranges` headers when accessed across origins.

## File format

Each row is one point. The converter preserves LAS quantized XYZ, assigns each point to exactly one LOD level, and stores levels in order. Reading L0 through level *r* adds detail; reading through the final level recovers every point. Within each level, 3D STR packing groups nearby points into Row Groups, then into pages. XYZ min/max statistics and the Page Index let the reader skip candidates outside a 3D bounding box. There is no separate spatial index or octree.

| Columns | Type | Nullable | Default value encoding |
| --- | --- | --- | --- |
| `x`, `y`, `z` | Int32 | No | `DELTA_BINARY_PACKED` |
| `red`, `green`, `blue`, `nir` | UInt16 | Yes | Dictionary |
| `intensity`, `point_source_id` | UInt16 | No | Dictionary |
| `return_number`, `number_of_returns`, `classification`, `scanner_channel`, `user_data` | UInt8 | No | Dictionary |
| `scan_direction_flag`, `edge_of_flight_line`, `synthetic`, `key_point`, `withheld`, `overlap` | Boolean | No | `RLE` |
| `scan_angle` (degrees) | Float32 | No | Dictionary |
| `gps_time` | Float64 | Yes | `PLAIN` |
| `wave_packet_descriptor_index` | UInt8 | Yes | Dictionary |
| `waveform_data_offset` | UInt64 | Yes | `DELTA_BINARY_PACKED` |
| `waveform_packet_size` | UInt32 | Yes | Dictionary |
| `return_point_waveform_location`, `waveform_x_t`, `waveform_y_t`, `waveform_z_t` | Float32 | Yes | Dictionary |
| `extra_bytes` | Binary | Yes | Dictionary |

These are defaults for non-null values; dictionary encoding can fall back to `PLAIN`.

The file's `point_cloud` Parquet key/value metadata is a JSON object:

| Field | Meaning |
| --- | --- |
| `version` | Format version, currently `0.1.0` |
| `scale`, `offset` | Three values each; real coordinate = integer coordinate × scale + offset, per axis |
| `bounds` | Real-coordinate `[xmin, ymin, zmin, xmax, ymax, zmax]` |
| `level_row_group_ends` | Exclusive, cumulative Row Group end for each level; repeated ends represent empty levels |
| `voxel_edge_ratio` | Edge-length ratio between adjacent LOD levels; the finest voxel edge is `max(scale)` |
| `crs` | PROJJSON object, or `null` if the source has no CRS |

The default layout is 262,144 points per Row Group and 8,192 rows per page. All columns use ZSTD (level 9 by default). The converter accepts LAS 1.4 point formats 0–10, including LAZ compression. Multiple inputs must have the same scale, offset, point format, and CRS. Conversion holds the input points and attributes in memory; run `cargo run -p pcp-convert -- --help` for layout options.

Absent optional attributes are null. `extra_bytes` stores raw per-point bytes, but VLR/EVLR records and waveform data bodies are not copied. The output is not a lossless archive of the original LAS/LAZ file.

The source code is available under the [MIT License](LICENSE).

## COPC benchmark

In five remote browser XYZRGB bounding-box queries over a 7.19-million-point source, PCP took 3.41 s versus COPC's 6.25 s (sum of per-query medians). The measured PCP file was larger (105.2 vs 88.8 MB), but with XYZRGB column projection the queries transferred less data (38.2 vs 81.4 MB). Results depend on the query, LOD selection, and network latency; see the [benchmark details](benchmarks/copc-comparison.md). The PCP file predates the [current encoding defaults](benchmarks/column-encoding-audit-20261001.md).
