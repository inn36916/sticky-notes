# 转换结果保存到源目录验收

- 转换不再创建展示结果的新便签（IPC 格式窗及 --convert --to 入口）。
- 每个结果保存在对应源文件目录，命名为“原文件名.目标格式”；同名时追加“ (1)”“ (2)”编号，使用独占复制防止覆盖。
- 多页 PDF 保留分页编号；多图合并 PDF 保存到第一张输入图所在目录。
- 保存失败会报告错误并保留临时结果；源文件保持原样。

验证：
- npm test：412/412 通过（source-output-unit-final.log）。
- npm run lint：通过。
- npm run test:e2e:all：初次 14/15 通过（source-output-e2e.log），唯一失败为多页 PDF 旧随机文件名断言。
- 更新该断言后重跑 test:e2e:convert:pdf:allpages：42/42 通过（source-output-allpages.log），15 套均已有通过结果。
- 真实二次进程 PNG→JPG：JPEG 魔数正确、源目录存在结果、便签仍为一张、未创建附件目录。

应用主进程需完全退出并重新启动以加载本次代码。现有便携 ZIP 未重新打包。
