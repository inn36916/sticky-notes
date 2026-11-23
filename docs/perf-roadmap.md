# 图片外置输入压测（2026-11-21）

同一 scripts/perf-input.js，基线直接灌入内联图片；优化组加 --external-images，通过 insertImageDataUrl 入口插入。生成图片的种子、数量、尺寸和输入节拍保持一致。

| 场景 | 基线每键 P95 (ms) | 附件引用 P95 (ms) |
|---|---:|---:|
| S0 | 3.51 | 3.03 |
| S1 | 8.54 | 11.67 |
| S2 | 37.24 | 3.23 |
| S2N | 48.16 | 3.6 |
| S3 | 94.42 | 3.72 |

S0 为约 2 KB 纯文本；S2 为约 4 MB 等价图文；S2N 为相同图文、200 ms 输入节拍；S3 为约 12 MB 等价图文。附件外置后 HTML 不再包含图片字节。

两组均通过输入尾标记与自然退出落盘检查。压测期间采用隔离 user-data-dir，未迁移真实用户数据。原始报告见 perf-roadmap-before.json 与 perf-roadmap-after.json。
