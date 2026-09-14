# PCP / COPC reader benchmark

測定日・実行条件が異なる結果の時間差を、open追加や接続数変更の効果として扱わない。9/8と9/14は別実行であり、9/14の方が小さい理由は特定していない。openの内訳は同じ試行の値で確認する。READMEの主な処理速度比較は以下のブラウザ内測定を使用する。Node.js結果は別条件の履歴として扱う。

## 実配信先から通信・描画まで

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

区間内訳は各query・形式で全体時間が中央値となる実際の試行から集計したものです。通信と展開は分離していません。

| 区間（5 query合計） | Parquet | COPC |
| --- | ---: | ---: |
| 起動・初期化・転送等（dataReadyMs − loadElapsedMs − bufferBuildMsの残差） | 106.1 ms | 127.3 ms |
| メタデータ取得・解析（Parquetのdecoder初期化も含む） | 787.8 ms | 1,636.3 ms |
| 点データ通信・展開・bbox判定・XYZRGB配列生成 | 2,408.6 ms | 4,380.5 ms |
| 描画用バッファ生成・色変換 | 51.1 ms | 53.7 ms |
| メインスレッドのscene準備・描画開始フレーム待ち | 1.6 ms | 1.4 ms |
| 描画命令・GPU転送・GPU完了待ち | 26.9 ms | 25.1 ms |
| GPU完了後の次フレーム待ち | 30.1 ms | 28.9 ms |

全30試行で過去の測定と取得body量・Range数・HEAD数・一致点数・描画点数が一致し、非背景ピクセルと累積時刻の順序を検証しました。取得量にはHTTPヘッダーやTLSの通信量を含みません。

[全試行JSON](copc-comparison-browser-e2e-remote-20260914.json)・[query別・全試行の区間JSON](copc-comparison-browser-e2e-remote-phases-20260914.json)。プロトコル・サーバー設定の不明値はJSONで`null`として記録しています。

再実行は下記のVite測定ページを開き、入力を次のURLに変更します。ローカルRangeサーバーは不要です。

- `https://cogp-demo.spatialty.io/temp/114112.parquet`
- `https://cogp-demo.spatialty.io/temp/114112.copc.laz`

外部配信先の結果は`-remote`付きファイルに保存され、ローカル結果を上書きしません。同日・同プロトコル・同遅延の外部配信測定は上書きします。

```sh
node scripts/summarize-browser-e2e.mjs benchmarks/copc-comparison-browser-e2e-remote-20260914.json benchmarks/copc-comparison-browser-e2e-remote-phases-20260914.json
```

## ブラウザの通信からGPU描画まで

2026-09-14、Chromium 152（Codex内蔵ブラウザ）、Apple M5 Pro、ANGLE Metal。点群はローカルRangeサーバーから取得し、Resource Timingでも全データ要求が`http/1.1`であることを確認した。追加応答遅延0 ms・帯域制限なし。点群データは`cache: no-store`、サーバーも`Cache-Control: no-store`を返す。各試行で新しいWorker・デコーダーインスタンス・WebGLコンテキストを生成する。モジュール・WASMのHTTPキャッシュ、JIT、OSキャッシュ、HTTP接続は消去しない。

計測開始はメインスレッドの`new Worker`直前。開始からの累積時間を3地点で保存する:

- `dataReadyMs`: HTTP HEAD／メタデータ／点群取得、展開、bbox判定、XYZRGB配列生成、ビューア共通のRGB変換を終え、転送可能バッファがメインスレッドに届いた時点。WebGLコンテキスト初期化はこの区間に重なる。
- `gpuCompleteMs`: geometry・shader準備、GPU転送、描画を行い、`gl.finish()`でGPU完了を待った時点。
- `frameBoundaryMs`: その後の次の`requestAnimationFrame`。表示の機会まで待つ指標で、compositorや物理的なscan-outを観測した値ではない。

warmup 1回・計測3回、各query内で形式の実行順を交互にした。`frameBoundaryMs`の中央値:

| query | Parquet | COPC |
| --- | ---: | ---: |
| cube | 179.6 ms | 597.5 ms |
| thin-x | 129.3 ms | 430.4 ms |
| thin-y | 165.0 ms | 447.8 ms |
| thin-z | 309.0 ms | 880.7 ms |
| large | 424.2 ms | 959.5 ms |
| **合計（丸め前から集計）** | **1,207.1 ms** | **3,315.9 ms** |

Parquetが63.6%短い。各queryの中央値の合計は、メインスレッドへのデータ到着が1,160.3／3,267.5 ms、GPU完了が1,188.1／3,293.7 ms。個別に求めた中央値は単純加算で分解せず、内訳を見る場合は同じ試行の値を使う。`renderAndGpuMs`はrender呼び出しからGPU完了までだけの時間。`decoderInitMs`はCOPCの明示的な初期化区間で、Parquetのdecoder初期化はopen／load区間に含む。

表示は960×540・DPR 1・antialiasなし・点サイズ1。両形式で既存ビューアの`buildPointBuffers`と`QuantizedPointMaterial`を再利用し、同じqueryから決めたカメラを使う。全chunk到着後にまとめて描画し、段階的表示やスクリーンスペースメッシュは使わない。COPCは1つのWorkerに4つのlaz-perfインスタンスを置く。背景タブになった試行はエラーにする。

全30試行で取得バイト数と点数を既存結果と照合し、描画点数の一致、WebGLエラーなし、背景以外のピクセルが存在することを検証した。ピクセル検査は計測終了後。`preserveDrawingBuffer: true`はこの検査のために両形式で共通に使用する。実際の点群描画もブラウザの画面で確認した。

[生の測定JSON（全試行・各HTTP要求のResource Timingを含む）](copc-comparison-browser-e2e-20260914.json)。この実験では実ブラウザHTTP/2・HTTP/3、帯域制限、実回線、初回ページダウンロードからのcold startupは検証していない。過去のメモリ内／Node.js計測とは独立した条件の結果であり、数字の差を通信や描画の追加コストとして扱わない。

再実行（リポジトリ直下で、サーバーは別ターミナル）:

```sh
node scripts/range-server.mjs . 18080 0
```

```sh
pnpm --filter @pointcloud-parquet/browser build
pnpm --filter @pointcloud-parquet/viewer exec vite --config ../../scripts/browser-benchmark/vite.config.mjs
```

`http://127.0.0.1:18081/scripts/browser-benchmark/end-to-end.html`を開いて「全区間を測定」を押す。タブを表示したまま完了を待つ。JSONは日付付きで`benchmarks`へ保存される（同日の再実行は上書き）。入力URLを変更する場合も、このquery・LOD・期待点数に対応する同じ入力データを用意し、HTTP Range・CORS・Content-Lengthに対応させる。Resource Timingの詳細を取得するには`Timing-Allow-Origin`も必要。

### 全区間測定の区間別内訳

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

「起動・初期化・転送等」はデータ到着までの時間からload・バッファ生成時間を引いた残差で、各処理を個別に計時した値ではありません。COPCの明示的なdecoder初期化はこの残差、Parquetのdecoder初期化はopen側に含まれます。WebGL初期化はWorker処理と並行するため、独立した加算区間にしていません。通信と展開も重なるため、通信単独／展開単独の時間には分離していません。

各セルは **Parquet / COPC**、単位はmsです。各列で同じ試行の内訳を使います。

| 区間 | cube | thin-x | thin-y | thin-z | large |
| --- | ---: | ---: | ---: | ---: | ---: |
| 起動・初期化・転送等（残差） | 20.0 / 24.3 | 21.5 / 24.8 | 19.3 / 24.2 | 20.5 / 25.5 | 20.5 / 25.0 |
| メタデータ取得・解析 | 6.7 / 4.0 | 6.7 / 3.1 | 6.5 / 3.7 | 6.6 / 3.5 | 6.8 / 3.8 |
| 点データ通信・展開・bbox判定・XYZRGB生成 | 135.8 / 554.9 | 97.2 / 390.8 | 134.7 / 410.8 | 253.5 / 829.8 | 352.8 / 884.9 |
| 描画用バッファ生成・色変換 | 4.5 / 4.2 | 1.7 / 1.8 | 2.0 / 2.1 | 12.4 / 11.8 | 27.4 / 32.5 |
| scene準備・描画開始フレーム待ち | 0.4 / 0.3 | 0.2 / 0.2 | 0.2 / 0.3 | 0.4 / 0.4 | 0.3 / 0.4 |
| 描画命令・GPU転送・GPU完了待ち | 2.7 / 2.5 | 1.9 / 2.1 | 2.2 / 1.7 | 5.9 / 6.2 | 13.5 / 12.8 |
| GPU完了後の次フレーム待ち | 9.5 / 7.3 | 0.1 / 7.6 | 0.1 / 5.0 | 9.7 / 3.5 | 2.9 / 0.1 |
| **全体** | 179.6 / 597.5 | 129.3 / 430.4 | 165.0 / 447.8 | 309.0 / 880.7 | 424.2 / 959.5 |

[区間別JSON](copc-comparison-browser-e2e-phases-20260914.json)に、選んだ試行のindex（0始まり）と全30試行の区間値を保存しています。再集計は次のコマンドで行います。入力の測定JSONは変更しません。

```sh
node scripts/summarize-browser-e2e.mjs \
  benchmarks/copc-comparison-browser-e2e-20260914.json \
  benchmarks/copc-comparison-browser-e2e-phases-20260914.json
```

## 実ブラウザ＋応答遅延100 ms＋描画

2026-09-14、Chromium 152・Apple M5 Pro。ローカル点群サーバーをポート18082で起動し、HEADとRangeの各応答前に100 ms待機させた。描画条件・計測区間は上記の遅延なし全区間ベンチと同じ（960×540、DPR 1、点サイズ1、warmup 1回・計測3回）。Worker・WebGL・decoderは各試行で新規生成。点群データはHTTPキャッシュなし、WASM・ページ配信への追加遅延はなし。ブラウザの接続管理に上書きは加えない。

| query | Parquet | COPC |
| --- | ---: | ---: |
| cube | 1294.3 ms | 1147.1 ms |
| thin-x | 996.1 ms | 962.5 ms |
| thin-y | 1913.7 ms | 998.7 ms |
| thin-z | 1513.1 ms | 1441.0 ms |
| large | 1021.8 ms | 1522.0 ms |
| **各queryの中央値の合計** | **6,739.0 ms** | **6,071.3 ms** |

Parquetが11.0%遅い。5 query中4つでCOPCが速く、largeではParquetが速い。取得量はParquet 38.2 MB／COPC 81.4 MBで、遅延なしの全試行と一致した。保存したResource TimingはすべてHTTP/1.1、記録された各要求のdurationは最小でも100.3 ms。サーバーの`X-Benchmark-Response-Delay-Ms`ヘッダーから、設定値100も各試行とenvironmentに記録した。

全30試行で取得点数・body量・Range数・HEAD数・描画点数を遅延なしの結果と照合し、WebGLエラーなし・非背景ピクセルあり・累積時刻の順序を検証した。

### 100 ms遅延条件の区間別内訳

各query・形式で全体時間が中央値となった実際の試行を選び、その同じ試行の内訳を合計した。独立した区間中央値の合計ではない。

| 区間（5 query合計） | Parquet | COPC |
| --- | ---: | ---: |
| 起動・初期化・転送等（残差） | 117.5 ms | 125.9 ms |
| メタデータ取得・解析 | 1076.9 ms | 2074.7 ms |
| 点データ通信・展開・bbox判定・XYZRGB生成 | 5423.3 ms | 3767.0 ms |
| 描画用バッファ生成・色変換 | 58.0 ms | 48.6 ms |
| scene準備・描画開始フレーム待ち | 1.6 ms | 1.5 ms |
| 描画命令・GPU転送・GPU完了待ち | 28.8 ms | 23.7 ms |
| GPU完了後の次フレーム待ち | 32.9 ms | 29.9 ms |
| **全体** | **6,739.0 ms** | **6,071.3 ms** |

この内訳ではParquetのopenはCOPCより短いが、点データ通信・展開区間は長い。通信とCPU処理が重なるため、この区間の数字を通信時間だけ／展開時間だけとは解釈しない。遅延なしとの比較は別実行であり、その差を厳密な追加待ち時間として扱わない。

[全試行・HTTP要求のJSON](copc-comparison-browser-e2e-delay100-20260914.json)・[全試行の区間別JSON](copc-comparison-browser-e2e-delay100-phases-20260914.json)。帯域制限、HTTP/2・HTTP/3、実回線での計測ではない。

再実行は上記Viteサーバーに加え、別ターミナルで次を起動する:

```sh
node scripts/range-server.mjs . 18082 100
```

`http://127.0.0.1:18081/scripts/browser-benchmark/end-to-end.html`を開き、入力を`http://127.0.0.1:18082/114112.parquet`と`http://127.0.0.1:18082/114112.copc.laz`へ変更して実行する。結果は`-delay100-日付.json`として保存され、遅延なしのファイルを上書きしない。同じ日・同じ遅延での再実行は上書きする。

```sh
node scripts/summarize-browser-e2e.mjs \
  benchmarks/copc-comparison-browser-e2e-delay100-20260914.json \
  benchmarks/copc-comparison-browser-e2e-delay100-phases-20260914.json
```

## ブラウザWorkerでの処理時間（通信なし）

2026-09-14、Apple M5 Pro、Chromium 152（Codex内蔵ブラウザのUAはJSONに記録）。5 queryについてwarmup 1回・計測5回、実行順を交互にした。ブラウザからファイルを事前に全量取得し、各試行では新しいリーダーで不変のArrayBufferを読む。各Rangeはコピーして返す。計測はメタデータの読み取り・解析開始からXYZRGB配列生成完了まで。

| query | Parquet | COPC |
| --- | ---: | ---: |
| cube | 104.6 ms | 532.7 ms |
| thin-x | 67.5 ms | 374.0 ms |
| thin-y | 101.1 ms | 391.1 ms |
| thin-z | 213.1 ms | 791.9 ms |
| large | 315.7 ms | 816.6 ms |
| **各queryの中央値の合計** | **802.0 ms** | **2,906.3 ms** |

Parquetが72.4%短い。各形式の全試行で、点数と読み取ったバイト数が既存の同一queryの結果に一致し、出力が1点あたり18 bytes（Int32 XYZ + UInt16 RGB）であることを検証した。これは点数・サイズ検証であり、全属性値の一致検証ではない。

Node.js版のCOPCはRGBをchecksumに集計するだけだったが、ブラウザ版は一致点のXYZRGB配列を確保・格納し、余剰容量を切り詰めて保持する。Parquetも結果の列配列を生成する。出力型は揃えたが、allocationやgetterの実装は異なる。COPC側は1つのWorker内の4つのlaz-perfインスタンスで、CPUの4スレッド並列ではない。

通信、ディスクI/O、入力全量の事前取得、モジュール／デコーダー初期起動、Workerからメインスレッドへの点データ転送、GPU転送・描画は計測外。WASMはwarmup後で、GCを強制せず、メモリコピー・配列確保を含む。実ブラウザでのHTTP/2・HTTP/3による通信込み性能は、この実験では検証していない。

[生の測定JSON](copc-comparison-browser-memory-20260914.json)。再実行（リポジトリ直下に`114112.parquet`と`114112.copc.laz`が必要）:

```sh
pnpm --filter @pointcloud-parquet/browser build
pnpm --filter @pointcloud-parquet/viewer exec vite --config ../../scripts/browser-benchmark/vite.config.mjs
```

ブラウザで`http://127.0.0.1:18081/scripts/browser-benchmark/index.html`を開き「比較を実行」を押す。完了後に測定JSONを保存できる。queryと期待点数は`copc-comparison-load-20260914.json`を参照するため、このページは同一入力の再測定用である。

## HTTP通信・接続数上限を含めた計測方法

ベンチマークの入力にHTTP(S) URLを渡すと、実際のHTTP Rangeで取得する。`loadElapsedMs`には通信待ちとレスポンスbodyの受信を含む。Parquetは各試行のopenでHEADから開始し、COPCはヘッダーと階層のRange取得から開始する。比較条件を決める事前探索は計測外で、HTTP接続は再利用され得るため、DNS・TCP・TLSの初回接続からの測定ではない。

`--http-connections N`でオリジンあたりのHTTP/1.1接続数を指定する。既定は6、0は上限なし。両リーダーは同じ`node:http(s)` Agentを使い、本文の受信完了まで接続を占有する。HTTP pipeliningは使わない。6接続はブラウザの接続制約を検討するための実験条件であり、Node.jsでブラウザ全体の挙動を再現するものではない。COPCのデコーダー数は別設定で、今回は従来通り4のため、点データ取得も最大4並列になる。

ローカルで各応答に100 msの待ち時間を加える例（別ターミナルでサーバーを起動）:

```sh
node scripts/range-server.mjs . 18080 100
```

```sh
pnpm benchmark:copc -- \
  http://127.0.0.1:18080/114112.parquet \
  http://127.0.0.1:18080/114112.copc.laz \
  --repeats 3 --warmup 1 --http-connections 6 \
  --output benchmarks/copc-comparison-http-delay100-connections6-20260914.json
```

上限なしの対照実験は`--http-connections 0`と別の出力名で実行する。今回の2条件は同じHTTP実装で順番に測定した（上限なし→6接続）。各条件内では形式の順序を交互にしたが、条件の実行順は無作為化していないため、時間差には実行時の変動も含む。

サーバーの第4引数は応答前の遅延（ms、既定0）。HTTP/1.1・帯域制限なし。100 msは各応答に追加する待ち時間であり、パケット単位のRTT・輻輳・HTTP/2多重化の再現ではない。取得バイト数はRange bodyのみで、HTTPヘッダーなどの通信量は含めない。描画とデコーダー初期起動、samplingや結果バッファの差については下記のローカル比較と同じ制約がある。

### 2026-09-14: 上限なしと6接続の比較

同じHTTP実装・応答遅延100 ms、warmup 1回・計測3回。各queryのopen込みロード時間の中央値:

| query | 上限なし Parquet / COPC | 6接続 Parquet / COPC |
| --- | ---: | ---: |
| cube | 573 / 1089 ms | 1240 / 1094 ms |
| thin-x | 519 / 923 ms | 962 / 927 ms |
| thin-y | 561 / 940 ms | 1889 / 946 ms |
| thin-z | 694 / 1380 ms | 1473 / 1364 ms |
| large | 812 / 1432 ms | 1080 / 1513 ms |
| **合計（丸め前の値から集計）** | **3,161 / 5,764 ms** | **6,643 / 5,844 ms** |

上限なしではParquetが45.2%短いが、6接続では**Parquetが13.7%遅い**。6接続では5 query中4つでCOPCが速く、Parquetが速いのはlargeのみ。点データ部分のRange数は283／54、open込み取得量は38.2 MB／81.4 MBで両条件とも同じ。全試行の取得点数・取得量・Range数をローカル結果と照合した。接続数を制限しても取得量削減は維持されるが、この条件では待ち時間が速度上の利点を失わせる結果となった。

接続上限のテストでは、12件の同時要求に対し、レスポンスヘッダーを即時に返して本文を遅らせても、6接続条件の同時処理数が6を超えないことを検証した。このNode.js実験は実ブラウザ・帯域制限・HTTP/2・実配信先での速度を検証していない。

生の値: [上限なし](copc-comparison-http-delay100-connections0-20260914.json)、[6接続](copc-comparison-http-delay100-connections6-20260914.json)。接続上限の検証: `node --test scripts/benchmark-http.test.mjs`。

以前の[上限なし実験](copc-comparison-http-delay100-20260914.json)はNode.js標準fetchによる別実行（3,172 ms／6,152 ms）。HTTP実装も変わったため、接続制限による変化の比較には使用しない。

## 2026-09-14: 初回メタデータ取得を含むロード時間

リーダーのopen直前からquery完了までの実経過時間を`loadElapsedMs`として測定した。Parquetのフッター取得・解析、COPCのヘッダー・階層取得、点データの読み取り・展開・bbox判定・XYZRGBアクセスを含む。各試行の総時間を直接計測してから中央値を取っており、openとqueryの中央値を足した値ではない。

| query | Parquet open | COPC open | Parquet ロード完了 | COPC ロード完了 |
| --- | ---: | ---: | ---: | ---: |
| cube | 3.73 ms | 0.77 ms | 124 ms | 543 ms |
| thin-x | 2.22 ms | 0.59 ms | 82 ms | 373 ms |
| thin-y | 2.27 ms | 0.56 ms | 121 ms | 391 ms |
| thin-z | 2.33 ms | 0.58 ms | 250 ms | 791 ms |
| large | 2.17 ms | 0.56 ms | 370 ms | 822 ms |
| **各queryの中央値の合計** | — | — | **948 ms** | **2,921 ms** |

open込みの時間はParquetが67.6%短い。各queryでopenし直したメタデータを含む取得量合計（`totalBytesFetched`）はParquet 38.2 MB／COPC 81.4 MBで、53.1%少ない。合計は5回の独立した範囲ロードの集計であり、点群全体を一度ロードする時間ではない。

Apple M5 Pro・Node.js 24.18.0、warmup 1回・計測5回、laz-perf 4並列。入力は`114112.parquet`と`114112.copc.laz`、LODとquery形状は既存比較と同じ。実行順を交互にし、各試行でリーダーを作り直す。ローカルファイルをRange相当で読み、OSキャッシュは消去しない。ファイルサイズは既知として渡すためHTTP HEAD通信も含まない。モジュール・デコーダーの初期起動、比較条件の事前探索、ネットワーク遅延、GPU転送・描画は対象外。

Parquet側は結果のTypedArrayを生成し、COPC側は一致点を走査してRGBをchecksumへ集計する既存の比較処理を維持した。描画用バッファ生成までを両者で揃えた測定ではない。COPCはopen時に全階層ページを読む実装であり、遅延取得するリーダーとは初期コストが異なる。

[生の測定結果（各試行の値を含む）](copc-comparison-load-20260914.json)。再実行:

```sh
pnpm benchmark:copc -- 114112.parquet 114112.copc.laz \
  --repeats 5 --warmup 1 --concurrency 4 \
  --output benchmarks/copc-comparison-load-20260914.json
```

## 2026-09-08: columnar reader + WASM ZSTD

`parquetReadObjects`による行object化と汎用filterを廃止した。Page Indexで絞った物理row rangeからXYZRGB列を直接読み、単一loopでbbox判定しながらTypedArrayへ格納する。ZSTD decoderは純JavaScriptの`fzstd`からWASMの`zstddec`へ変更した。

同一PCP、同一query、warmup 1回、計測5回の中央値で、PCPの5 query合計は2,862 msから1,040 msへ63.6%短縮した。転送量、一致点数、Range call数は変更前と一致する。今回同時に測ったCOPCの3,567 msに対してPCPは70.8%短い。

| query | 旧PCP | columnar PCP | COPC | PCP短縮率 | PCP / COPC |
| --- | ---: | ---: | ---: | ---: | ---: |
| cube | 350 ms | 155 ms | 748 ms | 55.8% | 0.207 |
| thin-x | 208 ms | 93 ms | 442 ms | 55.3% | 0.210 |
| thin-y | 316 ms | 133 ms | 460 ms | 58.0% | 0.289 |
| thin-z | 784 ms | 282 ms | 953 ms | 64.0% | 0.296 |
| large | 1,203 ms | 377 ms | 964 ms | 68.6% | 0.392 |
| **合計** | **2,862 ms** | **1,040 ms** | **3,567 ms** | **63.6%** | **0.292** |

広域queryの逆転は解消し、`large`でもPCPがCOPCより60.8%短い。ZSTDだけを同じ列decode経路で交互に5回測ったmedianは、純JS 516 ms、WASM 467 msで9.6%短縮だった。全体改善の主因は行object、汎用filter、二重object変換、最終`flat()`の除去である。

生の測定値: [columnar + WASM ZSTD](copc-comparison-columnar-20260908.json)

## 2026-09-06: row-oriented reader

測定日: 2026-09-06

## 結論

`114112.copc.laz`（7,188,755点）から現行既定値で生成したParquetを、同程度の累積点数となるLODで比較した。32 KiBのRange coalescingにより、Parquetの5 query合計は1,667 callsから330 callsへ80.2%減った。1 queryあたり最大70 callsである。

結合したgapも転送するためParquetのbyte数は26.5 MBから37.0 MBへ増えたが、それでもCOPCの81.0 MBより54.3%少ない。read + decode時間はCOPCより29.3%短い。ファイル保存サイズは引き続きCOPCより20.1%大きい。

| 指標 | Parquet | COPC | Parquet / COPC |
| --- | ---: | ---: | ---: |
| ファイル | 106,693,920 bytes | 88,839,485 bytes | 1.201 |
| 比較LODの累積点数 | 2,039,852 | 1,903,684 | 1.072 |
| 5 queryの一致点数合計 | 1,948,128 | 1,813,490 | 1.074 |
| 5 queryの転送量合計 | 37,042,213 bytes | 81,049,235 bytes | 0.457 |
| 5 queryのRange call合計 | 330 | 54 | 6.11 |
| 5 queryの時間合計 | 2,134 ms | 3,016 ms | 0.707 |
| open時metadata | 524,288 bytes | 76,824 bytes | 6.825 |

Parquet側が少ないbyte数で済む主因は、XYZRGB columnだけを読み、Row Group statisticsとPage Indexの二段階でbbox外を除外できることにある。COPC側はnode単位の圧縮されたpoint recordを読むためcall数は少ないが、bbox境界では不要点と未使用属性も同じchunkに含まれる。

## Coalescingの効果

Hyparquetが同時に要求する列・pageの近接Rangeを同一microtask内で集約した。既定の最大gapは32 KiB、結合後の最大requestは2 MiBである。後続の逐次readを待つtimerは置かず、既存のLRU cacheとquery別meteringは維持している。

| 5 query合計 | coalescing前 | coalescing後 | 変化 |
| --- | ---: | ---: | ---: |
| Range calls | 1,667 | 330 | -80.2% |
| bytes | 26,456,057 | 37,042,213 | +40.0% |
| read + decode | 2,234 ms | 2,134 ms | -4.5%* |

`*` local file readの小差は測定ノイズを含むため、速度改善とは判断しない。coalescingの目的は実ネットワークでのRTT wave削減である。

4、8、12、16、32、64 KiBのgapを比較した。32 KiBは全queryを64〜70 callsへ収め、想定配信先のHTTP/2同時stream数100以内に保つ。64 KiBは26〜42 callsまで減らすが、時間は実質同じ（2,130 ms対2,134 ms）なのに転送量が14.6%増えるため、結合しすぎと判断した。2 MiB上限は離れたcolumn chunkを過大に結合しないためのguardrailである。

## Query別結果

時間と転送量は3回のmedian。各sampleでreader cacheを作り直し、形式の実行順を交互にした。時間にはrange相当のlocal file read、decompress、bbox filter、XYZRGB抽出を含み、metadata openは含まない。

| query | 一致点 PCP / COPC | bytes PCP / COPC | calls PCP / COPC | ms PCP / COPC |
| --- | ---: | ---: | ---: | ---: |
| cube | 167,039 / 155,670 | 4,851,440 / 15,041,721 | 70 / 9 | 228 / 551 |
| thin-x | 55,845 / 52,046 | 2,634,798 / 10,500,285 | 65 / 7 | 131 / 382 |
| thin-y | 63,324 / 58,655 | 5,088,861 / 11,088,311 | 65 / 6 | 182 / 411 |
| thin-z | 505,788 / 471,138 | 10,857,526 / 22,021,093 | 66 / 14 | 597 / 821 |
| large | 1,156,132 / 1,075,981 | 13,609,588 / 22,397,825 | 64 / 18 | 996 / 852 |

小〜中bboxではParquetの細粒度pruningが効く。large queryではbyte数が39.2%少なくてもParquetが16.9%遅く、page decodeとobject生成の固定費が優位を消している。現状の強みは部分読みにおける転送量であり、広域queryの処理速度ではない。

## 条件

- Parquet: additive LOD level 0〜4、累積2,039,852点、幾何誤差上限0.887 m
- COPC: octree depth 0〜2、累積1,903,684点、公称spacing 0.680 m
- query中心: COPC root nodeのXYZ median
- query形状: cube、thin-x、thin-y、thin-z、large
- Node.js v24.18.0、Apple M5 Pro、arm64、laz-perf decoder 4並列
- warmup 1回、計測3回、application cacheは各sampleでcold
- byte rangeはlocal fileから直接読む。ネットワークRTT、帯域制限、HTTP/2/3多重化、CDN cacheは含まない

LODのsampling規則は異なるため、点を一対一には揃えられない。今回は全体の累積点数を近づけ、実際のquery一致点数が合計で7.4%差であることを明示した。公称空間解像度も完全一致ではないため、形式そのものの絶対的な優劣ではなく、このviewer向けXYZRGB bbox workloadの結果として扱う。

生の測定値:

- [coalescing後](copc-comparison-coalesced-114112.json)
- [64 KiB比較](copc-comparison-64k-114112.json)
- [coalescing前](copc-comparison-uncoalesced-114112.json)
- 再実行コード: [`scripts/benchmark-copc.mjs`](../scripts/benchmark-copc.mjs)

実行コマンド:

```sh
cargo run --release -p pcp-convert -- \
  114112.copc.laz --output /tmp/114112-current.parquet \
  --coarse-points 8192 --voxel-edge-ratio 2 \
  --row-group-size 65536 --page-row-count 4096 --zstd-level 9

pnpm benchmark:copc -- \
  /tmp/114112-current.parquet 114112.copc.laz \
  --repeats 3 --warmup 1 --concurrency 4 \
  --output benchmarks/copc-comparison-coalesced-114112.json
```
