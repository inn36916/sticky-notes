# PNG 右键转换文件类型错误修复

## 实际症状

应用已经运行时，从资源管理器右键选择 PNG，格式选择窗收到“sticky-notes、1.png”，把程序目录作为第一个文件，因此在查询引擎之前就提示“无法识别文件类型。”。

## 根因与修复

Electron 的 second-instance 事件会重排 argv，并可能追加 Chromium 参数。本机实际复现中，开发模式的程序目录被放到 --convert 后，现有解析器将它当成待转换文件。

在 requestSingleInstanceLock 的 additionalData 中传递原始 process.argv，主实例优先处理该原始数组；没有 additionalData 时保留原来的事件参数兼容路径。没有修改扩展名识别或转换引擎，也没有丢弃用户选中的多文件。

## 验证

- 新增 scripts/e2e-convert-second-instance.js，真实启动第二个 Electron 进程，命令结构与注册表右键入口相同，使用包含中文、空格和大写 .PNG 的隔离样例。
- 修改前稳定复现：文件列表包含程序目录，状态为“无法识别文件类型。”（convert-second-instance-before.log）。
- 修改后：仅收到 PNG 文件，格式卡含 jpg；实际 PNG → JPG 成功，检查 JPEG 文件头、附件文件和新便签落盘（convert-second-instance-after.log）。
- npm test：407/407 通过。
- npm run lint：108 文件语法、无循环依赖、IPC 和安全策略检查通过。
- 既有转换 Electron 回归：4/4 场景通过（convert-fix-existing-e2e.log）。

## 生效方式

当前运行的是修复前启动的主进程，修改磁盘源码不会自动替换其事件处理函数。需从托盘“退出”后，重新运行项目 start.bat，再从资源管理器右键转换。不能只关闭转换弹窗，关闭弹窗并不会退出主进程。

本次未强制结束现有便签进程，未修改用户 PNG 或便签库，未更新历史便携 ZIP。
