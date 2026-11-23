# 验证记录（2026-11-21）

- final-test-result.log：406/406 Node 测试通过。
- final-lint-result.log：106 个 JS 文件语法、44 模块无循环依赖、63/20 IPC 通道、10 页安全策略通过。
- full-e2e-result.log：14/14 Electron 套件通过。
- roadmap-final-e2e.log：新增边界、正常导入导出入口、归档搜索和配对恢复用例定向重跑通过。
- portable-smoke.log：最终便携目录在清理 Node/npm/Python PATH 后，首次写入与重启恢复均通过。测试在临时目录运行，未改真实便签。
- 最终 ZIP 的运行时入口、内置 Mermaid、marked 均存在，82 个源码文件与工作区 SHA256 一致，旁置 data 目录为空。ZIP 校验文件在 dist 中。
- 压测比较见 ../../perf-roadmap.md。

尚未进行：物理双屏不同缩放与热拔插；真实 Windows 系统通知点击/通知关闭；外部应用划词的合成截图剪贴板验收；干净 Windows 虚拟机与真实托盘菜单操作。已有模拟和 Electron 事件测试不等同于这些人工验收。

## 实机补验与 1.1.2

详见 [当前机器验收报告](NATIVE-ACCEPTANCE.md)。单屏三卡、重启、外部划词/剪贴板实测通过；发现并修复关闭浮窗迟到回报问题及入口文字拥挤。407 项 Node 测试与专项回归通过。真实通知进入系统历史，但 QUNS_BUSY 下尚未完成横幅点击；双屏和 VM 按当前机器范围不声称通过。
