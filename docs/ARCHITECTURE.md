# AgentLinear 架构

## 产品边界

AgentLinear 是开源、本地优先的桌面应用，不依赖 AgentLinear 云端账号或 SaaS 服务。用户从 GitHub 克隆仓库，在自己的电脑上运行；代码、附件、会话和执行结果默认留在本机。

当前 MVP 的发布单元是 GitHub 源码仓库：macOS 用户使用 Node.js 22.16+ 执行 `npm ci`、`npm run doctor` 与 `npm start`。Node.js 22.16 是 `node:sqlite.backup` 的首个支持版本。`doctor` 只做本机检查，不发送遥测或诊断信息。签名安装包、Windows 与 Linux 不属于当前承诺范围。

## 已确认技术路线

- 桌面运行时：Electron + Node.js。
- 本地持久化：Node.js 内置 SQLite；启用 WAL、外键约束和版本化迁移。
- Codex 执行层：以 `lark-coding-agent-bridge` 的本地进程、Session、Workspace 与 Stop 模型为主要参考。
- Codex 协议层：使用官方 `codex app-server --stdio` JSON-RPC；按 `initialize → thread/start|resume|fork → thread/name/set → turn/start` 驱动交互会话。
- 调度：AgentLinear 自己实现数据库驱动的全局 6 并发 FIFO，不交给 Codex 适配器管理。
- AAMP：不进入本地 MVP；未来若需要跨设备派发，再作为可选集成评估。

## 进程边界

```text
Electron main process
  ├─ Window lifecycle
  ├─ SQLite storage             BE-02 已完成
  ├─ Environment preflight      BE-03 已完成
  ├─ Folder group service       BE-04 已完成
  ├─ Scheduler                  BE-06
  ├─ Codex session adapter      BE-05 已完成
  ├─ Persistent scheduler       BE-06 已完成
  ├─ Process lifecycle          BE-07 已完成
  ├─ Attachments                BE-08 已完成
  └─ Startup reconciliation     BE-09 已完成
            │
            └─ narrow validated IPC
                         │
Electron renderer
  └─ index.html task board
```

渲染进程不拥有 Node.js、文件系统或进程权限。所有本地能力必须在主进程实现，并通过预加载脚本暴露窄而可校验的接口。

## SQLite 数据边界

数据库位于 Electron `userData` 目录，当前 schema v1 包含：

- `groups`：本地文件夹分组。
- `tasks`：长期存在的任务卡片；`task_kind` 区分仅记录的待办与会启动会话的 Codex 任务。
- `sessions`：任务与 Codex Session ID 的一对一映射。
- `messages`、`attachments`：多轮消息及其本地附件。
- `runs`：每次启动、完成、失败或停止的执行记录。
- `queue_entries`：全局 FIFO 队列位置和领取信息。
- `settings`：本地应用设置。
- `schema_migrations`：已执行的数据库迁移。

迁移使用单事务执行。已有数据库升级前会写入 `userData/backups`；损坏数据库不会被覆盖，而是带时间戳隔离，等待用户恢复。

## 当前完成度

BE-01 至 BE-10 已完成。Electron 看板可以在真实文件夹中启动和恢复 Codex Session。全局调度器将任务先写入 `queue_entries`，持久领取后才允许启动；同时最多 6 个。运行 PID 写入 `runs`，用户停止、超时与应用退出会终止整个进程树并分别记录为 stopped、failed 或 interrupted；退出期间调度器暂停，不会启动排队任务。

每轮消息分别关联规范化附件路径。有效附件目录通过 `--add-dir` 授权给 Codex，图片同时使用 `-i`，全部路径写入结构化附件清单。文件失效会更新数据库标记，移除记录永远不会删除用户原文件。

应用启动时，`recovery.js` 在调度器运行前核对所有 running run、PID、队列租约与任务状态。只有命令行仍能识别为 Codex 的记录进程才会被终止；PID 已复用为其他程序时不会误杀。真正启动过但未完成的任务标记为 interrupted，避免自动重放已经产生过文件修改的指令；未真正启动的队列领取会释放租约并按原 FIFO 位置继续，用户可以用保存的 Session ID 手动重试中断任务。

Codex 类型卡片通过 app-server 创建为桌面客户端认可的交互线程，并用任务标题调用 `thread/name/set`，由 Codex 自己维护 `state_5.sqlite` 与 `session_index.jsonl`。待办类型卡片只写入 `tasks`，不创建 Session、消息、run 或队列记录；转换时在单个事务中复用原任务 ID、修改类型并补建 Session 与首条消息，提交后再进入调度队列。旧版本由 `codex exec` 创建的非交互 Session 在应用启动时只做 resume 检查；若来源为 `exec`，使用 `thread/fork` 复制完整历史到新的交互线程，再原子更新 AgentLinear SQLite 中保存的 Session ID。迁移不发送新用户消息，也不直接改写 Codex rollout 文件或索引。

AgentLinear 的 Codex 线程使用 `danger-full-access`，与本机 ChatGPT Codex 客户端的完整权限运行方式对齐，使受信任任务能够访问网络、macOS 钥匙串以及工作区之外的本机资源。应用仍保持 `approvalPolicy: never`，任务只应在用户明确关联并信任的本地项目中运行。

Codex 子进程完整继承 AgentLinear 的启动环境，并在未显式设置时固定 `CODEX_HOME=~/.codex`；因此登录态、`config.toml`、全局 `AGENTS.md`、Skills 和插件缓存与桌面端使用同一来源。AgentLinear 不覆盖模型、推理强度、personality 或 service tier，由该共享配置决定；app-server 额外启用桌面端同样使用的 `features.code_mode_host=true`。

开源交付包含固定 Node.js 22.16 基线、lockfile、MIT License、贡献与安全说明、macOS CI 和不联网的 `npm run doctor`。发布验收使用不含 `.git` 与 `node_modules` 的干净源码副本重新执行 `npm ci`、doctor、完整测试与 Electron 启动，确认独立 `userData` 数据库能够创建。
