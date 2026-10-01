# PCP and COPC browser comparison

Five XYZRGB bounding-box queries over a 7,188,755-point source were measured on 2026-09-14 in Chromium 152 on an Apple M5 Pro. Each query had one warmup and three measured runs. Times below sum the five per-query medians, from Worker startup through fetching, decoding, GPU completion, and the following frame boundary. Page startup and physical display time were excluded.

| Condition | PCP | COPC |
| --- | ---: | ---: |
| [Remote delivery](copc-comparison-browser-e2e-remote-20260914.json) | 3.41 s | 6.25 s |
| [Local HTTP/1.1 with 100 ms response delay](copc-comparison-browser-e2e-delay100-20260914.json) | 6.74 s | 6.07 s |

The measured PCP file was 105.2 MB versus 88.8 MB for COPC. Across the five queries, PCP fetched 38.2 MB of Range bodies for the projected XYZRGB columns versus COPC's 81.4 MB. PCP made more requests, which matters under latency. The two LOD selections covered different cumulative point counts (2.04 million for PCP, 1.90 million for COPC), so the comparison is specific to these implementations and query settings. The remote browser protocol could not be verified.

The [query reference](../scripts/browser-benchmark/reference.json) supplies bounds, LOD selection, and expected point counts for the benchmark page. The measured PCP file predates the [column encoding update](column-encoding-audit-20261001.md); the browser comparison has not been rerun with the new defaults.
