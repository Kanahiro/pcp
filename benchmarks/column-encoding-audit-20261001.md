# Column encoding audit — 2026-10-01

The converter's default encodings were checked against the [7,188,755-point COPC sample](https://cogp-demo.spatialty.io/temp/114112.copc.laz) (`SHA-256 c70a8adcdda4cf5bb719c6ac1a28c75e5c06b7c66d8c8782d56507a42f14aa06`). The source was converted with the then-current defaults: 262,144 rows per Row Group, 8,192 rows per page, spatial order, and ZSTD 9. The resulting Parquet was 105,183,389 bytes.

For controlled comparisons, the same Arrow batches were rewritten with parquet-rs 59.3.0, changing only the stated column encoding. The rewritten baseline reproduced **every column's compressed byte count exactly**; its footer was 572 bytes larger because the probe did not copy `point_cloud` metadata. Column sizes include dictionary pages. Whole-column decode timings use Hyparquet 1.29.2 with the PCP ZSTD decoder and local, warm file reads; they exclude metadata parsing, HTTP, bbox filtering, and drawing. Each median follows one warmup and three measured runs. These are results for this data and layout, not general encoder rankings.

| Column | Previous encoding | Alternative | Compressed column bytes, previous → alternative | Hyparquet full-column median | Decision |
| --- | --- | --- | ---: | ---: | --- |
| `gps_time` | `BYTE_STREAM_SPLIT` | `PLAIN` | 32,503,232 → 28,501,840 (−12.3%) | 264 → 227 ms | Use `PLAIN` |
| `intensity` | `DELTA_BINARY_PACKED` | dictionary | 11,695,956 → 11,473,549 (−1.9%) | 213 → 115 ms | Use dictionary |
| RGB combined | dictionary | `BYTE_STREAM_SPLIT` | 17,781,244 → 17,689,027 (−0.5%) | Not measured on all rows | Keep dictionary for compatibility |

With both defaults changed, the actual converter output was **100,960,014 bytes**, down **4,223,375 bytes (4.0%)** from 105,183,389 bytes. DuckDB 1.5.2 read both outputs and returned identical row counts and aggregate hashes for XYZ, RGB, `gps_time`, and `intensity`. `PLAIN` and dictionary keep their usual Parquet types and values. In one representative XYZRGB bbox query through the PCP browser reader and local Range server, both outputs returned 167,039 points, 51 Range requests, and the same SHA-256 digest of XYZRGB chunks. Query Range body was 4,557,396 versus 4,557,395 bytes; the XYZRGB compressed column sizes were identical. The older COPC browser comparison has not been rerun with the new defaults.

`BYTE_STREAM_SPLIT` for RGB or intensity writes valid Parquet INT32 values, and Hyparquet decoded the sampled values. However, DuckDB 1.5.2 rejected these files with `BYTE_STREAM_SPLIT encoding is only supported for FLOAT or DOUBLE data`. A 0.5% RGB saving is not worth losing that reader. This is an observed version-specific compatibility limit; the [Parquet specification](https://parquet.apache.org/docs/file-format/data-pages/encodings/) permits `BYTE_STREAM_SPLIT` on INT32.

## Other columns

Five Row Groups spread across the LOD range (indices 0, 8, 17, 25, 33; 791,510 rows) were compared under otherwise identical rewrite settings. Sizes below are compressed column bytes for that subset.

| Columns | Current | Compared alternatives | Assessment |
| --- | ---: | ---: | --- |
| XYZ, `DELTA_BINARY_PACKED` | 3,548,109 | `PLAIN` 4,905,435; `BYTE_STREAM_SPLIT` 3,732,666; dictionary 6,551,831 | Keep delta |
| RGB, dictionary | 2,005,571 | `PLAIN` 3,354,377; delta 4,280,323; byte stream split 2,000,226 | Keep dictionary; see compatibility above |
| `return_number`, `number_of_returns`, dictionary | 430,788 | `PLAIN` 599,590; delta 569,881; byte stream split 438,822 | Keep dictionary |
| `classification`, dictionary | 89,419 | `PLAIN` 151,208; delta 122,752; byte stream split 104,843 | Keep dictionary |
| `scan_angle`, dictionary | 324,052 | `PLAIN` 420,336; byte stream split 910,444 | Keep dictionary |
| `point_source_id`, dictionary | 194,403 | `PLAIN` 313,136; delta 301,152; byte stream split 218,022 | Keep dictionary |
| `user_data`, dictionary | 22,375 | `PLAIN` 36,291; delta 27,918; byte stream split 25,889 | Keep dictionary |

`scanner_channel` is also smaller with dictionary on this sample, but its values have very little variation. Boolean columns use Parquet's RLE value encoding. `PLAIN` reduced `scan_direction_flag` from 104,889 to 101,653 bytes in the subset, but increased each constant boolean field from 3,295 to 4,460 bytes; this small result does not justify a new per-column default. `nir`, waveform fields, and `extra_bytes` are entirely null in this source, so their value encodings remain **unassessed**. The configured delta encoding for `waveform_data_offset` is likewise not evaluated by an all-null column. A point cloud with populated NIR, waveform, and extra-byte fields is needed before making claims about those defaults.

## Nullable and sparse columns

The 7,188,755-point output has nine entirely null columns. Eight occupy 29,844 compressed bytes each; `waveform_data_offset` occupies 32,590 bytes. Together they account for 271,342 bytes across 34 Row Groups. Nulls are recorded in Parquet definition levels rather than as encoded values, but pages, column chunks, and metadata still have overhead.

For a separate synthetic check, parquet-rs 59.3.0 wrote 262,144 rows in one Row Group with the converter's 8,192-row pages, Parquet 2.0, ZSTD 9, and current encodings for `nir` (dictionary), `gps_time` (`PLAIN`), and `waveform_data_offset` (delta). The 1% cases each had exactly 2,621 non-null rows; the random case spread them uniformly through the group and the clustered case placed them at the start. The 10% case had 26,214 non-null rows. These are **whole file** sizes for three columns, including metadata:

| Populated rows | Parquet bytes |
| --- | ---: |
| None | 6,040 |
| 1%, clustered | 13,597 |
| 1%, spread through the group | 58,416 |
| 10%, spread through the group | 221,412 |
| All rows | 468,572 |

The converter currently models each optional LAS attribute as present or absent for the complete input (and requires matching point formats across inputs). If present, it writes a value for every point. Therefore these synthetic per-point sparse cases test the Parquet writer, **not an input pattern the converter currently produces**. A numeric zero in a present LAS field is a value, not a null. Supporting per-point missing values would require an explicit input meaning and a corresponding attribute representation.

Earlier encoding experiments used a different page order, Row Group size, and ZSTD setting. Their results are not directly comparable to this audit.
