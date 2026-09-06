# Point Cloud Parquet PoC

COPCとは異なる物理配置を試すための最小PoCです。LAS/LAZの量子化済みXYZを、加算LODへ分割 → levelごとの3D STR packing → 固定点数Row Group、の順で単一Parquetへ保存します。ブラウザ用パッケージはHyparquetを使い、標準column statisticsで不要なRow Groupを除外しながらHTTP Rangeで読みます。

## 構成

```text
apps/converter/    Rust製 LAS/LAZ → Parquet CLI
apps/viewer/       Three.js製 browser rendering demo
packages/browser/  Hyparquet製 TypeScript Range reader
scripts/           Range対応ローカルサーバーとDuckDBベンチマーク
```

ファイルschemaは空間列に加え、LAS 1.4 point format 0〜10の全標準属性を個別カラムとして保持します。Parquet v2、ZSTD、column statistics有効で出力します。file-level key/value metadataの `point_cloud` にはscale、offset、実座標bounds、LOD境界、voxel edge ratio、CRSをJSONで保存します。CRSはGeoParquet 1.1と同じPROJJSON objectで保存し、未定義の場合は明示的にnullとします。

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

入力point formatに存在しないoptional属性はnullです。`scan_angle` はpoint formatによらず度単位のFloat32へ正規化します。Extra BytesはVLR固有の意味を推測せず、生payloadをpoint単位のbinaryとして保持します。

LODはpoint columnではありません。levelは物理的に連続し、Row Groupがlevel境界を跨がないため、file metadataには各levelのexclusive endだけを `level_row_group_ends` として保存します。配列indexがlevel番号、startは直前のend（L0だけ0）なので一意に復元できます。点がないlevelも直前と同じendを保持し、配列長が完全なvoxel ladderのlevel数を表します。

## セットアップ

Rust 1.85以上、Node.js 24以上、pnpm 12が必要です。DuckDB検証には `duckdb` CLIも必要です。依存パッケージには公開後7日間のcooldownを設定しています。

```sh
pnpm install
cargo build --release --workspace
pnpm build
```

## 変換

```sh
cargo run --release -p pcp-convert -- \
  ./src/*.laz --output points.parquet \
  --coarse-points 8192 \
  --voxel-edge-ratio 2 \
  --row-group-size 262144 \
  --page-row-count 8192 \
  --zstd-level 9
```

resolutionを決定した後、各levelをRow Group容量を葉サイズとする3次元STR（X slab → Y tile → Z order）で独立にpackします。さらに各Row Group内をdata page容量でもう一度3次元STRし、通常の64K / 4K構成では16個の空間的にコンパクトなpageへ分割します。保存するXYZは元のLAS量子化整数のままです。

XYZとintensityには `DELTA_BINARY_PACKED`、GPS timeには `BYTE_STREAM_SPLIT` を明示します。RGBやscan angleなど、実測でdictionaryの方が小さかった列はwriterのdictionary encodingを維持します。全列の後段圧縮はZSTD level 9です。圧縮パラメータの比較根拠と測定条件は [圧縮・ストリーミング比較](benchmarks/compression-study.md) にまとめています。

既定のlayoutは256K Row Group、8K rows/pageです。`--page-order` はnested STRが決めた各data pageの点集合を変えず、page内部だけを `spatial`（既定）、`hilbert`、`source`、`gps-time` のいずれかで並べ替えます。`--intensity-encoding` は `delta`（既定）、`dictionary`、`plain` を比較できます。これらは実験用のknobであり、ブラウザのbbox queryを主用途とする既定値は `spatial` と `delta` です。

voxelは物理空間の立方体として構築します。最細の一辺は3軸の `max(scale)` から導出し、levelを1段粗くしたときの辺長比は `--voxel-edge-ratio`（既定2）で指定します。総level数をN、level番号をrとすると、一辺は `max(scale) * ratio^(N - 1 - r)`、対角長はその `√3` 倍です。`--levels` を省略すると、L0の占有voxel数が `--coarse-points`（既定8192）以下になる最小のratio冪を選びます。最終levelは残点をすべて格納してexactにし、全点は重複も欠落もなくちょうど1 levelへ所属します。

Row Groupは指定点数を上限とし、level境界で必ず終了します。そのため各levelの末尾だけは小さくなります。CLIはlevel別点数、出力サイズ、bytes/point、変換時間をJSONで表示します。

入力には任意の数のLAS/LAZファイルを指定でき、すべてを一つのParquetへまとめます。入力群は同じ座標scale/offset、point format、CRSを持つ必要があります。

既定値は64K点です。ブラウザreaderはquery bboxに完全包含されるRow Groupでは、物理的に連続するXYZRGBを1本のHTTP Rangeへまとめます。bbox境界と交差するRow Groupだけはpage単位で取得します。

各Row Group内はnested STRによる既定4K行のdata pageに分かれ、Page Index/Offset Indexを使ってbbox外のpageを取得前に除外します。

同時に発生した近接Rangeはreader内部でまとめます。既定ではgapが32 KiB以下、結合後が2 MiB以下なら一つのrequestにし、細かなPage Index pruningを保ちながらHTTP request数を抑えます。`PointCloudParquet.open` の `rangeCoalescing` で両上限を変更できます。

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

## COPCとの比較ベンチマーク

同じ元点群から作ったParquetとCOPCを指定すると、同一の5種類の3D bboxでXYZRGBのRange転送量、request数、候補点数、一致点数、decodeを含む時間を比較します。byte rangeはローカルファイルから直接読み、各sampleはcold application cacheで実行し、実行順は交互にします。既定では全点数の25%に最も近い累積点数となるLODを形式ごとに選びます。LOD構造とsamplingは同一ではないため、結果にはParquetの幾何誤差、COPCの公称spacing、実際の一致点数も併記します。

```sh
pnpm benchmark:copc -- 114112.parquet 114112.copc.laz \
  --repeats 3 --warmup 1 --output /tmp/copc-comparison.json
```

`--level` または `--copc-depth` の一方だけを指定した場合、もう一方は累積点数が最も近いLODを選びます。両方を指定すれば完全に固定できます。これはネットワーク遅延を除いたlocal reader比較であり、CDNのRTTやHTTP/2多重化を含む配信性能そのものではありません。

`--range-gap` と `--range-size` でParquet readerのcoalescing値を上書きでき、転送量とrequest数のtrade-offを比較できます。実測結果と判断は [COPC比較レポート](benchmarks/copc-comparison.md) にまとめています。

## ブラウザでレンダリング

Range serverとViteを別々のterminalで起動します。デモはデフォルトで `114112.parquet` を開き、最も粗いL0をRGB表示します。

```sh
pnpm serve . 8080
```

```sh
pnpm dev:viewer
```

表示されたURLをブラウザで開きます。point size、RGB/elevation/LOD色、level/Row Group bboxを変更でき、実際のRange転送量、request数、候補・除外Row Group数、decode時間を画面上で確認できます。各bboxはParquetのXYZ column statisticsから構築します。

`main`へのpush時は `.github/workflows/deploy-pages.yml` がViewerをbuildし、GitHub Pagesへ自動deployします。初回だけrepositoryの **Settings → Pages → Build and deployment → Source** で **GitHub Actions** を選択してください。手動再deployはActions画面の `Deploy demo to GitHub Pages` から実行できます。

LODはデフォルトでRow Group単位に自動選択します。camera frustumとquery bboxの両方に交差するRow Groupだけを候補とし、各levelのvoxel対角長を幾何誤差の上限として、bbox上のカメラ最近点までの距離とvertical FOVからscreen-space error（投影pixel幅）へ変換します。L0を基底として常に読み、閾値を超えた候補をSSEの大きい順にpoint budgetまで追加します。カメラを内包するRow Groupは全levelで必須とし、必要ならpoint budgetを超えて読みます。WorkerがHTTP Range取得・Page Index pruning・ZSTD展開・属性変換・bbox filterを行います。画面の `L0 3/3 · L1 4/12` 表示はlevelごとの選択数です。Page bboxはオンにした時だけXYZのPage Indexから遅延構築します。PageとRow Groupのbboxは未読領域を薄線、現在のqueryで読み込んだ領域を明線で表示します。

現時点の幾何誤差は元のgrid samplingから得られる保守的な上限で、点群から測定したHausdorff誤差ではありません。またRow Group間に親子関係を保存していないため、これはoctree traversalではなく、Parquet statisticsのbboxを使った独立選択です。Automatic LODを無効にするとlevel sliderでL0から指定levelまでを固定表示できます。座標は描画時にdataset中心を引いてからFloat32へ変換するため、大きな測地座標でも表示精度を保ちます。

HyparquetのRange fetch、ZSTD decode、row filter、座標復元、color buffer生成は専用Web Workerで実行します。取得済みの圧縮byte rangeはWorker内の64 MB LRU cacheで再利用し、カメラ移動時は新しく必要になったRow Group/pageだけを転送します。Row Groupは並列に読み、完了した順にposition/color `Float32Array`の所有権をmain threadへ移して即座に描画します。既存のRow Groupは次の選択が揃うまで残し、同じindexだけを差分置換してから不要分を除去するため、LOD更新時に全点群が消えません。対応するbboxも完了時に明表示されます。色変更でもRow Groupごとのbufferを維持し、中間の全点結合や配列sliceは行いません。

Surface表示は同一の取得済みchunkを入力として、四角いpoint spriteを使う`Normal`と`Screen mesh`を切り替えられます。Screen meshは各点を円形にラスタライズした半解像度のpoint depth bufferを隣接gridとしてGPU上で三角形化し、設定値より長い辺をdepth discontinuityとして除去します。これは比較用のview-dependent surfaceであり、world-spaceの永続meshやexport用topologyは生成しません。

Viewer内部ではParquet/Workerを隠すreader、GPU resourceを所有するrenderer、surface構築アルゴリズムであるmeshを別moduleにしています。mesh側はParquetやRow Groupを参照せず、renderer側はqueryとLOD選択を参照しません。

## ブラウザからRange query

ZSTD decodeには `hyparquet-compressors` を同梱しています。ストレージ側は `Range` と `HEAD` に対応し、`Content-Length`, `Content-Range`, `Accept-Ranges` をCORSで公開する必要があります。ローカル確認用サーバーは次で起動できます。

```sh
pnpm serve . 8080
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
pnpm typecheck
pnpm test
```

## PoC上の制約

- 変換時はXYZをメモリに全件保持します。巨大データ向け外部sortは未実装です。
- STRは各resolution内をX/Y/Zの順に分割してRow Group境界へ揃え、各Row Group内でも同じ処理をdata page境界へ適用します。Row Groupとpageの両方でbbox pruningを利用できます。
- STRはRow Groupの3D bbox体積を小さくする一方、特定軸の全域を含む平面的なqueryでは空間曲線より候補数が増える場合があります。比較時は3D boxとXY boxを分けて計測します。
- LOD代表点は座標とlevelから得る決定的ハッシュでvoxel内から選びます。入力順の空間的偏りは避けますが、blue-noise samplingのように点間距離を最適化するものではありません。
- 独自index、VLR/EVLRコンテナの複製、COPC生成/decoderは対象外です。
- `rowGroupsRead` はfooter statisticsから求めた安全側の候補数です。HTTPの物理request数とは `rangeRequests` を区別しています。
