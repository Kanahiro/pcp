# PCP / COPC reader benchmark

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
