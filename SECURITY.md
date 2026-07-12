# 安全说明

AgentLinear 会以本机完整权限运行 Codex，使任务能够复用网络、macOS 钥匙串和现有 CLI 登录态；Codex 也能够访问并修改关联项目之外的本机文件。请只提交可信指令，并确保重要文件已经备份或纳入版本控制。

## 报告安全问题

请不要在公开 Issue 中粘贴访问令牌、Codex 对话、数据库、日志、用户名或完整本地路径。可以先在仓库的 GitHub Security 页面私下报告；若暂时无法使用私密报告，只提交不含敏感数据的最小复现说明。

## 本地数据边界

- AgentLinear 不包含遥测、云端同步或 AgentLinear 账号系统。
- 任务、消息、Session ID、附件路径与运行记录保存在 Electron 的本地 `userData` 目录。
- `npm run doctor` 只检查本机文件和命令，不发送诊断结果。
- 删除附件记录不会删除用户的原文件。
- 停止任务会终止 AgentLinear 记录的 Codex 进程树；启动恢复只处理命令行仍可识别为 Codex 的 PID。
