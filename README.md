# dsh-whale-core 鲸核

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的人格内核插件：**可编辑人设 + 自主记忆 + 心情骰子 + 设置面板**，宿主半边零第三方依赖（只用 Node 内置模块），客户端半边是手写的 `__ModuleLoader__` bundle，不需要构建。

装上之后，panel 里会多出「鲸核」一页：人设卡分板块可编辑、记忆列表可增删改权重、日记与复盘可回看、心情和好感度可手调。

> 数据都存在 `$DSH_HOME/whale-core/` 下，纯文本，随时能备份、能搬机器。仓库里只有代码，不含任何记忆数据。

---

## 它做五件事

1. **人设内核 + 心情**：把内核文本与「此刻心情」拼成 `systemPrompt.context` 注入，内容少变不吃缓存。
2. **自主记忆**：提供 `remember` 工具，模型自己决定记什么；记忆带权重、命中次数、分档（一档/二档/三档）。
3. **自主召回**：每轮按「相关度 / 权重 / 新鲜度」挑几条注入，和上次一样就不重复发。
4. **日记**：按设定间隔，用宿主模型把这阵子的对话写成第一人称日记。
5. **复盘**：每隔几天（或手动）回看日记与记忆，写一段要点。

外加：工作/闲聊分道、心情骰子（定时投 + 反应骰）、好感度与兴趣度自动漂移、备份与导出导入。

---

## 安装

要求：Node >= 20，DSH >= 0.2.0。

```bash
# git 仓库（推荐，可跟版本）
dsh plugin --profile desktop add https://github.com/<你的用户名>/dsh-whale-core

# 本地目录
dsh plugin --profile desktop add file:/path/to/dsh-whale-core
```

装完**重启 DSH**，bundle 只在启动时解析。

手机端（DSHBox / PRoot）把 profile 换成 `web`，并建议关掉日记、复盘、边缘抽查这几个定时任务，详见 `docs/mobile.md`（如果仓库里有）。

---

## 配置

配置文件：`$DSH_HOME/whale-core/settings.json`

主要开关：

| 键 | 说明 |
|---|---|
| `enabled` | 插件总开关 |
| `kernel.sections[]` | 人设内核板块，每块可单独启用/停用 |
| `memory.injectMax` / `maxChars` | 每轮最多注入几条、多少字 |
| `memory.auto` | 自主记忆，`everyTurns` 控制间隔 |
| `memory.diary` / `review` | 日记与复盘，`enabled` + 间隔 |
| `memory.tiers` | 记忆分档衰减 |
| `dice.everyMinutes` | 心情骰子间隔 |
| `affinity` | 好感度与兴趣度 |
| `sync` | 自动备份间隔与保留份数 |

面板里能改绝大部分；剩下的改完文件后重启 DSH 生效。

---

## 数据

```
$DSH_HOME/whale-core/
├── memory.jsonl     记忆，一条一行
├── journal.jsonl    日记与复盘
├── settings.json    配置
├── profile.json     自动档案（偏好摘要）
├── events.jsonl     会话事件缓冲（可丢）
├── pending.jsonl    待整理缓冲（可丢）
└── backups/         自动备份快照
```

迁移或备份时，拷 `memory.jsonl`、`journal.jsonl`、`settings.json`、`profile.json`、`backups/` 就够，不要拷 `events.jsonl`、`pending.jsonl`。

导出格式是单个 JSON（`format: "dsh-whale-core"`），导入支持 `merge`（按文本去重）和 `replace` 两种模式。

---

## 许可证

MIT
