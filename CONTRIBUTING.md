# 参与 AgentLinear

感谢你愿意改进 AgentLinear。当前 MVP 只承诺 macOS，并坚持本地优先：任务、代码、附件、会话和诊断信息都不应离开用户电脑。

## 开发环境

1. 安装 Node.js 22.16 或更高版本，并安装、登录 Codex CLI。
2. 克隆仓库后运行 `npm ci`。
3. 运行 `npm run doctor` 检查本地环境。
4. 运行 `npm start` 启动桌面应用。

提交代码前请运行：

```bash
npm run check
```

## 修改原则

- 不引入 AgentLinear 云端账号、遥测或远程数据存储。
- 不提交密钥、数据库、日志、用户文件或绝对个人路径。
- 调度器必须继续维持全局 FIFO 和最多 6 个并发任务。
- 同一卡片续聊必须复用原 Codex Session ID。
- 新线程必须通过 app-server 创建并设置用户可见名称；禁止退回 `codex exec` 或直接改写 Codex 会话索引。
- 进程、数据库或 IPC 边界变化时，同步更新 `docs/ARCHITECTURE.md`。

Bug 报告请说明 macOS、Node.js 与 Codex CLI 版本、复现步骤和预期行为。请先删除日志中的用户名、项目路径、指令内容与其他隐私信息。
