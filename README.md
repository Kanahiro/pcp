# Point Cloud Parquet PoC

LAS/LAZ点群を、段階的な詳細表示（LOD）と3次元bboxによる部分取得ができる単一Parquetファイルへ変換する実験プロジェクトです。Rust製コンバータ、JavaScriptリーダー、Three.js製ビューアを含みます。

元の量子化整数XYZと点属性を列として保存し、ブラウザでは必要なXYZRGBだけをHTTP Rangeで取得します。通常のParquetとしてDuckDBなどからも読み出せます。

## COPCと比べて何がうれしいか

主に狙っているのは、**表示に必要な範囲・属性を少ない転送量で読み、短時間で点群を取り出すこと**です。実ブラウザで通信・処理・描画までを計測し、通信を除いた処理時間も別途測定しています。

### 実配信先から通信・描画まで

2026-09-14、指定された`cogp-demo.spatialty.io/temp/`のParquet／COPCを、Chromium 152・Apple M5 Proで測定しました。初回メタデータ取得を含む通信・処理・GPU描画後の次フレームまで、各queryでwarmup 1回・計測3回です。

| query | Parquet | COPC |
| --- | ---: | ---: |
| cube | 578.1 ms | 1,180.8 ms |
| thin-x | 496.8 ms | 998.0 ms |
| thin-y | 613.8 ms | 1,013.9 ms |
| thin-z | 732.5 ms | 1,455.8 ms |
| large | 991.0 ms | 1,604.7 ms |
| **各queryの中央値の合計** | **3,412.2 ms** | **6,253.2 ms** |

この条件ではParquetが**45.4%短い**結果でした。取得body量はParquet 38.2 MB／COPC 81.4 MBです。点群取得は`cache: no-store`、モジュール・WASM・接続は再利用され得ます。ページ自体の初回ダウンロードと物理的な画面表示時刻は計測外です。

配信先はcurlでHTTP/2応答を確認しましたが、`Timing-Allow-Origin`がないためブラウザの`nextHopProtocol`は全件空でした。**ブラウザでHTTP/2を使用したと確定できる測定ではありません。** 実回線の待ち時間は含みますが、人工的な100 ms遅延や帯域制限は加えていません。過去のローカル測定とは配信先・回線・TLSなども異なり、差をHTTP/2だけの効果として解釈できません。

[全試行JSON](benchmarks/copc-comparison-browser-e2e-remote-20260914.json)・[区間別の値と条件](benchmarks/copc-comparison.md#実配信先から通信描画まで)

### 実ブラウザで通信から描画まで（ローカルHTTP）

2026-09-14、Chromium 152・Apple M5 Proで、**新しいWorker／WebGLコンテキストの起動前から、HTTP通信・展開・色変換・Worker間転送・GPU描画を経て、次のフレーム境界まで**を測定しました。両形式はビューア共通の色変換と点描画シェーダーを使います。

| query | Parquet | COPC |
| --- | ---: | ---: |
| cube | 179.6 ms | 597.5 ms |
| thin-x | 129.3 ms | 430.4 ms |
| thin-y | 165.0 ms | 447.8 ms |
| thin-z | 309.0 ms | 880.7 ms |
| large | 424.2 ms | 959.5 ms |
| **各queryの中央値の合計** | **1,207.1 ms** | **3,315.9 ms** |

各query・形式について、**全体時間が中央値となった実際の試行**を選び、その試行の区間時間を集計した内訳です。区間ごとに独立した中央値を取った値ではなく、丸め前の区間合計は全体時間と一致します。

| 区間（5 query合計） | Parquet | COPC |
| --- | ---: | ---: |
| 起動・初期化・転送等（残差） | 101.8 ms | 123.8 ms |
| メタデータ取得・解析 | 33.3 ms | 18.1 ms |
| 点データ通信・展開・bbox判定・XYZRGB生成 | 974.0 ms | 3071.2 ms |
| 描画用バッファ生成・色変換 | 48.0 ms | 52.4 ms |
| scene準備・描画開始フレーム待ち | 1.5 ms | 1.6 ms |
| 描画命令・GPU転送・GPU完了待ち | 26.2 ms | 25.3 ms |
| GPU完了後の次フレーム待ち | 22.3 ms | 23.5 ms |
| **全体** | **1,207.1 ms** | **3,315.9 ms** |

通信と展開はまとめて計測しています。起動・初期化・転送等は残差です。[区間の定義・query別の内訳](benchmarks/copc-comparison.md#全区間測定の区間別内訳)も保存しています。

この条件ではParquetが**63.6%短い**結果でした。warmup 1回・計測3回、描画サイズ960×540、点群データのHTTPキャッシュは無効です。ローカルHTTP/1.1で、追加遅延・帯域制限なし。**実回線やHTTP/2・HTTP/3での結果ではありません。**

GPU完了は`gl.finish()`で待ち、その後の`requestAnimationFrame`までを記録しています。ブラウザの合成処理やディスプレイへの実表示時刻を直接測った値ではありません。ベンチマークページ自体の初回ダウンロードは計測外で、モジュール・WASMのHTTPキャッシュや接続は再利用され得ます。各queryは独立した範囲ロードで、全点群の一括ロード時間ではありません。[全試行・通信情報のJSON](benchmarks/copc-comparison-browser-e2e-20260914.json)・[計測区間と再実行方法](benchmarks/copc-comparison.md#ブラウザの通信からgpu描画まで)

### 実ブラウザ＋応答遅延100 ms＋描画

同じブラウザ・描画条件で、点群サーバーの**各HEAD／Range応答前に100 ms**の待ち時間を加えました。通信からGPU完了後の次フレームまで、warmup 1回・計測3回です。

| query | Parquet | COPC |
| --- | ---: | ---: |
| cube | 1294.3 ms | 1147.1 ms |
| thin-x | 996.1 ms | 962.5 ms |
| thin-y | 1913.7 ms | 998.7 ms |
| thin-z | 1513.1 ms | 1441.0 ms |
| large | 1021.8 ms | 1522.0 ms |
| **各queryの中央値の合計** | **6,739.0 ms** | **6,071.3 ms** |

この条件では**Parquetが11.0%遅い**結果でした。5 query中4つでCOPCが速く、largeではParquetが速い。取得body量は38.2 MB／81.4 MBのままですが、取得量の少なさが必ずしもロード時間の短さにつながりません。

ブラウザの通常の接続管理を使い、Resource TimingでHTTP/1.1を確認しました。帯域制限はなく、HTTP/2・HTTP/3や実回線の再現ではありません。WASM・ページ配信サーバーには遅延を加えていません。遅延なしの測定とは別実行なので、区間内訳は各実行内で集計します。[測定JSON](benchmarks/copc-comparison-browser-e2e-delay100-20260914.json)・[区間別の値と再実行方法](benchmarks/copc-comparison.md#実ブラウザ応答遅延100-ms描画)

### ブラウザ内の読み取り・展開時間（open込み、通信なし）

2026-09-14、Chromium 152（Codex内蔵ブラウザ）・Apple M5 Proで、約719万点のデータに対する5種類のXYZRGB bbox queryを測定しました。点群ファイルを事前にメモリへ取得し、**メタデータの読み取り・解析開始から、展開・bbox判定・XYZRGBのTypedArray生成完了まで**をWorker内で計測しています。

| query | Parquet | COPC |
| --- | ---: | ---: |
| cube | 104.6 ms | 532.7 ms |
| thin-x | 67.5 ms | 374.0 ms |
| thin-y | 101.1 ms | 391.1 ms |
| thin-z | 213.1 ms | 791.9 ms |
| large | 315.7 ms | 816.6 ms |
| **各queryの中央値の合計** | **802.0 ms** | **2,906.3 ms** |

この実装・データではParquetが**72.4%短い**結果でした。warmup 1回・計測5回、形式の実行順を交互にし、各試行でリーダーを作り直しています。両形式とも量子化XYZ（Int32）とRGB（UInt16）の配列を生成します。COPCは1つのWorkerで4つのlaz-perfインスタンスを使用し、4つのCPUスレッドで並列展開する構成ではありません。

通信・ファイルI/O・デコーダー初期起動・Workerからメインスレッドへの点データ転送・GPU描画は含みません。メモリコピーや配列確保は含むため、純粋なCPU時間でも、画面に点群が表示されるまでの時間でもありません。[各試行の測定JSON](benchmarks/copc-comparison-browser-memory-20260914.json)・[ブラウザでの再実行方法](benchmarks/copc-comparison.md#ブラウザworkerでの処理時間通信なし)

### 取得量と通信条件

同じqueryで必要になったメタデータ込みの読み取り量は **Parquet 38.2 MB／COPC 81.4 MB（53.1%削減）**でした。ブラウザ内実験ではこれはメモリから取り出したRangeの量です。既存のHTTP実験でも同じbody取得量を確認しています。5つの独立した範囲ロードの合計で、全点群の一括ロードではありません。

| 指標 | Parquet | COPC |
| --- | ---: | ---: |
| query部分のRange数（openを除く、5 query合計） | 283 | 54 |
| open時のメタデータ取得量（1 queryあたり） | 524 KB | 77 KB |
| 保存ファイルサイズ | 105.2 MB | 88.8 MB |

**実配信先での測定は上記の通りですが、ブラウザのHTTP/2・HTTP/3使用は未確認です。** 補足として、Node.jsのHTTP/1.1・各応答100 ms遅延の実験では、上限なしでParquet 3,161 ms／COPC 5,764 ms、6接続では6,643 ms／5,844 msと逆転しました。これは並列性への感度を調べた結果で、実ブラウザの通信性能を表すものではありません。[HTTP実験の条件・結果](benchmarks/copc-comparison.md#http通信接続数上限を含めた計測方法)

取得量を減らす仕組みは、必要なXYZRGB列だけを選び、Row Group統計とPage Indexでbbox外の領域を2段階で除外することです。読み取り側は列を直接TypedArrayへ取り出し、WASM ZSTDで展開します。速度差は保存形式だけでなく、リーダー実装も含む結果です。

比較対象のParquetは262,144点／Row Group・8,192行／ページのspatial配置です。ParquetのL0〜4（累積2,039,852点）とCOPCのdepth 0〜2（累積1,903,684点）を比較し、query一致点数の合計はParquet側が7.4%多くなっています。samplingと空間解像度は完全一致ではなく、1データセット・1ブラウザでの結果です。過去のNode.js測定は[詳細資料](benchmarks/copc-comparison.md)に残しますが、異なる実行条件間の時間差を性能改善としては扱いません。

[COPC（Cloud Optimized Point Cloud）](https://copc.io/)と同様に、単一ファイルからHTTP Rangeで空間部分取得と段階的な詳細表示ができます。その上で、用途ごとの利点と制約は次の通りです。

| 観点 | このプロジェクトの利点 | COPCに対する制約 |
| --- | --- | --- |
| 部分取得・表示 | 上記の比較では読み取り量を削減し、ブラウザ内処理時間も短縮 | Range数と初期メタデータ取得量は多い。100 ms遅延・6接続の実験ではCOPCより13.7%遅い |
| 分析・属性選択 | 通常のParquetとしてDuckDBなどから必要列だけを分析できる | 既存のCOPCリーダーでは読めず、座標復元とLODには独自メタデータの解釈が必要 |
| 空間構造・LOD | LOD境界とParquet標準統計で構成でき、専用のoctreeインデックスが不要 | COPCのような親子関係を辿る階層探索はできず、Row GroupごとにbboxとLODを判定する |
| 保存・互換性 | 列ごとにencodingを選び、空間配置とZSTDを組み合わせられる | 上記のファイルはCOPCより18.4%大きい。VLR/EVLRも複製しないため、LAS固有メタデータの保持に制約がある |

COPCのLAZ 1.4も属性選択に対応しており、「COPCでは常に全属性の取得・展開が必要」という比較ではありません。

## 新規性・設計の特徴

このPoCで試しているのは、**加算LOD・2段階の3D STR配置・Parquet標準の統計／Page Indexを組み合わせた点群ストリーミング**です。

1. **加算LOD**：voxel内の代表点を粗いlevelへ割り当て、残りを細かいlevelへ保存します。各点は一つのlevelにだけ所属し、L0から最終levelまで読むと全点が揃います。
2. **2段階の空間配置**：各levelを3D STR（Sort-Tile-Recursive）でRow Groupへ詰め、さらに各Row Group内をページ単位で同様に配置します。
3. **標準インデックスで部分取得**：XYZのmin/max統計でRow Groupを、Page Indexでページを絞り込みます。専用の空間インデックスや別ファイルは不要です。

LODは連続したRow Groupの範囲として記録するため、点ごとのLOD列やoctreeの親子関係は持ちません。各手法そのものの発明ではなく、点群向けの保存配置と読み出しの組み合わせを検証するPoCです。

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
