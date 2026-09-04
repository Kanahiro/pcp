# PCP圧縮・ストリーミング比較

測定日: 2026-09-04

## Technical summary

このデータとブラウザbbox表示を対象にした推奨既定値は次です。

| 変数 | 選択 | 判断 |
| --- | --- | --- |
| Row Group | 65,536点 | Range request数と空間選択性の既存の折衷点を維持 |
| data page | 8,192行 | 4Kの細かさと16Kの転送増の中間 |
| page内順序 | STR spatial | GPS順よりファイルは大きいが、代表bboxの転送量が24%少ない |
| XYZ / intensity | `DELTA_BINARY_PACKED` | intensityのdictionaryより0.16%、plainより2.17%小さい |
| ZSTD | level 9 | level 3比で0.75%小さく、変換時間の増加は19%。level 15の追加効果は1.60%に留まる |

最小ファイルだけを目的関数にするとGPS時間順 + ZSTD 15ですが、これはPCPの主目的である空間部分読み出しには最善ではありません。GPS時間順は全体を7.87%縮める一方、測定した中サイズbboxのRange転送量を23.85%増やしました。したがって、既定値は空間順 + ZSTD 9、オフライン配布用の明示的な最大圧縮候補はZSTD 15とします。

推奨構成のParquetは107,502,551 bytes（14.954 bytes/point）です。同じ入力COPCの88,839,485 bytes（12.358 bytes/point）より21.01%大きく、現時点では保存容量でCOPCを上回っていません。

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

### data page行数

spatial順 + delta + ZSTD 9で比較しました。

| page行数 | Parquet bytes | 小bbox bytes / requests | 中bbox bytes / requests | 大bbox bytes / requests |
| ---: | ---: | ---: | ---: | ---: |
| 4,096 | 109,328,791 | 6,838,179 / 225 | 12,964,649 / 408 | 39,956,452 / 795 |
| 8,192 | 107,502,551 | 7,015,909 / 222 | 13,318,743 / 387 | 40,310,377 / 759 |
| 16,384 | 106,585,991 | 7,574,678 / 213 | 14,282,024 / 372 | 40,938,404 / 723 |

4Kは8Kより中bboxの転送を2.66%減らしますが、ファイルを1.70%増やし、requestも21回増えます。16Kはファイルを0.85%縮め、requestを15回減らす代わりに、中bboxの転送を7.23%増やします。8Kは極端な欠点がなく、単一の既定値として妥当です。

## 採用する既定値

```text
row_group_size = 65536
page_row_count = 8192
page_order = spatial
intensity_encoding = delta
zstd_level = 9
```

変換例:

```sh
cargo run --release -p pcp-convert -- \
  114112.copc.laz points.parquet \
  --row-group-size 65536 \
  --page-row-count 8192 \
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
