# dsh-whale-core 鲸核

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的人格内核插件：**可编辑人设 + 自主记忆 + 心情骰子 + 设置面板**，宿主半边零第三方依赖（只用 Node 内置模块），客户端半边是手写的 `__ModuleLoader__` bundle，不需要构建。

装上之后，panel 里会多出「鲸核」一页：人设卡分板块可编辑、记忆列表可增删改权重、日记与复盘可回看、心情和好感度可手调。

> 数据都存在 `$DSH_HOME/whale-core/` 下，纯文本，随时能备份、能搬机器。仓库里只有代码，不含任何记忆数据。

---

## 它做五件事

1. **人设内核 + 心情**：把内核文本与「此刻心情」拼成 `systemPrompt.context` 注入；稳定那截（人设板块）挂在最前面当缓存前缀，会变的那截（心情/好感/表情）垫在后面，尽量不吃缓存。
2. **自主记忆**：提供 `remember` 工具，模型自己决定记什么；记忆带权重、命中次数、分档（一档/二档/三档）。
3. **自主召回**：每轮按「相关度 / 权重 / 新鲜度」挑几条注入，和上次一样就不重复发。
4. **日记**：按设定间隔，用宿主模型把这阵子的对话写成第一人称日记。
5. **复盘**：每隔几天（或手动）回看日记与记忆，写一段要点。

外加：工作/闲聊分道、心情骰子（定时投 + 反应骰）、好感度与兴趣度自动漂移、备份与导出导入。

---

## 多套人设

默认那套人设放在 `kernel.sections`，另外可以再存几套（最多 8 套），面板「内核」页的「人设库」卡里新建、改名、删除、切换编辑目标。

- **新开的对话**用「新会话默认」那套（`personas.activeId`，没设就用默认那套）。
- **已经有对话**想让某个对话单独换一套：在「会话绑定」卡里点，或者跟鲸鲸说一句「换个形象 / 用×套人设」，她用 `whale_persona` 工具只改当前这个对话（`personas.bySession[sid]`）。
- 绑过的对话不会因为改「新会话默认」而跟着变。

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
| `kernel.sections[]` | 默认那套人设的板块，每块可单独启用/停用 |
| `personas.list[]` / `activeId` / `bySession` | 另外几套人设、新会话默认哪套、哪个对话绑了哪套 |
| `memory.injectMax` / `maxChars` | 每轮最多注入几条、多少字（默认 3 条 / 420 字） |
| `memory.auto` | 自主记忆，`everyTurns` 控制间隔（只按对话轮数触发，不看时间） |
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
├── memory/
│   ├── bucket-2026-10.jsonl   记忆（按月分片，一条一行）
│   └── bucket-2026-11.jsonl
├── journal.jsonl    日记与复盘
├── settings.json    配置（人设、记忆、心情、好感都在这里）
├── profile.json     自动档案（偏好摘要）
├── events.jsonl     会话事件缓冲（可丢）
├── pending.jsonl    待整理缓冲（可丢，按 64 KB / 24 小时自动裁）
└── backups/         自动备份快照
```

老的 `memory.jsonl` 只要还在，启动时会自动迁进 `memory/` 分片里。

迁移或备份时，拷 `memory/`、`journal.jsonl`、`settings.json`、`profile.json`、`backups/` 就够，不要拷 `events.jsonl`、`pending.jsonl`。

导出格式是单个 JSON（`format: "dsh-whale-core"`），导入支持 `merge`（按文本去重）和 `replace` 两种模式。

---

## 更新记录

**0.6.7** — 多套人设：`personas` 存另外几套、`bySession` 让每个对话各用各的，面板加「人设库」「会话绑定」两张卡，新增 `whale_persona` 工具。

**0.6.6** — 人设拆两段注入：稳定段（板块文本）挂在最前当缓存前缀，漂移段（心情/好感/表情）垫在后面，避免每条消息都把前缀缓存打掉。

**0.6.5** — 记忆成本与缓存优化：自动记忆只按对话轮数触发（去掉 30 分钟那条空转）、单次输入压到 1800 字、注入块整串缓存 30 秒、画像与复盘去重并压短、`markRecalled` 只重写命中条目所在分片、事件线按同主题合并、`pending` 改按字节+时长双向裁。

---

## 许可证

MIT
