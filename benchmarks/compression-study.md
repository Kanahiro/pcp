# PCP圧縮・ストリーミング比較

測定日: 2026-09-04

## Technical summary

このデータとブラウザbbox表示を対象にした推奨既定値は次です。

| 変数 | 選択 | 判断 |
| --- | --- | --- |
| Row Group | 65,536点 | Range request数と空間選択性の既存の折衷点を維持 |
| data page | 4,096行 | nested STR導入後の再測定で転送量と完了時間の折衷点 |
| page内順序 | nested STRのZ優先順 | GPS順よりファイルは大きいが、代表bboxの転送量が少ない |
| XYZ / intensity | `DELTA_BINARY_PACKED` | intensityのdictionaryより0.16%、plainより2.17%小さい |
| GPS time | `DOUBLE` + `BYTE_STREAM_SPLIT` | 完全可逆INT64 + BSSの改善は総ファイル0.12%だけ |
| ZSTD | level 9 | level 3比で0.75%小さく、変換時間の増加は19%。level 15の追加効果は1.60%に留まる |

最小ファイルだけを目的関数にするとGPS時間順 + ZSTD 15ですが、これはPCPの主目的である空間部分読み出しには最善ではありません。GPS時間順は全体を7.87%縮める一方、測定した中サイズbboxのRange転送量を23.85%増やしました。したがって、既定値は空間順 + ZSTD 9、オフライン配布用の明示的な最大圧縮候補はZSTD 15とします。

推奨構成のParquetは106,262,822 bytes（14.782 bytes/point）です。同じ入力COPCの88,839,485 bytes（12.358 bytes/point）より19.61%大きく、現時点では保存容量でCOPCを上回っていません。

## 対象と評価方法

- 入力: `114112.copc.laz`
- 点数: 7,188,755
- LAS/COPCサイズ: 88,839,485 bytes
- 出力schema: XYZ、RGBを含むLAS 1.4 point format 0〜10の全標準属性
- 共通条件: additive voxel LOD、64K Row Group、STR packing、Parquet v2
- 実行環境: Apple Silicon arm64、macOS 26.5.2、Rust 1.97.1、Node.js 24.18.0、pnpm 12.1.0、DuckDB 1.5.5

比較では一度に一つの変数だけを変えました。順序比較とintensity encoding比較はZSTD 3、ZSTD比較はspatial順 + 8K page、page比較はspatial順 + delta + ZSTD 9です。

ブラウザ転送量はローカルのHTTP Range serverに対して、実際の`@pointcloud-parquet/browser` readerでHyparquetのPage Index pruningとXYZRGB取得を実行し、返却されたRange bodyの総bytesを数えました。時間はwarm local loopbackの3回平均、変換時間は原則として単発測定です。

全12出力について、全標準属性を入力にした順序非依存hashを照合しました。すべて7,188,755点、同一checksum `10904017274312374363` であり、比較間で点や属性の欠落はありません。

## 結果

### page内順序

STRが決めたRow Groupとdata pageの点集合は固定し、page内部だけを並べ替えています。したがってbboxとpruning境界は全候補で同一です。

| page内順序 | Parquet bytes | bytes/point | spatial比 | 変換時間 |
| --- | ---: | ---: | ---: | ---: |
| spatial | 108,313,024 | 15.067 | — | 3.73 s |
| source | 103,290,571 | 14.368 | -4.64% | 4.23 s* |
| GPS time | 99,787,634 | 13.881 | -7.87% | 4.31 s* |
| 3D Hilbert | 111,021,145 | 15.444 | +2.50% | 14.71 s |

`*` 並列実行中の参考値であり、厳密な変換速度比較には使いません。

GPS順では`gps_time`が31.691 MiBから16.318 MiBへ縮む一方、`z`が1.515 MiBから15.358 MiBへ増えました。それでもファイル全体は小さくなりますが、空間queryで必要な座標pageの圧縮効率を悪化させます。3D Hilbertは`x`と`y`を改善しても`z`を12.088 MiBまで増やし、総量と変換時間の両方で不利でした。

代表的な中サイズbboxでは、両順序とも117 Row Group中42を読み、候補2,446,122点、一致315,149点、387 Range requestでした。

| page内順序 | Range転送量 | spatial比 |
| --- | ---: | ---: |
| spatial | 13,365,560 bytes | — |
| GPS time | 16,552,673 bytes | +23.85% |

ファイル総量と空間queryの転送量は同じ目的関数ではありません。この用途ではspatialを選びます。source順は中間候補ですが、GPS順と同じくXYZ相関を崩すため、既定値にする根拠はありません。

### Row Group内のX順実験

現在のSTRはRow Groupを空間的にpackした後、実質的にZ優先の順序を残します。この順序を疑い、Row Groupの点集合を固定したまま次の2案を追加測定しました。

1. Row Group全体を`(x, y, z)`順にする。
2. X順で8K data pageの所属を決め、各page内部を再び`(z, x, y)`順にする。

| Row Group / page内順序 | Parquet bytes | 現行比 | X column | Z column |
| --- | ---: | ---: | ---: | ---: |
| 現行STR（Z優先） | 107,502,551 | — | 15,924,675 | 1,416,220 |
| Row Group全体をX順 | 111,037,367 | +3.29% | 2,628,764 | 19,015,640 |
| Xでpage分割、page内Z順 | 105,161,089 | -2.18% | 13,517,939 | 3,570,874 |

単純なX順はXを83.49%縮めますが、Zが約13.4倍になり、全体では悪化しました。ところが「pageの空間分割」と「page内のencoding順序」を分離すると、XとZの両方をほどほどに保ち、総ファイルも2.18%縮みました。

同じbbox、同じ一致点数でのRange転送量は次の通りです。括弧内はrequest数です。

| query形状 | 現行STR | Row Group全体X順 | X page + page内Z順 |
| --- | ---: | ---: | ---: |
| cube | 13,318,743 (387) | 9,389,311 (405) | 8,613,447 (405) |
| X方向に薄い | 18,831,119 (416) | 3,920,187 (479) | 3,608,429 (479) |
| Y方向に薄い | 20,886,865 (409) | 18,018,539 (463) | 16,488,208 (463) |
| Z方向に薄い | 843,466 (126) | 1,535,948 (120) | 1,398,815 (120) |
| large | 40,310,377 (759) | 27,728,344 (801) | 25,245,624 (801) |

X page + page内Z順はcubeで35.33%、largeで37.37%転送量を減らします。一方、Z方向に薄いqueryでは65.84%増え、通常はrequest数も増えます。固定X軸への依存があるため、この案自体は採用せず、次のnested STRへ一般化しました。

### Row Group内のnested STR

outer STRが決めた各Row Groupを、8K点をleaf容量として再び3D STRしました。64Kの完全なRow Groupは約2×2×2のdata pageへ分かれます。page内部にはSTRのZ優先順を残しています。

| layout | Parquet bytes | bytes/point | 現行比 |
| --- | ---: | ---: | ---: |
| Row GroupのみSTR | 107,502,551 | 14.954 | — |
| Row Group + data page nested STR | 105,441,050 | 14.667 | -1.92% |

| query形状 | Row GroupのみSTR bytes / requests | nested STR bytes / requests | bytes差 |
| --- | ---: | ---: | ---: |
| cube | 13,318,743 / 387 | 8,083,339 / 531 | -39.31% |
| X方向に薄い | 18,831,119 / 416 | 8,181,302 / 473 | -56.55% |
| Y方向に薄い | 20,886,865 / 409 | 10,546,969 / 754 | -49.50% |
| Z方向に薄い | 843,466 / 126 | 1,410,688 / 162 | +67.25% |
| large | 40,310,377 / 759 | 25,016,424 / 984 | -37.94% |

Row Groupの点集合、一致点数、Row Group pruning数は変わりません。nested STRは5 query中4つで転送量を大きく減らし、固定X案と違って薄いYにも効き、総ファイルも縮めました。Z方向に薄いqueryとrequest数は悪化するためreader側のRange coalescingは今後必要ですが、3軸に対称で単純な階層化として既定layoutへ採用します。

### intensity encoding

GPS順 + ZSTD 3で比較しました。順序を共通にしているため、encoding間の差だけを見られます。

| encoding | Parquet bytes | delta比 |
| --- | ---: | ---: |
| delta | 99,787,634 | — |
| dictionary | 99,943,358 | +0.16% |
| plain | 101,952,332 | +2.17% |

差は大きくありませんがdeltaが最小です。XYZにも同じencodingを使うため、writer設定の認知負荷も増やしません。

### ZSTD level

spatial順 + delta + 8K pageで比較しました。

| level | Parquet bytes | bytes/point | level 3比 | 変換時間 | 中bbox転送量 | 3回平均read |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 108,313,024 | 15.067 | — | 3.73 s | 13,365,560 | 977.8 ms |
| 9 | 107,502,551 | 14.954 | -0.75% | 4.43 s | 13,318,743 | 964.9 ms |
| 15 | 105,780,144 | 14.715 | -2.34% | 6.64 s | 13,291,219 | 1,005.5 ms |

level 9はlevel 3に対して変換時間が約19%増え、0.75%縮みます。level 15はlevel 9よりさらに1.60%縮みますが、変換時間はlevel 3比で約78%増えます。local read時間の差は小さくノイズを含みますが、level 15を既定にするほどの利得ではありません。

DuckDBでXYZRGBをfull decodeした4回平均はlevel 3が46.42 ms、level 9が47.64 ms、level 15が46.32 msでした。この環境ではdecode速度の有意な差は確認できません。

### GPS timeの完全可逆整数化

spatial順 + delta intensity + 8K page + ZSTD 9を固定し、GPS timeだけを比較しました。この入力のGPS timeは174,587.14907586575〜529,841.4277510047秒なので、`scale = 2^-35`秒のticksへ変換してもsigned `INT64`に収まります。全7,188,755点を`DOUBLE`へ復元して照合した結果は0 mismatch、最大誤差0秒でした。

| GPS time表現 | GPS column bytes | Parquet bytes | DOUBLE比 |
| --- | ---: | ---: | ---: |
| `DOUBLE` + Byte Stream Split | 32,621,144 | 107,502,551 | — |
| exact `INT64` + Delta Binary Packed | 38,249,899 | 113,131,330 | +5.24% |
| exact `INT64` + Byte Stream Split | 32,493,842 | 107,375,253 | -0.12% |

整数化とdelta encodingは同義ではありません。空間順では隣接点のGPS time差が大きいため、exact ticksのdeltaは高いbit幅を必要とし、総ファイルを5.24%増やしました。INT64にもByte Stream Splitを使えば127,298 bytesだけ縮みますが、schemaと復元規則を増やす対価として小さすぎます。GPS timeは現在の`DOUBLE`のまま維持します。

### data page行数

nested STR + spatial順 + delta + ZSTD 9で1K〜32Kを再比較しました。`5 query bytes`と`requests`はcube、薄いX/Y/Z、largeの合計です。

| page行数 | Parquet bytes | 8K比 | 5 query bytes | requests |
| ---: | ---: | ---: | ---: | ---: |
| 1,024 | 116,143,884 | +10.15% | 35,897,138 | 4,497 |
| 2,048 | 109,039,208 | +3.41% | 38,140,039 | 4,125 |
| 4,096 | 106,262,822 | +0.78% | 42,243,046 | 3,540 |
| 8,192 | 105,441,062 | — | 53,238,722 | 2,904 |
| 16,384 | 104,666,706 | -0.73% | 55,970,718 | 2,754 |
| 32,768 | 102,614,511 | -2.68% | 79,175,179 | 2,118 |

4Kは8Kよりファイルを0.78%増やしますが、5 queryの転送量を20.65%減らします。実配信先CloudflareのHTTP/2上限と同じ100並列、各応答100ms遅延の模擬環境でも、cubeは833ms対878ms、largeは2,160ms対2,468msで4Kが速い結果でした。

2Kと1Kはさらに転送量を減らしますが、ファイルを3.41〜10.15%増やし、request待ちでcubeの完了時間が888〜1,128msへ悪化します。現readerにcoalescingがない状態では4Kが最も安定した折衷点なので、既定値へ採用しました。

### Row Groupとdata pageの役割

小さいRow Groupで細かいPageを置き換えられるか確認しました。`5 query`は同じcube、薄いX/Y/Z、largeの合計です。

| Row Group / Page | Row Groups | Parquet bytes | footer | 5 query bytes | requests |
| --- | ---: | ---: | ---: | ---: | ---: |
| 64K / 4K | 117 | 106,262,822 | 341,659 | 42,243,046 | 3,540 |
| 32K / 4K | 227 | 107,282,775 | 657,742 | 43,886,621 | 3,957 |
| 16K / 4K | 445 | 108,174,371 | 1,262,587 | 37,220,121 | 5,261 |
| 8K / 4K | 881 | 110,625,440 | 2,480,591 | 42,176,424 | 6,371 |
| 32K / 32K（Page分割なし） | 227 | 103,801,173 | 638,715 | 78,993,525 | 2,637 |
| 16K / 16K（Page分割なし） | 445 | 107,100,099 | 1,246,619 | 58,689,734 | 3,824 |
| 8K / 8K（Page分割なし） | 881 | 109,598,160 | 2,460,571 | 51,538,481 | 6,047 |

16K / 4Kは64K / 4Kより転送量を11.89%減らしますが、requestは48.62%増えます。100ms・100 streamの模擬条件ではcubeが843msから1,160msへ悪化し、largeだけ2,127msから2,064msへわずかに改善しました。32K / 4Kはファイル、転送量、requestのすべてで64K / 4Kに劣ります。

Page分割をなくす案も不利です。16K / 16Kは64K / 4Kに対して5 queryの転送量が38.93%多く、footerとrequestも増えます。小さいRow Groupは最初のchunkを早く返す利点がありますが、総読み出しの既定値としては割に合いません。

Row Groupは圧縮・metadata・SSE選択を償却する粗い単位、data pageはRow Group数を増やさずPage Indexで空間filterする細かい単位として役割が異なります。このデータでは64K Row Groupは過剰ではなく、64K / 4Kの16 pagesという構成が妥当です。

## 現在の既定値

```text
row_group_size = 65536
page_row_count = 4096
page_layout = nested_str
page_order = spatial
intensity_encoding = delta
zstd_level = 9
```

変換例:

```sh
cargo run --release -p pcp-convert -- \
  114112.copc.laz points.parquet \
  --row-group-size 65536 \
  --page-row-count 4096 \
  --page-order spatial \
  --intensity-encoding delta \
  --zstd-level 9
```

利用者に通常見せるinterfaceはこの既定値だけで十分です。比較用knobはconverter CLIに閉じ込め、browser readerやmetadata formatへ波及させません。

## 限界と判断を覆す条件

- 1つの航空測量データだけの結果です。地上レーザー、mobile mapping、RGBなし、GPSなしでは列相関が変わります。
- local loopbackでは実ネットワークのRTT、CDNのRange coalescing、HTTP/2またはHTTP/3の多重化を再現しません。request数のコストは本番でより大きい可能性があります。
- 変換時間の多くは単発測定です。小差を速度上の優位とは扱いません。
- bboxは3種類だけです。camera traceを記録して複数視点の総転送量とcache hit率を測る方がviewerの実負荷に近くなります。
- COPCとは保持属性とアクセス方式が完全には同一でないため、ファイルサイズだけでformat全体の優劣は決められません。

別種のデータを含むcorpusでGPS順がXYZの圧縮を悪化させず、実ネットワーク上のcamera traceでも総転送量を減らすなら、page内順序の選択は再検討できます。ZSTD 15は変換を一度しか行わない配布物で、1.6%の保存量が追加変換時間より重要なら選択できます。

## 次の実験

優先度順です。

1. 代表データを3〜5種類に増やし、同じmatrixを自動実行する。
2. Viewerのcamera操作をtraceとして保存し、cold cacheで総bytes、request、first visible、settled timeを測る。
3. `gps_time`だけを時系列に近づけながらXYZ順序を保てるかではなく、列ごとに独立したParquet page orderingが不可能という制約下で、属性を別ファイルまたは別column chunkへ分ける価値を測る。
4. COPCと同じ属性集合に正規化したstorage比較を追加する。

3はformatとreaderを複雑化するので、現状の21%のCOPC差を埋める効果が見込めると測定できるまで実装しません。

## 参照

- [Apache Parquet encodings](https://parquet.apache.org/docs/file-format/data-pages/encodings/)
- [parquet-rs WriterProperties](https://arrow.apache.org/rust/parquet/file/properties/struct.WriterProperties.html)
- [Apache Parquet implementation status](https://parquet.apache.org/docs/file-format/implementationstatus/)
