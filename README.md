# Point Cloud Parquet PoC

LAS/LAZ点群を、段階的な詳細表示（LOD）と3次元bboxによる部分取得ができる単一Parquetファイルへ変換する実験プロジェクトです。Rust製コンバータ、JavaScriptリーダー、Three.js製ビューアを含みます。

元の量子化整数XYZと点属性を列として保存し、ブラウザでは必要なXYZRGBだけをHTTP Rangeで取得します。通常のParquetとしてDuckDBなどからも読み出せます。

## 新規性・設計の特徴

このPoCで試しているのは、**加算LOD・2段階の3D STR配置・Parquet標準の統計／Page Indexを組み合わせた点群ストリーミング**です。

1. **加算LOD**：voxel内の代表点を粗いlevelへ割り当て、残りを細かいlevelへ保存します。各点は一つのlevelにだけ所属し、L0から最終levelまで読むと全点が揃います。
2. **2段階の空間配置**：各levelを3D STR（Sort-Tile-Recursive）でRow Groupへ詰め、さらに各Row Group内をページ単位で同様に配置します。
3. **標準インデックスで部分取得**：XYZのmin/max統計でRow Groupを、Page Indexでページを絞り込みます。専用の空間インデックスや別ファイルは不要です。

LODは連続したRow Groupの範囲として記録するため、点ごとのLOD列やoctreeの親子関係は持ちません。各手法そのものの発明ではなく、点群向けの保存配置と読み出しの組み合わせを検証するPoCです。

## COPCに対するpros / cons

[COPC（Cloud Optimized Point Cloud）](https://copc.io/)は、点群をoctreeで整理して単一のLAZ 1.4ファイルに格納する形式です。どちらもHTTP Rangeによる空間部分取得と段階的な詳細表示を目的としますが、本プロジェクトはParquetの列指向配置と標準インデックスを使います。

| 観点 | このプロジェクトの利点（pros） | COPCに対する弱点（cons） |
| --- | --- | --- |
| 分析・属性選択 | XYZや属性を独立した列として扱い、DuckDBなどで必要列だけを分析できる | LAS/LAZ互換性がなく、既存のCOPCリーダーでは読めない。座標復元とLODには独自メタデータの解釈が必要 |
| 部分取得 | Row Group統計とPage Indexでbbox外を除外し、必要な列・ページを取得できる | 取得単位が細かく、Range数と初期メタデータ取得量が増える場合がある |
| 空間構造・LOD | LOD境界とParquet標準統計で構成でき、専用のoctreeインデックスを持たずに済む | COPCのような親子関係を辿る階層探索はできず、Row GroupごとにbboxとLODを判定する |
| 圧縮・保存 | 列ごとにencodingを選び、空間配置とZSTDを組み合わせられる | 既存の圧縮実験ではCOPCより約20%大きい。VLR/EVLRも複製しないため、LAS固有メタデータの保持に制約がある |

[既存ベンチマーク](benchmarks/copc-comparison.md)では、約719万点の入力に対する5種類のXYZRGB bbox queryで、転送量合計はParquet 37.0 MB／COPC 81.0 MB、Range数は330／54でした。2026-09-08のリーダー比較では、各queryの中央値の合計が1,040 ms／3,567 msでした。

これは64K Row Group／4Kページの構成と、比較に使用したリーダーでの結果です。LODのsamplingと一致点数は異なり、ネットワーク遅延も含まないため、形式全般の速度優位を示すものではありません。COPCのLAZ 1.4も属性選択に対応しており、「COPCでは常に全属性の取得・展開が必要」という比較ではありません。

## Parquetスキーマ

1行が1点です。下表は出力列の型とnull許容性を示します。`UInt8/16/32`はParquetの`INT32`＋符号なし整数の論理型、`UInt64`は`INT64`＋同論理型です。`Float32/64`は`FLOAT/DOUBLE`、`Binary`は`BYTE_ARRAY`に対応します。

| 列 | 型 | null可 |
| --- | --- | --- |
| `x`, `y`, `z` | Int32 | — |
| `red`, `green`, `blue` | UInt16 | ✓ |
| `intensity` | UInt16 | — |
| `return_number`, `number_of_returns` | UInt8 | — |
| `scan_direction_flag`, `edge_of_flight_line` | Boolean | — |
| `classification` | UInt8 | — |
| `synthetic`, `key_point`, `withheld`, `overlap` | Boolean | — |
| `scanner_channel` | UInt8 | — |
| `scan_angle` | Float32（度） | — |
| `user_data` | UInt8 | — |
| `point_source_id` | UInt16 | — |
| `gps_time` | Float64 | ✓ |
| `nir` | UInt16 | ✓ |
| `wave_packet_descriptor_index` | UInt8 | ✓ |
| `waveform_data_offset` | UInt64 | ✓ |
| `waveform_packet_size` | UInt32 | ✓ |
| `return_point_waveform_location` | Float32 | ✓ |
| `waveform_x_t`, `waveform_y_t`, `waveform_z_t` | Float32 | ✓ |
| `extra_bytes` | Binary | ✓ |

LAS 1.4 point format 0〜10の標準属性に対応し、入力にないoptional属性はnullです。`extra_bytes`は点ごとの生バイト列で、意味を定義するVLRは複製しません。波形の参照属性は保存しますが、参照先の波形データ本体やVLR/EVLRコンテナは保存しません。LAS/LAZファイル全体を復元するアーカイブ形式ではありません。

ファイルのkey/valueメタデータ`point_cloud`には、次のようなJSONを保存します（値は例）。

```json
{
  "version": "0.1.0",
  "scale": [0.01, 0.01, 0.01],
  "offset": [123000, 456000, 0],
  "bounds": [123000, 456000, 0, 123100, 456100, 100],
  "level_row_group_ends": [1, 3, 8],
  "voxel_edge_ratio": 2,
  "crs": null
}
```

- 実座標は各軸で`整数座標 * scale + offset`。`bounds`は実座標の`[xmin, ymin, zmin, xmax, ymax, zmax]`です。
- `level_row_group_ends`はlevelごとのRow Group終端（exclusive）。例ではL0が`[0, 1)`、L1が`[1, 3)`、L2が`[3, 8)`で、L0〜L2を読むと全点になります。空のlevelでは直前と同じ終端が入ります。
- level数をN、level番号をrとするとvoxelの一辺は`max(scale) * voxel_edge_ratio ** (N - 1 - r)`。最終levelには残りの全点を保存します。
- `crs`はPROJJSONオブジェクト、CRS未定義なら`null`です。

## 圧縮

元のLAS量子化整数を維持し、以下の列encodingと**全列ZSTD（既定level 9）**を組み合わせます。

| 列 | encoding |
| --- | --- |
| XYZ、`intensity`、`waveform_data_offset` | `DELTA_BINARY_PACKED` |
| `gps_time` | `BYTE_STREAM_SPLIT` |
| RGBなどその他の列 | writer既定（対応列では辞書encodingを利用） |

既定の配置は**262,144点／Row Group、8,192行／ページ**です。空間配置はbboxの選択性だけでなく、近い座標の差分圧縮にも使います。

圧縮率は入力と配置に依存します。[圧縮実験](benchmarks/compression-study.md)では、約719万点・64K Row Group／4KページのParquetが14.782 bytes/pointで、比較したCOPCより19.61%大きくなりました。これは現在の既定配置とは異なる条件での結果です。

## コンバータの使い方

Rust（edition 2024対応）を用意し、リポジトリ直下で実行します。

```sh
cargo run --release -p pcp-convert -- ./input.laz --output points.parquet

# 複数ファイルを一つにまとめる場合
cargo run --release -p pcp-convert -- ./src/*.laz --output points.parquet
```

入力群は同じscale／offset、point format、CRSを持つ必要があります。変換時は点座標と属性をメモリに保持するため、入力に応じたメモリが必要です。

| 主なオプション | 既定値 | 用途 |
| --- | --- | --- |
| `--coarse-points` | `8192` | 自動LOD生成時のL0点数の目安上限 |
| `--levels` | 自動 | 最終levelを含むlevel数を固定 |
| `--voxel-edge-ratio` | `2` | 隣接level間のvoxel辺長比 |
| `--row-group-size` | `262144` | Row Groupの最大点数 |
| `--page-row-count` | `8192` | ページの最大行数 |
| `--zstd-level` | `9` | ZSTD圧縮level |

Row Groupはlevel境界を跨ぎません。完了時に点数、level別点数、出力サイズ、bytes/point、変換時間をJSONで出力します。実験用の並び順・encoding指定を含む全オプションは`--help`で確認できます。

## JavaScriptリーダーの使い方

Node.js 24・pnpm 12でワークスペースをセットアップします。`@pointcloud-parquet/browser`はこのリポジトリの`packages/browser`にあります。

```sh
pnpm install
pnpm --filter @pointcloud-parquet/browser build
pnpm serve . 8080
```

ワークスペース内のブラウザアプリから、次のように読み出せます。

```js
import { PointCloudParquet } from "@pointcloud-parquet/browser";

const cloud = await PointCloudParquet.open("http://localhost:8080/points.parquet");
const maxLevel = Math.min(2, cloud.resolutions.length - 1);
const result = await cloud.queryWorld(
  // データのCRSにおける実座標bbox。実際のデータ範囲に合わせて変更する。
  { min: [123000, 456000, 0], max: [123100, 456100, 100] },
  maxLevel, // L0から指定levelまでを累積取得。0なら最も粗い点群。
);

for (const chunk of result.chunks) {
  // XYZはInt32Array、RGBはUint16Array。各配列の長さはchunk.length。
  if (chunk.length === 0) continue;
  const position = cloud.decodePosition({
    x: chunk.x[0], y: chunk.y[0], z: chunk.z[0],
  });
  console.log(chunk.resolution, position, chunk.red[0]);
}
console.log(result.metrics); // 転送bytes、Range数、候補／除外Row Group数、一致点数など
```

`queryWorld`は入力bboxを実座標として受け取りますが、**返すXYZは量子化整数**です。CRS変換は行いません。全精度で読む場合は`cloud.resolutions.length - 1`を指定し、整数bboxには`queryQuantized`を使います。現在のリーダーが返す属性はXYZRGBのみで、RGBのnullは0になります。

リーダーはHyparquetとWASM版ZSTDを使い、Rangeの結合と64 MiBキャッシュを内部で処理します。配信先はHTTP RangeとHEADに対応し、クロスオリジンではCORSを許可して`Content-Length`、`Content-Range`、`Accept-Ranges`を公開してください。

付属ビューアは、Rangeサーバーを起動したまま別ターミナルで`pnpm dev:viewer`を実行すると開けます（既定の入力は`114112.parquet`）。
