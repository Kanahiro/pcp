# Point Cloud Parquet PoC

COPCとは異なる物理配置を試すための最小PoCです。LAS/LAZの量子化済みXYZを、加算LODへ分割 → levelごとの3D STR packing → 固定点数Row Group、の順で単一Parquetへ保存します。ブラウザ用パッケージはHyparquetを使い、標準column statisticsで不要なRow Groupを除外しながらHTTP Rangeで読みます。

## 構成

```text
apps/converter/    Rust製 LAS/LAZ → Parquet CLI
apps/viewer/       Three.js製 browser rendering demo
packages/browser/  Hyparquet製 TypeScript Range reader
scripts/           Range対応ローカルサーバーとDuckDBベンチマーク
```

ファイルschemaは空間列に加え、LAS 1.4 point format 0〜10の全標準属性を個別カラムとして保持します。Parquet v2、ZSTD、column statistics有効で出力します。file-level key/value metadataの `point_cloud` にscale、offset、実座標bounds、LOD情報、元のpoint format、scan angle scaleをJSONで保存します。

現在の `point_cloud.version` は `0.1.0` です。

```text
x, y, z, red, green, blue,
intensity, return_number, number_of_returns,
scan_direction_flag, edge_of_flight_line,
classification, synthetic, key_point, withheld, overlap,
scanner_channel, scan_angle, user_data, point_source_id,
gps_time, nir,
wave_packet_descriptor_index, waveform_data_offset,
waveform_packet_size, return_point_waveform_location,
waveform_x_t, waveform_y_t, waveform_z_t,
extra_bytes
```

入力point formatに存在しないoptional属性はnullです。`scan_angle` は圧縮比較のためLAS生整数を保持し、実角度はmetadataの `source_las.scan_angle_scale` を掛けて復元します。Extra BytesはVLR固有の意味を推測せず、生payloadをpoint単位のbinaryとして保持します。

LODはpoint columnではありません。levelは物理的に連続し、Row Groupがlevel境界を跨がないため、file metadataには各levelのexclusive endだけを `level_row_group_ends` として保存します。配列indexがlevel番号、startは直前のend（L0だけ0）なので一意に復元できます。

## セットアップ

Rust 1.85以上、Node.js 22以上、npmが必要です。DuckDB検証には `duckdb` CLIも必要です。

```sh
npm install
cargo build --release --workspace
npm run build
```

## 変換

```sh
cargo run --release -p pcp-convert -- \
  input.laz points.parquet \
  --coarse-points 8192 \
  --row-group-size 65536 \
  --page-row-count 8192 \
  --zstd-level 3
```

resolutionを決定した後、各levelをRow Group容量を葉サイズとする3次元STR（X slab → Y tile → Z order）で独立にpackします。保存するXYZは元のLAS量子化整数のままです。

XYZとintensityには `DELTA_BINARY_PACKED`、GPS timeには `BYTE_STREAM_SPLIT` を明示します。RGBやscan angleなど、実測でdictionaryの方が小さかった列はwriterのdictionary encodingを維持します。全列の後段圧縮はZSTDです。

`--base-voxel-size` は入力と同じ実座標単位（通常はm）です。省略時はLASの3軸scaleの最大値を最細候補に使います。`--levels` も省略すると、L0の占有voxel数が `--coarse-points`（既定8192）以下になる最小の2のべき乗voxelを選び、辺長をlevelごとに1/2へ下げます。したがって巨大なroot voxelの1点から始めず、最初の表示に使える数千点から開始できます。各voxelで入力順の最初の未採用点を選び、全点は重複も欠落もなくちょうど1 levelへ所属します。比較実験ではこれらのoptionを明示してladderを固定できます。

Row Groupは指定点数を上限とし、level境界で必ず終了します。そのため各levelの末尾だけは小さくなります。CLIはlevel別点数、出力サイズ、bytes/point、変換時間をJSONで表示します。

既定値は64K点です。ブラウザreaderはquery bboxに完全包含されるRow Groupでは、物理的に連続するXYZRGBを1本のHTTP Rangeへまとめます。bbox境界と交差するRow Groupだけはpage単位で取得します。

各Row Group内は既定8K行のdata pageに分かれ、Page Index/Offset Indexを使ってbbox外のpageを取得前に除外します。

## DuckDBでpruningを確認

量子化整数のbboxを指定します。

```sh
node scripts/benchmark-duckdb.mjs \
  points.parquet \
  1000 2000 3000 4000 0 500 2 \
  optional-reference.copc.laz
```

出力にはfile size、bytes/point、full scan、bbox一致点数、statistics上の候補/除外Row Group数が含まれます。最後のCOPC引数は任意で、指定するとファイルサイズも並べます。DuckDB本体のoptimizerが実際にfilter pushdownを行うことは次でも確認できます。

```sql
EXPLAIN ANALYZE
SELECT * FROM 'points.parquet'
WHERE x BETWEEN 1000 AND 2000
  AND y BETWEEN 3000 AND 4000
  AND z BETWEEN 0 AND 500;
```

LOD範囲は汎用SQL column filterではなく、`point_cloud.level_row_group_ends` が示す物理Row Group範囲で選択します。`scripts/benchmark-duckdb.mjs` はmetadataからL0〜指定levelの行prefixとRow Group終端を読み取って計測します。

## ブラウザでレンダリング

Range serverとViteを別々のterminalで起動します。デモはデフォルトで `114112.parquet` を開き、最も粗いL0をRGB表示します。

```sh
npm run serve -- . 8080
```

```sh
npm run dev:viewer
```

表示されたURLをブラウザで開きます。point size、RGB/elevation/LOD色、level/Row Group bboxを変更でき、実際のRange転送量、request数、候補・除外Row Group数、decode時間を画面上で確認できます。各bboxはParquetのXYZ column statisticsから構築します。

LODはデフォルトでRow Group単位に自動選択します。各levelのvoxel対角長を幾何誤差の上限とし、各Row Groupのbboxまでのカメラ距離とvertical FOVからscreen-space error（投影pixel幅）へ変換します。L0を基底として常に読み、閾値を超えた候補をSSEの大きい順にpoint budgetまで追加します。カメラを内包するRow Groupは全levelで必須とし、必要ならpoint budgetを超えて読みます。WorkerがHTTP Range取得・Page Index pruning・ZSTD展開・属性変換・bbox filterを行います。画面の `L0 3/3 · L1 4/12` 表示はlevelごとの選択数です。Row Group bboxは全boxを単一LineSegmentsへ集約し、選択中の領域を別の明線で表示します。

現時点の幾何誤差は元のgrid samplingから得られる保守的な上限で、点群から測定したHausdorff誤差ではありません。またRow Group間に親子関係を保存していないため、これはoctree traversalではなく、Parquet statisticsのbboxを使った独立選択です。Automatic LODを無効にするとlevel sliderでL0から指定levelまでを固定表示できます。座標は描画時にdataset中心を引いてからFloat32へ変換するため、大きな測地座標でも表示精度を保ちます。

HyparquetのRange fetch、ZSTD decode、row filter、座標復元、color buffer生成は専用Web Workerで実行します。取得済みの圧縮byte rangeはWorker内の64 MB LRU cacheで再利用し、カメラ移動時は新しく必要になったRow Group/pageだけを転送します。Row Groupは並列に読み、完了した順にposition/color `Float32Array`の所有権をmain threadへ移して即座に描画します。既存のRow Groupは次の選択が揃うまで残し、同じindexだけを差分置換してから不要分を除去するため、LOD更新時に全点群が消えません。対応するbboxも完了時に明表示されます。色変更でもRow Groupごとのbufferを維持し、中間の全点結合や配列sliceは行いません。

## ブラウザからRange query

ZSTD decodeには `hyparquet-compressors` を同梱しています。ストレージ側は `Range` と `HEAD` に対応し、`Content-Length`, `Content-Range`, `Accept-Ranges` をCORSで公開する必要があります。ローカル確認用サーバーは次で起動できます。

```sh
npm run serve -- . 8080
```

```ts
import { PointCloudParquet } from "@pointcloud-parquet/browser";

const cloud = await PointCloudParquet.open("http://localhost:8080/points.parquet");
const result = await cloud.queryWorld(
  { min: [123000, 456000, 0], max: [123100, 456100, 100] },
  2,
);

console.log(result.points);
console.log(result.metrics);
// bytesFetched, rangeRequests, rowGroupsRead/Pruned,
// pointsInCandidateRowGroups, pointsMatched, elapsedMs
```

整数bboxを既に持つ場合は `queryQuantized` を使います。返却点は量子化整数のままで、必要な点だけ `decodePosition` に渡して実座標へ戻せます。`metadataBytesFetched` はopen時のfooter取得量、各queryの `bytesFetched` はそのquery中に実際に返ったRange bodyの合計です（同一範囲の再取得も加算）。

## 検証

```sh
cargo test --workspace
npm run typecheck
npm test
```

## PoC上の制約

- 変換時はXYZをメモリに全件保持します。巨大データ向け外部sortは未実装です。
- STRは各resolution内をX/Y/Zの順に再帰分割し、Row Group境界へ揃えます。空間領域を直接packするため、Row Groupのbbox pruningを主目的にできます。
- STRはRow Groupの3D bbox体積を小さくする一方、特定軸の全域を含む平面的なqueryでは空間曲線より候補数が増える場合があります。比較時は3D boxとXY boxを分けて計測します。
- LOD代表点は入力順に依存します。見た目や密度を最適化するアルゴリズムではありません。
- 独自index、VLR/EVLRコンテナの複製、COPC生成/decoderは対象外です。
- `rowGroupsRead` はfooter statisticsから求めた安全側の候補数です。HTTPの物理request数とは `rangeRequests` を区別しています。
