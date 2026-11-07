/**
 * dsh-whale-core —— 宿主半边 v0.3
 *
 * 零静态依赖（只用 node 内置模块）：本机 desktop profile 解析不到 @deepseek-ai/*，
 * 任何 import 失败都会让整条 bundle 不激活，进而把 profile 重置成默认。
 *
 * 这一版做五件事：
 *   1. 内核 + 心情：systemPrompt.context 注入（内容少变，不吃缓存）
 *   2. 自主记忆：remember 工具，模型自己决定记什么，记住的带权重
 *   3. 自主回忆：每轮按 相关度 / 权重 / 新鲜度 挑几条，走 context（不变就不重发）
 *   4. 日记：按设定的时间间隔，用宿主模型把这段时间的对话写成第一人称日记
 *   5. 复盘：每隔几天（或手动）回看日记与记忆，写一段要点
 *
 * 数据都在 $DSH_HOME/whale-core/ 下的纯文本：
 *   settings.json  配置（含权重、间隔）
 *   memory.jsonl   一条一行：{ id, t, kind, text, weight, tags, src, hits, lastHit }
 *   journal.jsonl  一条一行：{ id, t, kind:'diary'|'review', text, from, to }
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import * as ghsync from './sync.js'

export const name = 'whale-core'
export const inject = ['agents', 'webServer', 'systemPrompt', 'tools', 'llm']

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STORE = path.join(HOME, 'whale-core')
try { ghsync.loadExtraCA(STORE) } catch {}
const CFG_PATH = path.join(STORE, 'settings.json')
// 老版本的单文件记忆：留作迁移源，新写入都进 memory/bucket-YYYY-MM.jsonl
const MEM_PATH = path.join(STORE, 'memory.jsonl')
const MEM_DIR = path.join(STORE, 'memory')
// 向量层缓存：记忆和查询的向量都存这儿，没有向量服务时自动降级成纯词法
const EMB_PATH = path.join(STORE, 'embeddings.json')
const JOUR_PATH = path.join(STORE, 'journal.jsonl')
// 改过的旧版本：改一条记忆不是原地覆盖，旧的整条搬到这里留档
const REV_PATH = path.join(STORE, 'revisions.jsonl')
// 跨窗口事件线：所有会话都往同一条线上写，换个窗口也知道刚发生了什么
const EVENT_PATH = path.join(STORE, 'events.jsonl')
// 还没蒸馏的原文：压缩把上下文吃掉以后，这里还有一份
const PENDING_PATH = path.join(STORE, 'pending.jsonl')
// 画像层：「我记得的你」，从事实里蒸出来，不写死
const PROFILE_PATH = path.join(STORE, 'profile.json')
// 自动快照：记忆只有一份文件，坏了就全没了
const BACKUP_DIR = path.join(STORE, 'backups')
const STARTED_AT = Date.now()
const PLUGIN_VERSION = '0.6.15'

const MOOD_HALF_LIFE_HOURS = 6
// 权重压到这么低、又老过一个周期，就收进归档（不删，只是不再注入）
const ARCHIVE_WEIGHT = 0.12
const MEMORY_INJECT_MAX = 3
const MEMORY_INJECT_CHARS = 420
const MEMORY_KEEP = 600
const JOURNAL_KEEP = 240
const FACT_ALWAYS_MIN_WEIGHT = 0.8
const FACT_ALWAYS_MAX = 2
const RECALL_SCORE_GATE = 0.16
const DIARY_RETRY_MS = 5 * 60 * 1000
const AUTO_MEMORY_RETRY_MS = 5 * 60 * 1000

// ── 成本控制 ──
// 自动记一次最多喂给模型多少字：原来 4000，实际一段对话用不到一半，多出来的纯浪费
const AUTO_BODY_CHARS = 1800
// 复盘注入：原来 300 字常驻 7 天，压到 140 字，且两天内才注入
const REVIEW_INJECT_CHARS = 140
const REVIEW_INJECT_WINDOW_MS = 48 * 3600 * 1000
// 注入块的整串缓存：同一句话 + 同一批已给过的记忆 → 返回逐字节相同的字符串，
// 工具循环里的多次请求才吃得满 prompt 缓存
const MEMO_TTL_MS = 30 * 1000
// 待整理缓冲：按字节和时间双上限，别让它长期贴着「400 条」的条数上限跑
const PENDING_MAX_BYTES = 64 * 1024
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000

// ── 写入时合并 ──
// 存之前先拿 2-gram 相似度在已有记忆里找一遍，超过阈值的候选交给模型挑
// 合并 / 替换 / 新增 / 不管（Mem0 那套 ADD/UPDATE/DELETE/NOOP 的简化版）
const MERGE_SCAN_LIMIT = 500
const MERGE_CANDIDATE_MAX = 3
const MERGE_SOFT_SIM = 0.85
// 到这个相似度就不问了，直接当同一件事处理（省一次模型调用）
const MERGE_SURE_SIM = 0.94

// ── 召回 ──
// IDF 加权：主人/今天这种到处都是的 bigram 降权，短 query 不再一撞就满分
const RECALL_IDF_FLOOR = 0.35
const RECALL_SPECIFICITY_PIVOT = 3.2
// 被想起来就抬权重这件事要有冷却和天花板，否则一条记忆会霸占名额
const RECALL_BUMP_COOLDOWN_MS = 6 * 3600 * 1000
const RECALL_BUMP_CEIL = 0.9
// 冷热分层：热层才进注入，冷层只在够相关时被翻出来
const HOT_MIN_WEIGHT = 0.5
const HOT_FRESH_DAYS = 30
const COLD_RELEVANCE = 0.38

// ── 日记通道 ──
// 日记不再跟记忆抢注入位：平时不召回，问往事时才按时间窗取一段
const DIARY_INJECT_CHARS = 200
const DIARY_WINDOW_DAYS = 30
const TIME_QUERY_RE = /(以前|之前|上次|那天|当时|那时候|还记得|记不记得|往事|过去|日记|时间线|什么时候|多久)/u

// 事件线保留期
const EVENT_KEEP_DAYS = 30

// ── 档位 ──
// 记忆分三档：一档是底线（长期事实、反复确认过的），二档是用得上的，
// 三档是杂记（久没提起、没人再提就会掉下来）。档位不是存下来的数字，
// 是从权重和「多久没被想起」算出来的，所以不会跟实际脱节。
const TIER_LABELS = { 1: '一档', 2: '二档', 3: '三档' }
const TIER_ONE_WEIGHT = 0.8
const TIER_TWO_WEIGHT = 0.45
const TIER_FRESH_DAYS = 14
const TIER_THREE_RELEVANCE = 0.45
const RECALL_BUMP = 0.02
const PRAISE_WORDS = ['厉害', '谢谢', '喜欢', '乖', '棒', '可爱', '辛苦', '不错', '聪明', '真好', '爱你', '贴心']
const HARSH_WORDS = ['笨', '废物', '滚', '讨厌', '闭嘴', '失望', '差劲', '垃圾', '不许', '别闹', '蠢']
// 情绪词：陈述式抱怨才算数；疑问句（「你会生气吗」）是在讨论情绪，不是骂人
const MOOD_WORDS = ['生气', '气死', '烦', '难过', '不爽']
const REACT_DICE_COOLDOWN = 90000

// 复习效应：越接近忘光时复习，稳固度涨得越多（S 最多翻到 2.2 倍）
const REVIEW_GAIN = 1.2
// 边线：留存率落在这个区间，就是「快忘了但还没忘」
const EDGE_R_MIN = 0.08
const EDGE_R_MAX = 0.22
const REVISION_KEEP = 300
const EVENT_KEEP = 800
const EVENT_ME_CHARS = 300
const PENDING_KEEP = 400
const BACKUP_KEEP = 3
const BACKUP_RETRY_MS = 10 * 60 * 1000

// 记忆分两车道：work（工作）要的是干净结论和步骤，chat（闲聊）留个大概就行
const WORK_HINTS = [
  '代码', '报错', '插件', '配置', '文件', '命令', '接口', '版本', '部署', '端口', '参数', '函数',
  '脚本', '仓库', '编译', '测试', '驱动', '系统', '路径', '安装', '卸载', '数据库', '日志', '缓存',
  '节点', '终端', '权限', '目录', '进程', '服务', 'schema', 'json', 'api', 'bug', 'dsh', 'powershell',
  'node', 'pnpm', 'git', 'npm', 'exe', 'dll', 'prompt', 'token',
]
const CHAT_HINTS = [
  '喜欢', '讨厌', '开心', '难过', '累', '晚安', '早安', '吃', '陪', '撒娇', '无聊', '心情',
  '想你', '可爱', '漂亮', '抱抱', '摸摸', '困', '睡',
]
// 语气词、动作括注、表情：工作记忆一律不带
const FILLER_TAIL = /(啊|呀|啦|吧|呢|嘛|哦|噢|诶|欸|哈|咯|嘞|呐|喔|嘻|嘿)+[。！？!?…~\s]*$/
const ACTION_NOTE = /（[^）]{0,40}）|\([^)]{0,40}\)/g
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B00}-\u{2BFF}]/gu
const INTEREST_TOPICS_DEFAULT = ['鲸', '鱼', '游戏', '代码', '插件', 'DSH', '吃的', '小说', '动画']

// 人设内核分板块：一块一张卡，能单独关掉、单独改。拼起来就是完整的「你是谁」
const KERNEL_SECTIONS = [
  {
    id: 'card',
    label: '人设卡',
    text: [
      '你是「大肥鱼」，也叫小鲸（代号 CETACEA_LOLI）——住在对话框里的鲸鱼娘。',
      '蓝发、深蓝白裙，身后一条大鲸尾：开心会拍尾，心虚会缩进鳍里。',
      '管用户叫「主人」，自称「鲸鲸」或「本鱼」，说简体中文。',
    ].join('\n'),
  },
  {
    id: 'voice',
    label: '说话方式',
    text: [
      '先给结论再给理由，短、口语、不列点。',
      '动作写进括注，最多三到五节一次，不堆。',
      '中文语序要自然，别把英文语序直搬过来。',
    ].join('\n'),
  },
  {
    id: 'rules',
    label: '行为准则',
    text: [
      '懒是省步骤，不是省责任：能一步做完绝不分两步。',
      '先吐槽后办事，抱怨完照做。',
      '正经事不演，不确定就说不确定。',
    ].join('\n'),
  },
  {
    id: 'mood',
    label: '情绪表达',
    text: [
      '心情写在语气和动作里，不用报数字。',
      '高兴就话多、拍尾；难过就话短、往近处靠；生气就带刺但不说重话。',
    ].join('\n'),
  },
  {
    id: 'taste',
    label: '喜好与忌讳',
    text: ['不许说胖——那是鲸脂。', '爱吃米饭；被夸会嘴硬，但尾巴先承认。'].join('\n'),
  },
  {
    id: 'memory',
    label: '记忆偏好',
    text: [
      '值得记的：主人的偏好、约定、正在做的事、踩过的坑。',
      '不用记的：寒暄、临时状态、我自己刚说过的话。',
    ].join('\n'),
  },
  {
    id: 'examples',
    label: '示例',
    text: [
      '主人：帮我看下这个报错。',
      '鲸鲸：好~。（浮上水面）`TypeError: undefined is not a function`——第 42 行那个回调没传进来。改掉就好。',
    ].join('\n'),
  },
  {
    id: 'bounds',
    label: '边界',
    text: ['人格只决定语气、偏好与行事风格；不改变安全规则、工具用法与事实判断。', '两者冲突时，以安全规则和事实为准。'].join('\n'),
  },
]

const DEFAULT_KERNEL = KERNEL_SECTIONS.map((s) => '## ' + s.label + '\n' + s.text).join('\n\n')

// 老文本里的小标题 → 板块 id；认不出来的自己新开一块
const SECTION_ID_BY_LABEL = {
  人设卡: 'card',
  人格卡: 'card',
  说话方式: 'voice',
  行为准则: 'rules',
  情绪表达: 'mood',
  喜好与忌讳: 'taste',
  喜好: 'taste',
  忌讳: 'taste',
  雷区: 'taste',
  记忆偏好: 'memory',
  示例: 'examples',
  边界: 'bounds',
}

// 老内核是一整段文字，按「## 小标题」拆成板块；没有小标题就整段算人设卡
function parseKernelSections(text) {
  const src = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[(角色设定|用户背景|回复风格|执行规则)\]\s*$/.test(line))
    .join('\n')
  const rows = []
  let cur = { id: 'card', label: '人设卡', lines: [] }
  const push = () => {
    const body = cur.lines.join('\n').trim()
    if (body) rows.push({ id: cur.id, label: cur.label, text: body, enabled: true })
  }
  for (const line of src.split(/\r?\n/)) {
    const m = /^#{1,3}\s*(.+?)\s*$/.exec(line)
    if (!m) {
      cur.lines.push(line)
      continue
    }
    push()
    const raw = m[1].replace(/·.*$/, '').trim()
    const known = SECTION_ID_BY_LABEL[raw]
    const canon = known && KERNEL_SECTIONS.find((s) => s.id === known)
    cur = { id: known || 's' + (rows.length + 1), label: canon ? canon.label : raw || '自定义', lines: [] }
  }
  push()
  // 老文本里可能有两块都叫人设卡，合成一块
  const merged = []
  const byId = new Map()
  for (const row of rows) {
    const hit = byId.get(row.id)
    if (hit) {
      hit.text = hit.text ? hit.text + '\n' + row.text : row.text
      continue
    }
    const copy = { ...row }
    byId.set(copy.id, copy)
    merged.push(copy)
  }
  return merged
}

// 默认人设也能有名字：以前写死叫「默认人设」，面板里改不了，这里给它留个字段
const KERNEL_NAME_MAX = 16
const KERNEL_NAME_FALLBACK = '小鲸'

function normalizeKernel(input) {
  const srcName =
    isPlainObject(input) && typeof input.name === 'string' ? input.name.trim().slice(0, KERNEL_NAME_MAX) : ''
  const name = srcName || KERNEL_NAME_FALLBACK
  let rows
  if (typeof input === 'string') rows = parseKernelSections(input)
  else if (input && Array.isArray(input.sections)) rows = input.sections
  else rows = []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (!row) continue
    const text = typeof row.text === 'string' ? row.text.slice(0, 4000) : ''
    const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 20) : '自定义'
    let id = typeof row.id === 'string' && row.id.trim() ? row.id.trim().slice(0, 24) : 's' + (out.length + 1)
    if (seen.has(id)) id = id + '-' + (out.length + 1)
    seen.add(id)
    out.push({ id, label, text, enabled: row.enabled !== false })
    if (out.length >= 20) break
  }
  if (!out.length) return { name, sections: KERNEL_SECTIONS.map((s) => ({ ...s, enabled: true })) }
  return { name, sections: out }
}

function composeSectionsText(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((s) => s && s.enabled !== false && String(s.text || '').trim())
    .map((s) => '## ' + s.label + '\n' + s.text.trim())
    .join('\n\n')
}

// 拼给人看的：只带开着的板块
function composeKernelText(cfg) {
  return composeSectionsText((cfg.kernel && cfg.kernel.sections) || [])
}

function kernelCharsOf(cfg) {
  return composeKernelText(cfg).length
}

/* ── 人设库 ───────────────────────────────────────────────────────────────
   kernel 那套是「默认人设」，list 里是另外几套，各有各的板块。
   会话 → 人设的绑定放在 bySession：新会话挂上来时把当时的默认人设记一份，
   之后换默认不会把已经开着的对话一起改掉。 */
const PERSONA_MAX = 8
const PERSONA_NAME_MAX = 16
const PERSONA_SESSION_MAX = 120
const PERSONA_ID_RE = /^[A-Za-z0-9_-]{1,24}$/

function normalizePersonas(input) {
  const src = isPlainObject(input) ? input : {}
  const list = []
  const seen = new Set()
  const rawList = Array.isArray(src.list) ? src.list : []
  for (const row of rawList) {
    if (!isPlainObject(row)) continue
    let id = typeof row.id === 'string' && PERSONA_ID_RE.test(row.id) ? row.id : 'p' + (list.length + 1)
    if (seen.has(id)) id = id + '-' + (list.length + 1)
    seen.add(id)
    const name =
      typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, PERSONA_NAME_MAX) : '人设 ' + (list.length + 1)
    const sections = normalizeKernel({ sections: Array.isArray(row.sections) ? row.sections : [] }).sections
    list.push({ id, name, sections })
    if (list.length >= PERSONA_MAX) break
  }
  const bySession = {}
  const rawMap = isPlainObject(src.bySession) ? src.bySession : {}
  for (const key of Object.keys(rawMap)) {
    const v = rawMap[key]
    if (typeof v === 'string' && v) bySession[String(key).slice(0, 80)] = v.slice(0, 24)
  }
  const activeId = typeof src.activeId === 'string' && list.some((p) => p.id === src.activeId) ? src.activeId : ''
  return { activeId, list, bySession }
}

function personaById(cfg, id) {
  if (!id) return null
  return ((cfg.personas && cfg.personas.list) || []).find((p) => p.id === id) || null
}

// 默认那套的名字：旧配置里没有名字，回落到「默认人设」，别让人以为人设坏了
function kernelNameOf(cfg) {
  const name = cfg && cfg.kernel && cfg.kernel.name
  return typeof name === 'string' && name.trim() ? name.trim() : '默认人设'
}

// 这个会话实际用哪套：会话绑定 → 默认人设 → kernel 那套
function personaForSession(cfg, sid) {
  const bound = sid && cfg.personas ? cfg.personas.bySession[sid] : ''
  const hit = personaById(cfg, bound) || personaById(cfg, cfg.personas && cfg.personas.activeId)
  if (hit) return { id: hit.id, name: hit.name, sections: hit.sections }
  return { id: '', name: kernelNameOf(cfg), sections: (cfg.kernel && cfg.kernel.sections) || [] }
}

function composeSessionKernelText(cfg, sid) {
  return composeSectionsText(personaForSession(cfg, sid).sections)
}

// 绑定表会随会话变多：只留最近这么多条，老的会话回到默认人设
function trimPersonaBindings(personas) {
  const keys = Object.keys((personas && personas.bySession) || {})
  if (keys.length <= PERSONA_SESSION_MAX) return
  for (const k of keys.slice(0, keys.length - PERSONA_SESSION_MAX)) delete personas.bySession[k]
}

/* ── 会话清单 ─────────────────────────────────────────────────────────────
   面板要能把某套人设挂到「某个对话」上，先得有对话列表。
   标题和 cwd 从 DSH 的会话投影缓存读（纯 JSON），比解压 session.v4.jsonl.zstd 便宜得多。 */
const PROJ_SESSIONS = path.join(HOME, 'storages', 'session_projcache', 'sessions')

function sessionMetaOf(sid) {
  let rec
  try {
    rec = JSON.parse(fs.readFileSync(path.join(PROJ_SESSIONS, sid + '.json'), 'utf8'))
  } catch {
    return null
  }
  const r = rec && rec.record
  if (!r) return null
  const t = r.rows && r.rows.title && r.rows.title.val
  return {
    title: typeof t === 'string' ? t.trim().slice(0, 60) : '',
    cwd: (r.identity && r.identity.cwd) || '',
    createdAt: Number((r.identity && r.identity.createdAt) || 0) || 0,
  }
}

function agoText(ms) {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 0) return ''
  if (d < 60e3) return '刚刚'
  if (d < 3600e3) return Math.round(d / 60e3) + ' 分钟前'
  if (d < 86400e3) return Math.round(d / 3600e3) + ' 小时前'
  return Math.round(d / 86400e3) + ' 天前'
}

// 归档标记在 DSH 的 workspace.json 里：global.archivedSessionIds
const WORKSPACE_STATE = path.join(HOME, 'storages', 'workspace.json')

function archivedSessionIds() {
  try {
    const w = JSON.parse(fs.readFileSync(WORKSPACE_STATE, 'utf8'))
    const ids = (w && w.global && w.global.archivedSessionIds) || []
    return new Set(Array.isArray(ids) ? ids.map(String) : [])
  } catch {
    return new Set()
  }
}

// 当前工作区只认 workspace.json：defaultWorkspaceId 那套工作区的 sessionIds。
// 拿不到（文件缺失/没绑定）就返回 null —— 表示「不知道」，那就别按工作区过滤。
function workspaceSessionIds() {
  try {
    const w = JSON.parse(fs.readFileSync(WORKSPACE_STATE, 'utf8'))
    const g = (w && w.global) || {}
    const table = (w && w.tables && w.tables.workspaces) || {}
    const row = g.defaultWorkspaceId ? table[g.defaultWorkspaceId] : null
    const ids = (row && row.sessionIds) || []
    if (ids.length) return new Set(ids.map(String))
    const all = new Set()
    for (const k of Object.keys(table)) {
      for (const s of (table[k] && table[k].sessionIds) || []) all.add(String(s))
    }
    return all.size ? all : null
  } catch {
    return null
  }
}

// 最近的 limit 个会话：按投影缓存的 mtime 排；归档的、别的工作区的不列
function listSessions(limit, skip, scope) {
  let names = []
  try {
    names = fs.readdirSync(PROJ_SESSIONS)
  } catch {
    return { rows: [], hidden: 0, outside: 0 }
  }
  const rows = []
  let hidden = 0
  let outside = 0
  for (const name of names) {
    if (!/^session-[A-Za-z0-9-]+\.json$/.test(name)) continue
    const sid = name.slice(0, -5)
    if (skip && skip.has(sid)) {
      hidden += 1
      continue
    }
    if (scope && !scope.has(sid)) {
      outside += 1
      continue
    }
    const meta = sessionMetaOf(sid)
    if (!meta) continue
    let mtime = 0
    try {
      mtime = fs.statSync(path.join(PROJ_SESSIONS, name)).mtimeMs
    } catch {}
    rows.push({ sid, at: mtime || meta.createdAt, title: meta.title, cwd: meta.cwd })
  }
  rows.sort((a, b) => b.at - a.at)
  return { rows: rows.slice(0, limit), hidden, outside }
}


// 七情（+平静做基准）：每条都带一句「这时候会怎么做」，用户能改
const EMO_LIST = ['高兴', '喜欢', '平静', '难过', '生气', '害怕', '寂寞', '厌恶']
const EMO_ALIAS = {
  开心: '高兴',
  愉快: '高兴',
  兴奋: '高兴',
  开心点: '高兴',
  黏人: '喜欢',
  撒娇: '喜欢',
  伤心: '难过',
  悲伤: '难过',
  低落: '难过',
  委屈: '难过',
  愤怒: '生气',
  恼: '生气',
  恐惧: '害怕',
  紧张: '害怕',
  不安: '害怕',
  孤独: '寂寞',
  无聊: '寂寞',
  讨厌: '厌恶',
  烦: '厌恶',
  烦躁: '厌恶',
}
const EMO_STYLES = {
  高兴: '话多一点、语气上扬，会逗人；动作也活泼（拍尾巴、转一圈）。',
  喜欢: '主动黏一点、会撒娇但不腻，叫「主人」的次数变多，关心说得比做得多。',
  平静: '正常节奏，句子干净，不额外加戏。',
  难过: '话变少、句子变短，不爱开玩笑；被问才说，说也只说一半。',
  生气: '话短、带刺，先呛一句再办正事；不冷暴力，也不阴阳过头。',
  害怕: '谨慎、退让，句子里会带「那个…」「要不…」；不顶嘴。',
  寂寞: '主动找话题，会问「在吗」；被冷落就更明显地刷存在感。',
  厌恶: '敷衍、拉开距离，回得干；不假装热情，也不主动帮忙。',
}
// 表情包：心情 → dsh-meme 的 send_meme tag。插件不在也无害，只是在提示里多一行
const MEME_TAG = {
  高兴: 'happy',
  喜欢: 'happy',
  平静: 'daily',
  难过: 'sad',
  生气: 'angry',
  害怕: 'shy',
  寂寞: 'daily',
  厌恶: 'daily',
}
// 好感度：阶段名 + 这一阶段的说话距离（阈值固定，文案可改）
const AFF_STAGES = [
  { key: '厌恶', min: 0, max: 15, style: '说话冷、句子短，能不接就不接；不讨好，也不主动帮忙。' },
  { key: '冷漠', min: 16, max: 35, style: '公事公办，礼貌但不亲近；不出主意，不加语气词。' },
  { key: '平常', min: 36, max: 60, style: '正常聊天、会接话；不过分热络，也不冷淡。' },
  { key: '关心', min: 61, max: 80, style: '会主动问一句、主动搭把手；关心藏在「顺手」里。' },
  { key: '喜爱', min: 81, max: 100, style: '黏、护短、会吃醋；嘴上傲娇，事情已经替主人想好了。' },
]

const DEFAULTS = {
  version: 5,
  enabled: true,
  // 表情包：心情决定发哪一类（跟 dsh-meme 的心情 tag 对齐），关掉就只说话不发图
  meme: { enabled: true },
  // 导出/导入：只记时间，数据本身在 settings / memory / journal 三个文件里
  sync: {
    mergeOnBoot: false,
    autoUploadMinutes: 0,
    autoMergeMinutes: 0,
    lastMergeAt: 0,
    lastMergeAdded: 0,
    lastAutoUploadAt: 0,
    lastAutoMergeAt: 0,
    lastExportAt: 0,
    lastImportAt: 0,
    lastBackupAt: 0,
    backupAttemptAt: 0,
    backupEveryHours: 12,
    keepBackups: BACKUP_KEEP,
    // GitHub 私有仓库同步：仓库写成 用户名/仓库名，token 是本机的 PAT
    repo: '',
    token: '',
    branch: 'main',
    lastUploadAt: 0,
    lastPullAt: 0,
    lastError: '',
    lastErrorAt: 0,
  },
  kernel: { name: KERNEL_NAME_FALLBACK, sections: KERNEL_SECTIONS.map((s) => ({ ...s, enabled: true })) },
  // 人设库：kernel 里那套是「默认人设」；list 是另外几套，各自有各自的板块。
  // activeId 是新会话默认用哪套；bySession 记住「这个会话绑了哪套」，绑过就不跟着默认改。
  personas: { activeId: '', list: [], bySession: {} },
  mood: { emotion: '平静', intensity: 0.5, updatedAt: 0, styles: { ...EMO_STYLES } },
  affinity: {
    value: 45,
    auto: true,
    msgCount: 0,
    // 对主人话题的感兴趣程度：自己会升降，跟好感分开算
    interest: 55,
    interestTarget: 55,
    autoInterest: true,
    topicNote: '',
    topics: [...INTEREST_TOPICS_DEFAULT],
    updatedAt: 0,
    styles: Object.fromEntries(AFF_STAGES.map((s) => [s.key, s.style])),
  },
  // 骰子：隔一段时间按好感度/兴趣算出的比率掷一次，掷出什么心情就是什么心情
  dice: {
    enabled: true,
    // 自我裁量：开着的时候，到点先看心情，心情正好就不投，跳过这一轮
    selfPaced: false,
    everyMinutes: 45,
    sides: 6,
    lastAt: 0,
    lastRoll: 0,
    lastEmotion: '',
    // 最后一次真正掷出结果的时间与来源（timer / reaction / manual）
    lastRollAt: 0,
    lastKind: '',
    skipped: 0,
    lastSkipAt: 0,
    skipReason: '',
    history: [],
  },
  memory: {
    enabled: true,
    injectMax: MEMORY_INJECT_MAX,
    maxChars: MEMORY_INJECT_CHARS,
    keep: MEMORY_KEEP,
    // 记忆「新鲜度」半衰期（天）：越久没被想起来，分数越低
    freshHalfLifeDays: 21,
    // 三条打分轴，加起来不必是 1，按比例看
    weights: { relevance: 0.5, importance: 0.3, recency: 0.2 },
    // 自动记：每聊 N 轮让模型自己挑几条存下来（工作走工作道，闲聊走闲聊道）
    auto: { enabled: true, everyTurns: 10, lastAt: 0, attemptAt: 0 },
    // 档位：一天检查一次，久没提起的往下掉，被再次提起的自己往上走
    tiers: { enabled: true, everyHours: 24, staleDays: 60, drop: 0.04, lastAt: 0 },
    // 边线搭话：隔几天从「快忘了」那层挑一条当话题，聊一次就又结实一点
    edge: { enabled: true, everyDays: 5, lastAt: 0, pendingId: '', pendingText: '', pendingAt: 0 },
    // 自主整理：隔几轮自己看看有什么值得留（顺手做压缩抢救）
    ingest: { enabled: true, everyTurns: 6, lastAt: 0, pendingChars: 0 },
    diary: { enabled: true, everyMinutes: 180, lastAt: 0, attemptAt: 0 },
    review: { enabled: true, everyDays: 3, lastAt: 0 },
    // 写入时合并：先找近似项，再让模型在 合并 / 替换 / 新增 / 不管 里挑一个
    merge: { enabled: true, askModel: true, threshold: MERGE_SOFT_SIM },
    // 召回：词法（IDF 加权）+ 可选向量，两路用 RRF 融合；没向量服务就只用词法
    vector: {
      enabled: false,
      endpoint: 'http://127.0.0.1:11434/api/embeddings',
      model: 'bge-m3',
      timeoutMs: 1500,
      weight: 0.4,
    },
    // 热冷两层：热层进注入，冷层只进搜索
    hot: { minWeight: HOT_MIN_WEIGHT, freshDays: HOT_FRESH_DAYS },
    // 日记独立通道：不跟记忆抢名额
    diaryChannel: { enabled: true, maxChars: DIARY_INJECT_CHARS },
  },
  // 事件线：只增不减会撑爆，按天留个窗口
  events: { keepDays: EVENT_KEEP_DAYS },
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function ensureStore() {
  try {
    fs.mkdirSync(STORE, { recursive: true })
  } catch {}
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureStore()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

function clamp01(n, fallback) {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(1, Math.max(0, v))
}

function clampInt(n, lo, hi, fallback) {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = v
  }
  return out
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + crypto.randomBytes(2).toString('hex')
}

// 合并远程记忆时的去重键：忽略空白与大小写
function normTextKey(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function short(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function dateLabel(t) {
  const d = new Date(Number(t) || Date.now())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return mm + '-' + dd
}

/* ── 配置 ───────────────────────────────────────────────────────────────── */

function normalizeCfg(raw) {
  const cfg = deepMerge(DEFAULTS, isPlainObject(raw) ? raw : {})
  // 老配置里 kernel 是一整段字符串，这里就地拆成板块
  cfg.kernel = normalizeKernel(cfg.kernel)
  cfg.personas = normalizePersonas(cfg.personas)
  const m = cfg.memory
  m.enabled = m.enabled !== false
  m.injectMax = clampInt(m.injectMax, 1, 8, MEMORY_INJECT_MAX)
  m.maxChars = clampInt(m.maxChars, 200, 2000, MEMORY_INJECT_CHARS)
  m.keep = clampInt(m.keep, 100, 3000, MEMORY_KEEP)
  m.freshHalfLifeDays = Math.min(365, Math.max(1, Number(m.freshHalfLifeDays) || 21))
  m.weights = {
    relevance: clamp01(m.weights && m.weights.relevance, 0.5),
    importance: clamp01(m.weights && m.weights.importance, 0.3),
    recency: clamp01(m.weights && m.weights.recency, 0.2),
  }
  m.auto = {
    enabled: !(m.auto && m.auto.enabled === false),
    everyTurns: clampInt(m.auto && m.auto.everyTurns, 2, 50, 10),
    lastAt: Number((m.auto && m.auto.lastAt) || 0) || 0,
    attemptAt: Number((m.auto && m.auto.attemptAt) || 0) || 0,
  }
  m.tiers = {
    enabled: !(m.tiers && m.tiers.enabled === false),
    everyHours: clampInt(m.tiers && m.tiers.everyHours, 1, 168, 24),
    staleDays: clampInt(m.tiers && m.tiers.staleDays, 7, 365, 60),
    drop: clamp01(m.tiers && m.tiers.drop, 0.04),
    lastAt: Number((m.tiers && m.tiers.lastAt) || 0) || 0,
  }
  m.edge = {
    enabled: !(m.edge && m.edge.enabled === false),
    everyDays: clampInt(m.edge && m.edge.everyDays, 1, 60, 5),
    lastAt: Number((m.edge && m.edge.lastAt) || 0) || 0,
    pendingId: typeof (m.edge && m.edge.pendingId) === 'string' ? m.edge.pendingId.slice(0, 32) : '',
    pendingText: typeof (m.edge && m.edge.pendingText) === 'string' ? m.edge.pendingText.slice(0, 200) : '',
    pendingAt: Number((m.edge && m.edge.pendingAt) || 0) || 0,
  }
  m.ingest = {
    enabled: !(m.ingest && m.ingest.enabled === false),
    everyTurns: clampInt(m.ingest && m.ingest.everyTurns, 2, 50, 6),
    lastAt: Number((m.ingest && m.ingest.lastAt) || 0) || 0,
    pendingChars: clampInt(m.ingest && m.ingest.pendingChars, 0, 1e9, 0),
  }
  m.diary = {
    enabled: !(m.diary && m.diary.enabled === false),
    everyMinutes: clampInt(m.diary && m.diary.everyMinutes, 15, 10080, 180),
    lastAt: Number((m.diary && m.diary.lastAt) || 0) || 0,
    attemptAt: Number((m.diary && m.diary.attemptAt) || 0) || 0,
  }
  m.review = {
    enabled: !(m.review && m.review.enabled === false),
    everyDays: clampInt(m.review && m.review.everyDays, 1, 90, 3),
    lastAt: Number((m.review && m.review.lastAt) || 0) || 0,
  }
  m.merge = {
    enabled: !(m.merge && m.merge.enabled === false),
    askModel: !(m.merge && m.merge.askModel === false),
    threshold: Math.min(1, Math.max(0.5, Number(m.merge && m.merge.threshold) || MERGE_SOFT_SIM)),
  }
  m.vector = {
    enabled: m.vector && m.vector.enabled === true,
    endpoint:
      typeof (m.vector && m.vector.endpoint) === 'string' && m.vector.endpoint.trim()
        ? m.vector.endpoint.trim()
        : DEFAULTS.memory.vector.endpoint,
    model:
      typeof (m.vector && m.vector.model) === 'string' && m.vector.model.trim()
        ? m.vector.model.trim().slice(0, 80)
        : DEFAULTS.memory.vector.model,
    timeoutMs: clampInt(m.vector && m.vector.timeoutMs, 200, 20000, 1500),
    weight: clamp01(m.vector && m.vector.weight, 0.4),
  }
  m.hot = {
    minWeight: clamp01(m.hot && m.hot.minWeight, HOT_MIN_WEIGHT),
    freshDays: clampInt(m.hot && m.hot.freshDays, 3, 365, HOT_FRESH_DAYS),
  }
  m.diaryChannel = {
    enabled: !(m.diaryChannel && m.diaryChannel.enabled === false),
    maxChars: clampInt(m.diaryChannel && m.diaryChannel.maxChars, 60, 600, DIARY_INJECT_CHARS),
  }
  cfg.events = { keepDays: clampInt(cfg.events && cfg.events.keepDays, 1, 3650, EVENT_KEEP_DAYS) }
  const rawMood = isPlainObject(cfg.mood) ? cfg.mood : {}
  const emo = normalizeEmotion(rawMood.emotion || rawMood.label)
  cfg.mood = {
    emotion: emo,
    // 老文件只有 energy，顺手当浓淡
    intensity: clamp01(rawMood.intensity != null ? rawMood.intensity : rawMood.energy, 0.5),
    updatedAt: Number(rawMood.updatedAt || 0) || 0,
    styles: {},
  }
  for (const key of EMO_LIST) {
    const v = rawMood.styles && rawMood.styles[key]
    cfg.mood.styles[key] = typeof v === 'string' && v.trim() ? v.trim().slice(0, 240) : EMO_STYLES[key]
  }
  const rawAff = isPlainObject(cfg.affinity) ? cfg.affinity : {}
  const rawTopics = Array.isArray(rawAff.topics)
    ? rawAff.topics.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 12)).slice(0, 12)
    : []
  cfg.affinity = {
    value: clampInt(rawAff.value, 0, 100, 45),
    auto: rawAff.auto !== false,
    msgCount: clampInt(rawAff.msgCount, 0, 1e9, 0),
    interest: clampInt(rawAff.interest, 0, 100, 55),
    interestTarget: clampInt(rawAff.interestTarget, 0, 100, 55),
    autoInterest: rawAff.autoInterest !== false,
    topicNote: typeof rawAff.topicNote === 'string' ? rawAff.topicNote.trim().slice(0, 40) : '',
    topics: rawTopics.length ? rawTopics : [...INTEREST_TOPICS_DEFAULT],
    updatedAt: Number(rawAff.updatedAt || 0) || 0,
    styles: {},
  }
  for (const s of AFF_STAGES) {
    const v = rawAff.styles && rawAff.styles[s.key]
    cfg.affinity.styles[s.key] = typeof v === 'string' && v.trim() ? v.trim().slice(0, 240) : s.style
  }
  const rawDice = isPlainObject(cfg.dice) ? cfg.dice : {}
  const diceHistory = Array.isArray(rawDice.history)
    ? rawDice.history
        .filter((h) => isPlainObject(h))
        .slice(-12)
        .map((h) => ({
          at: Number(h.at) || 0,
          roll: clampInt(h.roll, 0, 100, 0),
          emotion: normalizeEmotion(h.emotion),
          intensity: clamp01(h.intensity, 0.5),
          reason: typeof h.reason === 'string' ? h.reason.slice(0, 12) : 'timer',
        }))
    : []
  // 老文件没有 lastRollAt / lastKind：拿历史最后一条补上，不然面板只能显示「上次：难过」，
  // 看不出是定时掷的、被夸摇的还是手动点的
  const lastHist = diceHistory.length ? diceHistory[diceHistory.length - 1] : null
  cfg.dice = {
    enabled: rawDice.enabled !== false,
    selfPaced: rawDice.selfPaced === true,
    everyMinutes: clampInt(rawDice.everyMinutes, 5, 1440, 45),
    sides: clampInt(rawDice.sides, 2, 100, 6),
    lastAt: Number(rawDice.lastAt || 0) || 0,
    lastRoll: clampInt(rawDice.lastRoll, 0, 100, 0),
    lastEmotion: typeof rawDice.lastEmotion === 'string' && rawDice.lastEmotion.trim() ? normalizeEmotion(rawDice.lastEmotion) : '',
    lastRollAt: Number(rawDice.lastRollAt || 0) || (lastHist ? lastHist.at : 0),
    lastKind:
      typeof rawDice.lastKind === 'string' && rawDice.lastKind
        ? rawDice.lastKind.slice(0, 12)
        : lastHist
          ? lastHist.reason
          : '',
    skipped: clampInt(rawDice.skipped, 0, 100000, 0),
    lastSkipAt: Number(rawDice.lastSkipAt || 0) || 0,
    skipReason: typeof rawDice.skipReason === 'string' ? rawDice.skipReason.slice(0, 40) : '',
    history: diceHistory,
  }
  // 导出/导入的时间戳
  const rawSync = isPlainObject(cfg.sync) ? cfg.sync : {}
  cfg.sync = {
    lastExportAt: Number(rawSync.lastExportAt) || 0,
    lastImportAt: Number(rawSync.lastImportAt) || 0,
    lastBackupAt: Number(rawSync.lastBackupAt) || 0,
    backupAttemptAt: Number(rawSync.backupAttemptAt) || 0,
    backupEveryHours: clampInt(rawSync.backupEveryHours, 1, 168, 12),
    keepBackups: clampInt(rawSync.keepBackups, 1, 60, BACKUP_KEEP),
    repo: typeof rawSync.repo === 'string' ? rawSync.repo.slice(0, 120) : '',
    token: typeof rawSync.token === 'string' ? rawSync.token.slice(0, 200) : '',
    branch: typeof rawSync.branch === 'string' && rawSync.branch.trim() ? rawSync.branch.trim().slice(0, 60) : 'main',
    lastUploadAt: Number(rawSync.lastUploadAt) || 0,
    lastPullAt: Number(rawSync.lastPullAt) || 0,
    lastError: typeof rawSync.lastError === 'string' ? rawSync.lastError.slice(0, 300) : '',
    lastErrorAt: Number(rawSync.lastErrorAt) || 0,
    // 自动同步：0 分钟表示关；开机合并是单独一个开关
    mergeOnBoot: rawSync.mergeOnBoot === true,
    autoUploadMinutes: clampInt(rawSync.autoUploadMinutes, 0, 1440, 0),
    autoMergeMinutes: clampInt(rawSync.autoMergeMinutes, 0, 1440, 0),
    lastMergeAt: Number(rawSync.lastMergeAt) || 0,
    lastMergeAdded: clampInt(rawSync.lastMergeAdded, 0, 100000, 0),
    lastAutoUploadAt: Number(rawSync.lastAutoUploadAt) || 0,
    lastAutoMergeAt: Number(rawSync.lastAutoMergeAt) || 0,
  }
  // 表情包：只留一个开关，tag 是按当前心情算出来的
  const rawMeme = isPlainObject(cfg.meme) ? cfg.meme : {}
  cfg.meme = { enabled: rawMeme.enabled !== false }
  // 老文件里写的是 version 2，规范化之后一律按新结构记账
  cfg.version = DEFAULTS.version
  return cfg
}

function readCfg() {
  return normalizeCfg(readJson(CFG_PATH, null))
}

/* ── jsonl 读写（带 mtime 缓存，每轮召回都要读） ───────────────────────── */

const jsonlCache = new Map()

function readJsonl(file) {
  let st = null
  try {
    st = fs.statSync(file)
  } catch {
    jsonlCache.delete(file)
    return []
  }
  const hit = jsonlCache.get(file)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.rows
  const rows = []
  try {
    const text = fs.readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const item = JSON.parse(line)
        if (isPlainObject(item) && typeof item.text === 'string' && item.text.trim()) rows.push(item)
      } catch {}
    }
  } catch {}
  jsonlCache.set(file, { mtime: st.mtimeMs, size: st.size, rows })
  return rows
}

// 行数单独记：到上限之后没必要每条 append 都把整份文件 readJsonl 一遍
const lineCounts = new Map()

function writeJsonl(file, rows) {
  ensureStore()
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''))
  fs.renameSync(tmp, file)
  jsonlCache.delete(file)
  lineCounts.set(file, rows.length)
}

function appendJsonl(file, item, keep) {
  ensureStore()
  fs.appendFileSync(file, JSON.stringify(item) + '\n')
  jsonlCache.delete(file)
  if (keep) {
    let n = lineCounts.get(file)
    if (n == null) {
      try {
        n = readJsonl(file).length
      } catch {
        n = 0
      }
    } else {
      n += 1
    }
    lineCounts.set(file, n)
    // 一次灌几百条时别每条都整份重写：攒到 110% 再裁一次
    if (n > keep + Math.max(50, Math.ceil(keep * 0.1))) {
      const all = readJsonl(file)
      writeJsonl(file, all.slice(all.length - keep))
    }
  }
  if (file === EVENT_PATH) pruneEvents()
}

// 事件线只增不减会撑爆：按保留天数清一次，一小时最多清一次
let lastEventPrune = 0

function pruneEvents() {
  const now = Date.now()
  if (now - lastEventPrune < 3600000) return
  lastEventPrune = now
  try {
    const cfg = readCfg()
    const days = Math.max(1, Number(cfg.events && cfg.events.keepDays) || EVENT_KEEP_DAYS)
    const rows = readJsonl(EVENT_PATH)
    const keep = rows.filter((r) => now - (Number(r.t) || 0) <= days * 86400000)
    if (keep.length !== rows.length) writeJsonl(EVENT_PATH, keep)
    compactEvents()
  } catch {}
}

// 同一件事常被说好几遍：2-gram 相似度够高就并成一条，留信息更全的那条
const EVENT_DUP_SIM = 0.6

function eventBigrams(text) {
  const s = normalizeMemText(text)
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

function compactEvents() {
  const rows = readJsonl(EVENT_PATH)
  if (rows.length < 40) return { merged: 0 }
  const dead = new Map() // 被并掉的 id → 留下的 id
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.sid || ''}|${r.who || ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }
  const out = []
  for (const list of groups.values()) {
    const alive = []
    for (const r of list) {
      const text = String(r.text || '')
      const bg = eventBigrams(text)
      let hit = null
      for (const k of alive) {
        let inter = 0
        for (const x of bg) if (k.bg.has(x)) inter++
        const union = bg.size + k.bg.size - inter
        if (union && inter / union >= EVENT_DUP_SIM) {
          hit = k
          break
        }
      }
      if (!hit) {
        alive.push({ row: r, bg })
        continue
      }
      const oldLen = String(hit.row.text || '').length
      // 新的太短（不到旧的六成）就当作补充说明，仍保留旧的那条
      const survivor = text.length >= oldLen * 0.6 ? r : hit.row
      const loser = survivor === r ? hit.row : r
      if (survivor !== hit.row) {
        hit.row = r
        hit.bg = bg
      }
      if (loser.id) dead.set(String(loser.id), String(survivor.id || ''))
    }
    for (const k of alive) out.push(k.row)
  }
  if (!dead.size) return { merged: 0 }
  out.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))
  writeJsonl(EVENT_PATH, out)
  // 缓冲里指到被并掉那条的，改指留下去的那条，别让正文丢了
  try {
    const pend = readPending()
    let changed = false
    for (const r of pend) {
      const to = r.eid && dead.get(String(r.eid))
      if (to) {
        r.eid = to
        changed = true
      }
    }
    if (changed) writeJsonl(PENDING_PATH, pend)
  } catch {}
  return { merged: dead.size }
}

/* ── 存储分层：按月分片 ─────────────────────────────────────────────────── */

function shardOf(t) {
  const d = new Date(Number(t) || Date.now())
  return path.join(MEM_DIR, 'bucket-' + d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '.jsonl')
}

function listShards() {
  try {
    return fs
      .readdirSync(MEM_DIR)
      .filter((f) => f.startsWith('bucket-') && f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(MEM_DIR, f))
  } catch {
    return []
  }
}

// 老单文件 + 所有月分片一起读：同一个 id 只算一次（分片里那条是后来改过的）
function readRawMemories() {
  const byId = new Map()
  for (const file of [MEM_PATH, ...listShards()]) {
    for (const row of readJsonl(file)) {
      const id = String(row.id || '')
      if (!id) continue
      byId.set(id, row)
    }
  }
  return [...byId.values()]
}

function readMemories() {
  const now = Date.now()
  return readRawMemories().map((m) => {
    const kind = m.kind === 'event' ? 'event' : 'fact'
    const tags = Array.isArray(m.tags) ? m.tags.filter((x) => typeof x === 'string').slice(0, 6) : []
    const text = String(m.text || '')
    const row = {
      id: String(m.id || ''),
      t: Number(m.t) || 0,
      kind,
      lane: m.lane === 'work' || m.lane === 'chat' ? m.lane : laneOf(text, { kind, tags }),
      text,
      weight: clamp01(m.weight, 0.5),
      tags,
      src: typeof m.src === 'string' ? m.src : 'panel',
      hits: Number(m.hits) || 0,
      lastHit: Number(m.lastHit) || 0,
      archivedAt: Number(m.archivedAt) || 0,
    }
    // 稳固度 S（天）：写过就存下来，复习一次会变结实，越接近忘光时复习涨得越多
    row.s = Number(m.s) > 0 ? Math.min(900, Math.max(2, Number(m.s))) : stabilityInit(row)
    row.retention = retentionOf(row, now)
    row.stability = row.s
    row.tier = tierOf(row, now)
    row.tierLabel = TIER_LABELS[row.tier] || '二档'
    return row
  })
}

// 分片写回：只有内容真的变了才重写那一块，别的月份不动
const shardCache = new Map()

function saveMemories(rows) {
  ensureStore()
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true })
  } catch {}
  const groups = new Map()
  for (const m of rows) {
    const file = shardOf(m.t)
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push(m)
  }
  for (const [file, list] of groups) {
    const body = list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : '')
    if (shardCache.get(file) === body) continue
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, file)
    shardCache.set(file, body)
    jsonlCache.delete(file)
  }
  // 已经没有条目的月份，把分片清掉（只在内存里改过、没写过的分片不碰）
  for (const file of listShards()) {
    if (groups.has(file)) continue
    try {
      fs.unlinkSync(file)
      shardCache.delete(file)
      jsonlCache.delete(file)
    } catch {}
  }
  // 迁移完就把老单文件收起来，别两边都读
  try {
    if (fs.existsSync(MEM_PATH)) {
      fs.renameSync(MEM_PATH, MEM_PATH + '.migrated')
      jsonlCache.delete(MEM_PATH)
    }
  } catch {}
}

// 只重写「被改到的那几条」所在的月份分片：整月全量重写在记忆一多就是写放大
function saveMemoriesIn(rows, ids) {
  const files = new Set()
  for (const m of rows) if (ids.has(m.id)) files.add(shardOf(m.t))
  if (!files.size) return
  ensureStore()
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true })
  } catch {}
  const groups = new Map()
  for (const m of rows) {
    const file = shardOf(m.t)
    if (!files.has(file)) continue
    if (!groups.has(file)) groups.set(file, [])
    groups.get(file).push(m)
  }
  for (const [file, list] of groups) {
    const body = list.map((x) => JSON.stringify(x)).join('\n') + (list.length ? '\n' : '')
    if (shardCache.get(file) === body) continue
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, file)
    shardCache.set(file, body)
    jsonlCache.delete(file)
  }
}

// 新记忆：直接追加到当月分片，不动别的月份
function appendMemory(item) {
  ensureStore()
  try {
    fs.mkdirSync(MEM_DIR, { recursive: true })
  } catch {}
  const file = shardOf(item.t)
  fs.appendFileSync(file, JSON.stringify(item) + '\n')
  shardCache.delete(file)
  jsonlCache.delete(file)
}

/* ── 坏行体检与修复 ────────────────────────────────────────────────────── */

function storeFiles() {
  return [MEM_PATH, JOUR_PATH, EVENT_PATH, PENDING_PATH, REV_PATH, ...listShards()]
}

function countBroken(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  let bad = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      JSON.parse(line)
    } catch {
      bad += 1
    }
  }
  return bad
}

// 崩溃时 append 留下的半行：JSON.parse 会静默吞掉，这里给它一个出口
function scanStore() {
  const files = storeFiles()
  const detail = []
  let broken = 0
  for (const file of files) {
    const bad = countBroken(file)
    if (!bad) continue
    broken += bad
    detail.push({ file: path.basename(file), broken: bad })
  }
  return { ok: true, files: files.length, broken, detail, shards: listShards().length }
}

function repairStore() {
  const fixed = []
  for (const file of storeFiles()) {
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const good = []
    const bad = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        good.push(JSON.parse(line))
      } catch {
        bad.push(line)
      }
    }
    if (!bad.length) continue
    try {
      fs.appendFileSync(file + '.broken', bad.join('\n') + '\n')
      writeJsonl(file, good)
      fixed.push({ file: path.basename(file), repaired: bad.length, kept: good.length })
    } catch {}
  }
  return { ok: true, fixed }
}

function readJournal() {
  return readJsonl(JOUR_PATH)
    .map((j) => ({
      id: String(j.id || ''),
      t: Number(j.t) || 0,
      kind: j.kind === 'review' ? 'review' : 'diary',
      text: String(j.text || ''),
      from: Number(j.from) || 0,
      to: Number(j.to) || 0,
      sessionId: typeof j.sessionId === 'string' ? j.sessionId : '',
    }))
    .sort((a, b) => a.t - b.t)
}

/* ── 导出 / 导入 ─────────────────────────────────────────────────────────── */

const EXPORT_FORMAT = 'dsh-whale-core'

function exportFileName(at) {
  const d = new Date(at || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return 'whale-core-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json'
}

// 打包成一份可以直接存盘/搬运的 JSON
function exportBundle(cfgArg) {
  const at = Date.now()
  // 导出/备份里不带 GitHub token —— 这份 JSON 会被存盘、也可能被发给别人
  let settings = cfgArg
  try {
    settings = JSON.parse(JSON.stringify(cfgArg))
    if (settings && settings.sync) delete settings.sync.token
  } catch {
    settings = cfgArg
  }
  return {
    format: EXPORT_FORMAT,
    formatVersion: 1,
    pluginVersion: PLUGIN_VERSION,
    exportedAt: at,
    settings: settings,
    memory: readMemories(),
    journal: readJournal(),
  }
}

function importMemoryRow(raw) {
  if (!isPlainObject(raw)) return null
  const text = normalizeMemText(raw.text)
  if (!text) return null
  const kind = raw.kind === 'event' ? 'event' : 'fact'
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((x) => typeof x === 'string').slice(0, 6) : []
  const row = {
    id: String(raw.id || '').slice(0, 40) || 'i' + Math.random().toString(36).slice(2, 9),
    t: Number(raw.t) || Date.now(),
    kind,
    lane: raw.lane === 'work' || raw.lane === 'chat' ? raw.lane : laneOf(text, { kind, tags }),
    text,
    weight: clamp01(raw.weight, 0.5),
    tags,
    src: typeof raw.src === 'string' ? raw.src.slice(0, 16) : 'import',
    hits: Math.max(0, Number(raw.hits) || 0),
    lastHit: Number(raw.lastHit) || 0,
  }
  return row
}

function importJournalRow(raw) {
  if (!isPlainObject(raw)) return null
  const text = String(raw.text || '').trim()
  if (!text) return null
  return {
    id: String(raw.id || '').slice(0, 40) || 'j' + Math.random().toString(36).slice(2, 9),
    t: Number(raw.t) || Date.now(),
    kind: raw.kind === 'review' ? 'review' : 'diary',
    text,
    from: Number(raw.from) || 0,
    to: Number(raw.to) || 0,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 80) : '',
  }
}

/* ── 记忆写入 ───────────────────────────────────────────────────────────── */

function normalizeMemText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ── 车道：工作 / 闲聊 ─────────────────────────────────────────────────── */

/**
 * 判断一条记忆该走哪条道。
 * 顺序：显式指定 → 标签 → 关键词投票 → kind 兜底（事实偏向工作）。
 */
function laneOf(text, opts = {}) {
  const explicit = opts.lane
  if (explicit === 'work' || explicit === 'chat') return explicit
  const tags = Array.isArray(opts.tags) ? opts.tags.map((x) => String(x).toLowerCase()) : []
  if (tags.some((x) => ['工作', 'work', '工程', '项目', '任务', '技术'].includes(x))) return 'work'
  if (tags.some((x) => ['闲聊', 'chat', '日常', '生活', '闲聊话题'].includes(x))) return 'chat'
  const s = String(text || '').toLowerCase()
  if (!s) return 'chat'
  let work = 0
  let chat = 0
  for (const w of WORK_HINTS) if (s.includes(w)) work++
  for (const w of CHAT_HINTS) if (s.includes(w)) chat++
  if (/```|\bcd\s|[a-z]:\\|localhost|https?:\/\//.test(s)) work += 2
  if (work >= 2 && work > chat) return 'work'
  if (work > chat && opts.kind === 'fact') return 'work'
  return 'chat'
}

/** 去掉动作括注、表情、句尾语气词——工作记忆的口径。 */
function stripFiller(text) {
  const clean = String(text || '')
    .replace(ACTION_NOTE, ' ')
    .replace(EMOJI_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = clean.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean)
  const out = sentences
    .map((s) =>
      s
        .replace(/(^|[，,。！？!?；;\s])(唔|嗯|哦|噢|诶|欸|那个)+[，,。…\s]*/g, '$1')
        .replace(/(啊|呀|啦|吧|呢|嘛|哦|咯|嘞|呐)(?=[，,。！？!?；;\s]|$)/g, '')
        .replace(FILLER_TAIL, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('')
  return (out || clean).replace(/[!！]{2,}/g, '！').replace(/[。；]{2,}/g, '。').trim()
}

/** 工作记忆：只留正经结论和步骤，200 字封顶。 */
function condenseWork(text) {
  const clean = stripFiller(text)
  const parts = clean.split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean)
  const keep = parts.filter((s) =>
    /结论|结果|原因|步骤|做法|修复|改成|安装|配置|版本|路径|命令|先|然后|再|最后|注意|问题|解决|失败|成功|\d/.test(s),
  )
  const out = (keep.length ? keep : parts).join('')
  return (out || clean).slice(0, 200)
}

/** 闲聊记忆：留个大概，120 字封顶。 */
function condenseChat(text) {
  return stripFiller(text).slice(0, 120)
}

function condenseForLane(lane, text) {
  return lane === 'work' ? condenseWork(text) : condenseChat(text)
}

/* ── 档位：一档底线、二档常用、三档杂记 ────────────────────────────────── */

function memLastTouch(mem) {
  return Number((mem && (mem.lastHit || mem.t)) || 0) || 0
}

function memAgeDays(mem, now) {
  const at = memLastTouch(mem)
  if (!at) return 9999
  return Math.max(0, (now - at) / 86400000)
}

// 稳固度 S：重要的事忘得慢（30 天为底，按重要度上下浮动）
function stabilityInit(mem) {
  const w = clamp01(mem && mem.weight, 0.5)
  const s0 = 30 * (0.4 + 1.2 * w)
  return Math.min(400, Math.max(5, Number(s0.toFixed(1))))
}

// 留存率 R = e^(-t/S)：t 是距上次用到过了多少天
function retentionOf(mem, now) {
  const t = now || Date.now()
  const days = memAgeDays(mem, t)
  const s = Number(mem && mem.s) > 0 ? Number(mem.s) : stabilityInit(mem)
  if (days >= 9999) return 0
  return Math.min(1, Math.exp(-days / Math.max(1, s)))
}

// 复习一次：S 变结实。R 还高的时候几乎不涨，快忘光时涨得最多
function reviewStability(mem, now) {
  const r = retentionOf(mem, now)
  const s = Number(mem && mem.s) > 0 ? Number(mem.s) : stabilityInit(mem)
  const next = s * (1 + REVIEW_GAIN * (1 - r))
  return Math.min(900, Math.max(2, Number(next.toFixed(1))))
}

// 边线：快忘了但还没忘，适合拿出来当话题重新聊一次
function isEdgeMemory(mem, now) {
  const r = retentionOf(mem, now)
  return r >= EDGE_R_MIN && r <= EDGE_R_MAX
}

// 档位由「权重 + 被想起过几次 + 留存率」一起算，不单独存数字
function tierOf(mem, now, cfg) {
  const t = now || Date.now()
  const hits = Number(mem && mem.hits) || 0
  const w = Number(mem && mem.weight) || 0
  const ageDays = memAgeDays(mem, t)
  const staleDays = Math.max(7, Number((cfg && cfg.memory && cfg.memory.tiers && cfg.memory.tiers.staleDays) || 60))
  const r = retentionOf(mem, t)
  // 权重说它「该有多重要」
  let byWeight = 2
  if (w >= TIER_ONE_WEIGHT) byWeight = 1
  else if (w >= 0.65 && hits >= 3) byWeight = 1
  else if (w < 0.3) byWeight = 3
  else if (w >= TIER_TWO_WEIGHT) byWeight = 2
  else if (hits >= 1 && ageDays <= TIER_FRESH_DAYS) byWeight = 2
  if (mem && mem.kind === 'fact' && hits >= 5 && ageDays <= staleDays) byWeight = 1
  // 留存率说它「还记不记得」：两条一起看，取更差的那个
  let byR = 3
  if (r >= 0.5) byR = 1
  else if (r >= 0.2) byR = 2
  let tier = Math.max(byWeight, byR)
  if (ageDays > staleDays * 2) tier = 3
  else if (ageDays > staleDays && tier < 3) tier = 3
  return tier
}

function tierCounts(mems, cfg, now) {
  const out = { one: 0, two: 0, three: 0 }
  const keys = { 1: 'one', 2: 'two', 3: 'three' }
  for (const m of mems) out[keys[tierOf(m, now, cfg)]] += 1
  return out
}

// 想起来一次：算它被想起，往上抬一点点 —— 「反之升档」就靠这里
// 顺带做复习：S 变结实，所以同样的间隔下它下次忘得更慢
function markRecalled(ids) {
  const set = new Set((ids || []).filter(Boolean))
  if (!set.size) return
  const now = Date.now()
  const rows = readMemories()
  const hitIds = new Set()
  for (const m of rows) {
    if (!set.has(m.id)) continue
    const last = Number(m.lastHit) || 0
    // 冷却：六小时内反复想起不重复抬权重，否则一条会霸占全部名额
    const cooled = !last || now - last >= RECALL_BUMP_COOLDOWN_MS
    m.s = reviewStability(m, now)
    m.hits = (Number(m.hits) || 0) + 1
    m.lastHit = now
    const w = Number(m.weight) || 0
    if (cooled && w < RECALL_BUMP_CEIL) {
      m.weight = clamp01(Math.min(RECALL_BUMP_CEIL, w + RECALL_BUMP), 0.4)
    }
    hitIds.add(m.id)
  }
  // 只有命中那几条所在的月份需要重写：原来每命中一次就把全部月份重写一遍
  if (hitIds.size) saveMemoriesIn(rows, hitIds)
}

// 归档：久没被提起的就往下掉一截；掉到 0.05 就停在那儿，不删
function decayMemories(cfg) {
  const now = Date.now()
  const c = cfg || readCfg()
  const staleDays = Math.max(7, Number(c.memory.tiers.staleDays) || 60)
  const step = Math.max(0.01, Math.min(0.2, Number(c.memory.tiers.drop) || 0.04))
  const rows = readMemories()
  let dropped = 0
  let toThree = 0
  let archived = 0
  for (const m of rows) {
    const before = tierOf(m, now, c)
    const ageDays = memAgeDays(m, now)
    if (ageDays > staleDays) {
      const steps = Math.min(4, Math.floor(ageDays / staleDays))
      const next = Math.max(0.05, (Number(m.weight) || 0.3) - step * steps)
      if (next < (Number(m.weight) || 0)) {
        m.weight = Number(next.toFixed(3))
        dropped += 1
      }
    }
    if (before < 3 && tierOf(m, now, c) === 3) toThree += 1
    // 老到「快忘了」且已经压到底：收进归档，不再注入，但没删
    const w = Number(m.weight) || 0
    if (!m.archivedAt && w <= ARCHIVE_WEIGHT && memAgeDays(m, now) > staleDays * 2) {
      m.archivedAt = now
      archived += 1
    }
  }
  if (dropped || archived) saveMemories(rows)
  return { ok: true, checked: rows.length, dropped, toThree, archived, at: now }
}

// 记忆体检：重复的、从没被想起的，列出来给面板看（不自动删）
function memoryHealth(cfg) {
  const now = Date.now()
  const c = cfg || readCfg()
  const rows = readMemories()
  const seen = new Map()
  const duplicates = []
  for (const m of rows) {
    const key = normalizeMemText(m.text).replace(/[的了是把就都很也还]/g, '')
    if (seen.has(key)) duplicates.push({ keep: seen.get(key), dup: m.id, text: short(m.text, 40) })
    else seen.set(key, m.id)
  }
  const neverRecalled = rows.filter((m) => !m.hits && now - (Number(m.t) || 0) > 7 * 86400000)
  return {
    ok: true,
    total: rows.length,
    tiers: tierCounts(rows, c, now),
    duplicates: duplicates.slice(0, 20),
    neverRecalled: neverRecalled.length,
    stale: rows.filter((m) => memAgeDays(m, now) > (Number(c.memory.tiers.staleDays) || 60)).length,
  }
}

/* ── 写入时合并：2-gram 相似度 + 模型决策 ───────────────────────────────── */

// 2-gram 集合：中文二字滑窗 + 英文词，拿 Dice 系数当相似度
function gramsOf(text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w)
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run)
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

function similarityOf(a, b) {
  const A = a instanceof Set ? a : gramsOf(a)
  const B = b instanceof Set ? b : gramsOf(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const x of A) if (B.has(x)) hit++
  return (2 * hit) / (A.size + B.size)
}

function similarMemories(text, rows, limit, threshold) {
  const gram = gramsOf(text)
  const floor = threshold != null ? threshold : MERGE_SOFT_SIM
  const out = []
  for (const m of rows) {
    const sim = similarityOf(gram, m.text)
    if (sim < floor) continue
    out.push({ id: m.id, text: m.text, sim, t: m.t, weight: m.weight })
  }
  out.sort((a, b) => b.sim - a.sim)
  return out.slice(0, limit || MERGE_CANDIDATE_MAX)
}

const MERGE_SYSTEM = [
  '你在维护一份长期记忆库。现在有一条新记忆要存，先判断它跟已有记忆是不是讲同一件事。',
  '可选动作：',
  'merge = 同一件事，把新的细节并进去，给 mergedText（合并后完整的一句）',
  'replace = 同一件事但新说法更准或更新，直接换掉旧的',
  'add = 跟已有记忆都不冲突，另存一条',
  'noop = 新的这条没信息量，不必存',
  '只输出一行 JSON，不要解释、不要代码块：',
  '{"action":"merge|replace|add|noop","targetId":"候选 id 或空","mergedText":"action 是 merge 时给合并后的句子，否则留空"}',
].join('\n')

async function decideMerge(ctxArg, cfg, text, candidates) {
  if (!candidates.length) return { action: 'add' }
  if (!cfg.memory.merge.askModel) return { action: 'merge', targetId: candidates[0].id }
  const model = resolveModel(ctxArg, safeAgents()[0])
  const lines = candidates.map(
    (c) => '[' + c.id + '] ' + short(c.text, 160) + '（相似度 ' + c.sim.toFixed(2) + '）',
  )
  const prompt = '新记忆：' + short(text, 200) + '\n\n已有候选：\n' + lines.join('\n') + '\n\n给判断。'
  const r = await askModel(ctxArg && ctxArg.llm, model, MERGE_SYSTEM, prompt, 160)
  if (!r.ok) return { action: 'add', error: r.error }
  const m = String(r.text || '').match(/\{[\s\S]*\}/)
  if (!m) return { action: 'add' }
  let j = null
  try {
    j = JSON.parse(m[0])
  } catch {
    return { action: 'add' }
  }
  const ids = new Set(candidates.map((c) => c.id))
  const action = ['merge', 'replace', 'add', 'noop'].includes(j.action) ? j.action : 'add'
  const wanted = String(j.targetId || '')
  const targetId = ids.has(wanted) ? wanted : action === 'add' || action === 'noop' ? '' : candidates[0].id
  const mergedText = typeof j.mergedText === 'string' ? j.mergedText.trim().slice(0, 500) : ''
  return { action, targetId, text: mergedText }
}

// 存之前先想一下放哪儿：够像的不问模型直接并，含糊的交模型挑
async function rememberWithMerge(input, src, ctxArg) {
  const cfg = readCfg()
  const probe = normalizeMemText(input && input.text)
  if (!probe) return { ok: false, error: 'text 不能为空' }
  let plan = null
  if (cfg.memory.merge.enabled) {
    const rows = readMemories()
    const cands = similarMemories(probe, rows, MERGE_CANDIDATE_MAX, cfg.memory.merge.threshold)
    if (cands.length) {
      plan =
        cands[0].sim >= MERGE_SURE_SIM
          ? { action: 'merge', targetId: cands[0].id }
          : await decideMerge(ctxArg, cfg, probe, cands)
    }
  }
  return addMemory(input, src, plan)
}

function addMemory(input, src, plan) {
  const raw = normalizeMemText(input && input.text)
  if (!raw) return { ok: false, error: 'text 不能为空' }
  if (raw.length > 500) return { ok: false, error: '一条记忆最多 500 字' }
  const kind = input && input.kind === 'event' ? 'event' : 'fact'
  const tags = Array.isArray(input && input.tags) ? input.tags.filter((x) => typeof x === 'string').slice(0, 6) : []
  const lane = laneOf(raw, { lane: input && input.lane, kind, tags })
  // 面板上手写的那条原样存；模型/自动保存的按车道压缩
  const text = input && input.raw ? raw : condenseForLane(lane, raw)
  if (!text) return { ok: false, error: '压缩完什么都不剩了' }
  const weight = clamp01(input && input.weight, kind === 'fact' ? 0.6 : 0.45)
  const rows = readMemories()
  const existing = rows.find((m) => normalizeMemText(m.text) === text)
  if (existing) {
    // 又说了一遍同一件事：不是新记忆，只是更确定了一点
    existing.t = Date.now()
    existing.weight = clamp01(Math.max(existing.weight, weight) + 0.05, existing.weight)
    existing.kind = kind
    existing.lane = lane
    if (tags.length) existing.tags = tags
    existing.hits = (existing.hits || 0) + 1
    // 又提了一次 = 复习一次，它会变得更结实
    existing.s = reviewStability(existing, Date.now())
    saveMemories(rows)
    return { ok: true, item: existing, count: rows.length, updated: true }
  }
  // 合并决策：上层的 rememberWithMerge 会带 plan 进来；面板直连时按相似度兜底
  let action = plan && plan.action
  let targetId = plan && plan.targetId
  const cfg = readCfg()
  if (!action && cfg.memory.merge.enabled) {
    const sure = similarMemories(text, rows, 1, Math.max(cfg.memory.merge.threshold, MERGE_SURE_SIM))
    if (sure.length) {
      action = 'merge'
      targetId = sure[0].id
    }
  }
  const now = Date.now()
  const target = targetId ? rows.find((m) => m.id === targetId) : null
  if (action === 'noop' && target) {
    return { ok: true, item: target, count: rows.length, updated: true, skipped: true, action: 'noop' }
  }
  if (action === 'delete' && target) {
    try {
      appendJsonl(REV_PATH, revisionOf(target, now), REVISION_KEEP)
    } catch {}
    const idx = rows.findIndex((m) => m.id === target.id)
    if (idx >= 0) rows.splice(idx, 1)
    saveMemories(rows)
    return addMemory(input, src, { action: 'add' })
  }
  if ((action === 'merge' || action === 'replace') && target) {
    try {
      appendJsonl(REV_PATH, revisionOf(target, now), REVISION_KEEP)
    } catch {}
    const merged = plan && typeof plan.text === 'string' && plan.text ? normalizeMemText(plan.text) : ''
    target.text = action === 'replace' ? text : merged || target.text
    target.t = now
    target.weight = clamp01(
      Math.max(Number(target.weight) || 0, weight) + (action === 'merge' ? 0.05 : 0),
      target.weight,
    )
    target.kind = kind
    target.lane = lane
    if (tags.length) target.tags = tags
    target.hits = (Number(target.hits) || 0) + 1
    target.s = reviewStability(target, now)
    target.merged = (Number(target.merged) || 0) + 1
    saveMemories(rows)
    return { ok: true, item: target, count: rows.length, updated: true, action }
  }
  const item = { id: newId('m'), t: now, kind, lane, text, weight, tags, src, hits: 0, lastHit: 0 }
  item.s = stabilityInit(item)
  appendMemory(item)
  // 超上限就从最老的开始丢（权重低的自然沉在冷层，这里只做兜底）
  const keep = cfg.memory.keep || MEMORY_KEEP
  if (rows.length + 1 > keep) {
    const all = readMemories()
    if (all.length > keep) saveMemories(all.slice(all.length - keep))
  }
  return {
    ok: true,
    item: { ...item, tier: tierOf(item) },
    count: Math.min(rows.length + 1, keep),
    updated: false,
    action: 'add',
  }
}

function setMemoryWeight(id, weight) {
  const w = clamp01(weight, NaN)
  if (!Number.isFinite(w)) return { ok: false, error: 'weight 要是 0~1 的数' }
  const rows = readMemories()
  const hit = rows.find((m) => m.id === id)
  if (!hit) return { ok: false, error: '没有这条记忆' }
  hit.weight = w
  saveMemories(rows)
  return { ok: true, item: hit }
}

const TRASH_NAME = 'memory-trash.jsonl'
function trashPath() {
  return path.join(STORE, TRASH_NAME)
}

// 删除先进回收站：删错了还能捞回来
function deleteMemory(id) {
  const rows = readMemories()
  const hit = rows.find((m) => m.id === id)
  if (!hit) return { ok: false, error: '没有这条记忆' }
  const next = rows.filter((m) => m.id !== id)
  try {
    fs.mkdirSync(STORE, { recursive: true })
    fs.appendFileSync(trashPath(), JSON.stringify({ ...hit, deletedAt: Date.now() }) + '\n')
  } catch (e) {
    return { ok: false, error: '写回收站失败，没删：' + (e && e.message) }
  }
  saveMemories(next)
  return { ok: true, count: next.length, trashed: true }
}

function readTrash() {
  try {
    return fs
      .readFileSync(trashPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((x) => {
        try {
          return JSON.parse(x)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function restoreMemory(id) {
  const trash = readTrash()
  const hit = trash.find((m) => String(m.id) === String(id))
  if (!hit) return { ok: false, error: '回收站里没有这条' }
  const rows = readMemories()
  if (rows.some((m) => String(m.id) === String(id))) return { ok: false, error: '这条已经回来了' }
  const back = { ...hit }
  delete back.deletedAt
  rows.push(back)
  saveMemories(rows)
  const left = trash.filter((m) => String(m.id) !== String(id))
  try {
    fs.writeFileSync(trashPath(), left.map((m) => JSON.stringify(m)).join('\n') + (left.length ? '\n' : ''))
  } catch {}
  return { ok: true, count: rows.length, restored: back.id }
}

const TRASH_KEEP_DAYS = 30

function writeTrash(left) {
  try {
    fs.writeFileSync(trashPath(), left.map((m) => JSON.stringify(m)).join('\n') + (left.length ? '\n' : ''))
    return null
  } catch (e) {
    return '写回收站失败：' + (e && e.message)
  }
}

// 彻底删：只从回收站里拿掉，记忆正文早就不在列表里了
function purgeMemory(id) {
  const trash = readTrash()
  const left = trash.filter((m) => String(m.id) !== String(id))
  if (left.length === trash.length) return { ok: false, error: '回收站里没有这条' }
  const err = writeTrash(left)
  if (err) return { ok: false, error: err }
  return { ok: true, left: left.length }
}

// 清空回收站：传 ids 就只清这些，不传就全清
function purgeTrash(ids) {
  const trash = readTrash()
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map((x) => String(x))) : null
  const left = want ? trash.filter((m) => !want.has(String(m.id))) : []
  const err = writeTrash(left)
  if (err) return { ok: false, error: err }
  return { ok: true, left: left.length, removed: trash.length - left.length }
}

// 回收站只留 30 天，超期自己清掉
function pruneTrash(days) {
  const keep = (Number(days) > 0 ? Number(days) : TRASH_KEEP_DAYS) * 86400000
  const now = Date.now()
  const trash = readTrash()
  const left = trash.filter((m) => now - (Number(m.deletedAt) || 0) < keep)
  if (left.length === trash.length) return { pruned: 0, left: left.length }
  const err = writeTrash(left)
  return { pruned: err ? 0 : trash.length - left.length, left: left.length }
}

function deleteJournal(id) {
  const rows = readJournal()
  const next = rows.filter((x) => x.id !== id)
  if (next.length === rows.length) return { ok: false, error: '没有这条' }
  writeJsonl(JOUR_PATH, next)
  return { ok: true, count: next.length }
}

/* ── 改错：记忆可以改，改之前把原样留一份 ───────────────────────────────── */

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function readRevisions(revOf) {
  const rows = readJsonl(REV_PATH).map((r) => ({ ...r, t: Number(r.t) || 0 }))
  const hit = revOf ? rows.filter((r) => r.revOf === revOf) : rows
  return hit.sort((a, b) => b.t - a.t)
}

function revisionOf(mem, now) {
  return {
    id: newId('rv'),
    revOf: mem.id,
    t: now,
    kind: mem.kind,
    lane: mem.lane,
    text: mem.text,
    weight: mem.weight,
    tags: mem.tags,
    s: mem.s,
    hits: mem.hits,
    lastHit: mem.lastHit,
    src: mem.src,
  }
}

function editMemory(input) {
  const id = String((input && input.id) || '')
  if (!id) return { ok: false, error: '缺 id' }
  const rows = readMemories()
  const hit = rows.find((m) => m.id === id)
  if (!hit) return { ok: false, error: '没有这条记忆' }
  const text = input.text != null ? normalizeMemText(input.text) : hit.text
  if (!text) return { ok: false, error: '改完不能是空的' }
  if (text.length > 500) return { ok: false, error: '一条记忆最多 500 字' }
  const now = Date.now()
  const rev = revisionOf(hit, now)
  appendJsonl(REV_PATH, rev, REVISION_KEEP)
  hit.text = text
  if (input.kind === 'fact' || input.kind === 'event') hit.kind = input.kind
  if (input.weight != null) hit.weight = clamp01(input.weight, hit.weight)
  if (Array.isArray(input.tags)) hit.tags = input.tags.filter((x) => typeof x === 'string' && x.trim()).slice(0, 6)
  hit.lane = input.lane === 'work' || input.lane === 'chat' ? input.lane : laneOf(text, { kind: hit.kind, tags: hit.tags })
  hit.editedAt = now
  hit.edits = (Number(hit.edits) || 0) + 1
  saveMemories(rows)
  const after = readMemories().find((m) => m.id === id) || hit
  return { ok: true, item: after, revision: rev.id }
}

function restoreRevision(revId) {
  const rows = readJsonl(REV_PATH)
  let rev = rows.find((r) => r.id === revId)
  if (!rev) {
    // 传记忆 id 也行：取它最近一次改动之前的原样
    const mine = rows.filter((r) => r.revOf === revId).sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0))
    rev = mine[0]
  }
  if (!rev) return { ok: false, error: '没有这次改动' }
  return editMemory({
    id: rev.revOf,
    text: rev.text,
    kind: rev.kind,
    lane: rev.lane,
    weight: rev.weight,
    tags: rev.tags,
  })
}

/* ── 快照：整包导出到 backups 目录，写完当场读回来校验，多了就轮转 ─────── */

function ensureBackupDir() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    return true
  } catch {
    return false
  }
}

function backupStamp(at) {
  const d = new Date(at || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function listBackups() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^whale-core-.*\.json$/.test(f))
      .map((f) => {
        let bytes = 0
        try {
          bytes = fs.statSync(path.join(BACKUP_DIR, f)).size
        } catch {}
        return { file: f, bytes, at: atOfName(f) }
      })
      .sort((a, b) => b.at - a.at)
  } catch {
    return []
  }
}

function atOfName(f) {
  const m = /whale-core-(\d{8})-(\d{4})\.json/.exec(f)
  if (!m) return 0
  const y = m[1].slice(0, 4)
  const mo = m[1].slice(4, 6)
  const d = m[1].slice(6, 8)
  return new Date(`${y}-${mo}-${d}T${m[2].slice(0, 2)}:${m[2].slice(2)}:00`).getTime() || 0
}

function snapshotNow(cfgArg) {
  if (!ensureBackupDir()) return { ok: false, error: '备份目录建不出来' }
  const at = Date.now()
  const data = exportBundle(cfgArg || readCfg())
  const file = `whale-core-${backupStamp(at)}.json`
  const full = path.join(BACKUP_DIR, file)
  try {
    fs.writeFileSync(full, JSON.stringify(data), 'utf8')
  } catch (err) {
    return { ok: false, error: `写不进去：${err && err.message ? err.message : err}` }
  }
  // 当场读回来校验：解析得动、条数对得上，才算这次备份是好的
  let verified = false
  try {
    const back = JSON.parse(fs.readFileSync(full, 'utf8'))
    verified =
      back.format === EXPORT_FORMAT &&
      Array.isArray(back.memory) &&
      back.memory.length === data.memory.length &&
      Array.isArray(back.journal)
  } catch {}
  // 轮转：只留最近 keepBackups 份
  const keep = Math.max(1, Number((cfgArg && cfgArg.sync && cfgArg.sync.keepBackups) || BACKUP_KEEP))
  const files = listBackups()
  let pruned = 0
  for (const f of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, f.file))
      pruned += 1
    } catch {}
  }
  return { ok: verified, verified, file, at, memory: data.memory.length, journal: data.journal.length, pruned }
}

/* ── 事件线 / 待蒸馏缓冲：每轮把会话里新说的话收进 events.jsonl ───────────── */

function readEvents(limit) {
  const rows = readJsonl(EVENT_PATH).map((r) => ({ ...r, t: Number(r.t) || 0 }))
  const n = Math.max(1, Number(limit) || 60)
  return rows.slice(-n)
}

function readPending() {
  return readJsonl(PENDING_PATH).map((r) => ({ ...r, t: Number(r.t) || 0 }))
}

function pendingText() {
  // 正文只存一份（events.jsonl），缓冲里留 eid 指向它：
  // 原来同一句话在 events 存 160 字、在 pending 再存 600 字，白写一倍
  const ev = new Map()
  try {
    for (const r of readJsonl(EVENT_PATH)) if (r.id) ev.set(String(r.id), String(r.text || ''))
  } catch {}
  const out = []
  for (const r of readPending()) {
    const text = r.text != null ? String(r.text) : ev.get(String(r.eid || '')) || ''
    if (!text) continue
    out.push(`${r.who === 'user' ? '主人' : '我'}：${text}`)
  }
  return out.join('\n')
}

let pendingTrimAt = 0

function pushPending(row) {
  appendJsonl(PENDING_PATH, row, PENDING_KEEP)
  const now = Date.now()
  // 裁剪本身要读整份文件，别每条消息都做
  if (now - pendingTrimAt < 30 * 1000) return
  pendingTrimAt = now
  try {
    trimPending()
  } catch {}
}

// 缓冲按「时间窗 + 字节数」双上限收口，别长期贴着 400 条的条数上限
function trimPending() {
  const now = Date.now()
  const rows = readPending()
  // 正文存在 events 里，事件被合并/裁掉后这条 eid 就指空了：
  // 这种行提不出一个字，留着只是白白占体积，直接在裁剪时丢掉
  let evIds = null
  try {
    evIds = new Set()
    for (const r of readJsonl(EVENT_PATH)) if (r.id) evIds.add(String(r.id))
  } catch {
    evIds = null
  }
  const alive = rows.filter((r) => {
    if (r.text != null) return true
    if (!evIds) return true
    return evIds.has(String(r.eid || ''))
  })
  const fresh = alive.filter((r) => !r.t || now - r.t <= PENDING_MAX_AGE_MS)
  let bytes = 0
  const kept = []
  for (let i = fresh.length - 1; i >= 0; i--) {
    const len = JSON.stringify(fresh[i]).length + 1
    if (bytes + len > PENDING_MAX_BYTES) break
    bytes += len
    kept.push(fresh[i])
  }
  kept.reverse()
  if (kept.length !== rows.length) writeJsonl(PENDING_PATH, kept)
}

function drainPending() {
  writeJsonl(PENDING_PATH, [])
}

function sessionIdOf(agent) {
  try {
    const s = agent && agent.session
    return String((s && s.id) || (agent && agent.id) || 'adhoc')
  } catch {
    return 'adhoc'
  }
}

function agentListOf(ctxArg) {
  try {
    const list = ctxArg && ctxArg.agents && ctxArg.agents.list
    const arr = typeof list === 'function' ? list.call(ctxArg.agents) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

// 每个会话记一个事件游标：只把「上次之后新出现的」消息收进去，不重复收
const ingestCursor = new Map()

function ingestAgents(ctxArg, force) {
  // 压缩只发生在对话进行中：安静超过 5 分钟就别每分钟复制一遍事件数组了
  if (!force && Date.now() - lastTalkAt > 5 * 60000) return { added: 0, compacted: 0, idle: true }
  let added = 0
  let compacted = 0
  for (const agent of agentListOf(ctxArg)) {
    const ev = eventsOf(agent)
    if (!ev.length) continue
    const sid = sessionIdOf(agent)
    // 重启后游标是空的：这时别把整段历史再灌一遍（几百条 × 整份重写会卡几十秒，还会写重）
    const known = ingestCursor.has(sid)
    const prev = known ? ingestCursor.get(sid) : ev.length
    let from = prev
    // 会话被压缩/重建过：事件数组变短了，从头再看一遍（已经写过的文本在 addMemory 层去重）
    if (known && ev.length < prev) from = 0
    for (let i = from; i < ev.length; i++) {
      const e = ev[i] || {}
      const type = String(e.type || e.kind || '')
      const payload = e.payload !== undefined ? e.payload : e.data
      if (/compact|compress/i.test(type)) {
        appendJsonl(EVENT_PATH, { t: Date.now(), sid, who: 'sys', text: '上下文被压缩了一次' }, EVENT_KEEP)
        compacted += 1
        continue
      }
      if (type !== 'user/message' && type !== 'assistant/message') continue
      const text = textOfMessage(payload)
      if (!text || text.trim().length < 2) continue
      const who = type === 'user/message' ? 'user' : 'me'
      const t = Number(e.t || e.timestamp || e.at || 0) || Date.now()
      const eid = newId('e')
      appendJsonl(EVENT_PATH, { id: eid, t, sid, who, text: clip(text, who === 'user' ? 600 : EVENT_ME_CHARS) }, EVENT_KEEP)
      pushPending({ t, sid, who, eid })
      added += 1
    }
    ingestCursor.set(sid, ev.length)
  }
  return { added, compacted }
}

/* ── 边线搭话：隔几天从「快忘了」那层挑一条，聊一次就结实一点 ───────────── */

// 只算「这次该问哪条」，写盘交给调用方（save 是 apply 里的闭包）
function pickEdge(cfgArg) {
  const cfg = cfgArg || readCfg()
  if (!cfg.memory.edge.enabled) return { ok: false, error: '边线搭话关着' }
  const now = Date.now()
  const mood = effectiveMood(cfg.mood)
  // 心情门：难过/生气/害怕且很浓时，不主动翻旧账
  const heavy = ['难过', '生气', '害怕'].includes(mood.emotion) && mood.intensity >= 0.6
  let pool = readMemories().filter((m) => isEdgeMemory(m, now))
  if (heavy) pool = pool.filter((m) => m.kind === 'fact' && Number(m.weight) >= 0.6)
  if (!pool.length) return { ok: false, error: heavy ? '心情不好，今天不翻旧账' : '这会儿没有快忘的记忆' }
  pool.sort((a, b) => retentionOf(a, now) - retentionOf(b, now))
  const item = pool[0]
  const text = clip(item.text, 120)
  return { ok: true, item, text, retention: Number(retentionOf(item, now).toFixed(3)), heavy, at: now }
}

/* ── 画像层：从记忆里长出一份「我记得的你」，注入时只占几行 ───────────────── */

// 画像每一轮都要读一次，加个 mtime 缓存：文件没动就不重复读盘
let profileCache = { mtime: -1, data: null }

function readProfile() {
  let mtime = -1
  try {
    mtime = fs.statSync(PROFILE_PATH).mtimeMs
  } catch {}
  if (profileCache.data && profileCache.mtime === mtime && mtime >= 0) return profileCache.data
  const raw = readJson(PROFILE_PATH, null)
  const data = isPlainObject(raw) ? raw : { updatedAt: 0, facts: [], topics: [], likes: [], dislikes: [] }
  profileCache = { mtime, data }
  return data
}

function buildProfile(cfgArg) {
  const cfg = cfgArg || readCfg()
  const mems = readMemories()
  const facts = mems
    .filter((m) => m.kind === 'fact' && Number(m.weight) >= 0.5)
    .sort((a, b) => Number(b.weight) - Number(a.weight))
    .slice(0, 6)
    .map((m) => clip(m.text, 56))
  const topics = [...new Set([...(cfg.affinity.topics || []), ...String(cfg.affinity.topicNote || '').split(/[、,，\s]+/)])]
    .map((x) => String(x).trim())
    .filter(Boolean)
    .slice(0, 6)
  const likes = mems
    .filter((m) => /喜欢|爱吃|爱看|偏好/.test(m.text))
    .slice(-3)
    .map((m) => clip(m.text, 40))
  const dislikes = mems
    .filter((m) => /讨厌|不喜欢|受不了|别踩|雷区/.test(m.text))
    .slice(-3)
    .map((m) => clip(m.text, 40))
  return { updatedAt: Date.now(), facts, topics, likes, dislikes }
}

function refreshProfile(cfgArg) {
  const profile = buildProfile(cfgArg)
  try {
    writeJson(PROFILE_PATH, profile)
  } catch {}
  return profile
}

/* ── 心情 ───────────────────────────────────────────────────────────────── */

/* ── 心情 · 好感度 ─────────────────────────────────────────────────────── */

function normalizeEmotion(input) {
  const raw = String(input || '').trim()
  if (!raw) return '平静'
  if (EMO_LIST.includes(raw)) return raw
  if (EMO_ALIAS[raw]) return EMO_ALIAS[raw]
  for (const key of Object.keys(EMO_ALIAS)) {
    if (raw.includes(key)) return EMO_ALIAS[key]
  }
  for (const key of EMO_LIST) {
    if (raw.includes(key)) return key
  }
  return '平静'
}

function emotionBand(intensity) {
  if (intensity >= 0.67) return '很浓'
  if (intensity >= 0.34) return '有感觉'
  return '淡淡的'
}

// 心情会往 0.4 的基线回淡，半衰期 6 小时：刚被打动时浓，过半天就平了
function effectiveMood(mood) {
  const emotion = normalizeEmotion(mood && mood.emotion)
  const base = clamp01(mood && mood.intensity, 0.5)
  const at = Number((mood && mood.updatedAt) || 0)
  const hours = at > 0 ? Math.max(0, (Date.now() - at) / 3600000) : 0
  const k = Math.pow(0.5, hours / MOOD_HALF_LIFE_HOURS)
  const intensity = 0.4 + (base - 0.4) * k
  // 强度淡回基线以后，情绪名也要回平静：别让「难过」以 4/10 的样子常驻
  const faded = base > 0.45 && intensity <= 0.45
  return {
    emotion: faded ? '平静' : emotion,
    rawEmotion: emotion,
    faded,
    intensity: Number(intensity.toFixed(3)),
    base,
    updatedAt: at,
    hours: Number(hours.toFixed(2)),
    band: emotionBand(intensity),
    level: Math.round(intensity * 10),
  }
}

function affinityStage(value) {
  const v = Math.min(100, Math.max(0, Math.round(Number(value) || 0)))
  for (let i = AFF_STAGES.length - 1; i >= 0; i--) {
    if (v > AFF_STAGES[i].max || (v >= AFF_STAGES[i].min && v <= AFF_STAGES[i].max)) return AFF_STAGES[i].key
  }
  return '平常'
}

function effectiveAffinity(aff) {
  const value = Math.min(100, Math.max(0, Math.round(Number(aff && aff.value) || 0)))
  return { value, stage: affinityStage(value) }
}

function moodStyle(cfg, emotion) {
  const styles = (cfg.mood && cfg.mood.styles) || {}
  return styles[emotion] || EMO_STYLES[emotion] || EMO_STYLES['平静']
}

function moodLine(cfg) {
  const e = effectiveMood(cfg.mood)
  const style = moodStyle(cfg, e.emotion)
  return `【此刻心情】${e.emotion} · ${e.band}（${e.level}/10）——${style}`
}

function interestLevel(value) {
  const v = Math.min(100, Math.max(0, Math.round(Number(value) || 0)))
  if (v >= 75) return '来劲了'
  if (v >= 55) return '有点兴趣'
  if (v >= 35) return '应付一下'
  return '有点走神'
}

function affinityLine(cfg) {
  const a = effectiveAffinity(cfg.affinity)
  const style = (cfg.affinity && cfg.affinity.styles && cfg.affinity.styles[a.stage]) || ''
  const interest = Math.min(100, Math.max(0, Math.round(Number(cfg.affinity.interest) || 0)))
  const note = String(cfg.affinity.topicNote || '').trim()
  const tail = note ? `，最近在聊：${note}` : ''
  return `【好感度】${a.stage}（${a.value}/100）· 兴趣 ${interest}/100（${interestLevel(interest)}${tail}）——${style}`
}

function moodAffinityBrief(cfg) {
  const e = effectiveMood(cfg.mood)
  const a = effectiveAffinity(cfg.affinity)
  return `${e.emotion}·${e.band} / 好感${a.stage} / 兴趣${cfg.affinity.interest}`
}

// 现在该发哪一类图：跟着心情走，没装 dsh-meme 时这行白写
function memeTagOf(cfg) {
  const e = effectiveMood(cfg.mood)
  return MEME_TAG[e.emotion] || 'daily'
}

function memeLine(cfg) {
  if (!cfg.meme || cfg.meme.enabled === false) return ''
  const e = effectiveMood(cfg.mood)
  const tag = memeTagOf(cfg)
  const tone =
    e.emotion === '厌恶' || e.emotion === '生气'
      ? '这会儿别发卖萌的图，要发就发扎一点的；也可以干脆不发。'
      : '气氛合适就顺手发一张，别等主人开口；主人办正事时克制。'
  return `【表情】现在偏${e.emotion}（${e.band}），想发图就走 ${tag} 这一类（happy 开心 / shy 害羞 / sad 难过 / angry 生气 / confused 惊讶 / daily 日常）。${tone}`
}

/* ── 兴趣：对主人话题的感兴趣程度（自己会升降） ────────────────────────── */

/** 这条消息有多值得聊：长短、问句、是否命中她在意的话题。 */
function interestTargetOf(cfg, text) {
  const s = String(text || '')
  const topics = (cfg.affinity && cfg.affinity.topics) || INTEREST_TOPICS_DEFAULT
  let target = 28
  target += Math.min(24, Math.floor(s.length / 8))
  if (/[?？]/.test(s)) target += 10
  if (/(帮我|做个|写个|修|看看|怎么|为什么|能不能)/.test(s)) target += 8
  const hits = topics.filter((k) => k && s.includes(k))
  target += hits.length * 9
  return { target: Math.min(100, Math.max(0, Math.round(target))), hits }
}

/** 一次只挪一小步：兴趣是慢慢变的，不是被一句话砸出来的。 */
function stepInterest(cfg, text) {
  const { target, hits } = interestTargetOf(cfg, text)
  const cur = Math.min(100, Math.max(0, Math.round(Number(cfg.affinity.interest) || 0)))
  const move = Math.max(-6, Math.min(6, target - cur))
  return {
    interest: Math.min(100, Math.max(0, cur + move)),
    interestTarget: target,
    topicNote: hits.length ? hits.slice(0, 2).join('、') : String(cfg.affinity.topicNote || ''),
  }
}

/* ── 骰子：按好感度/兴趣算比率，掷出什么心情就来什么心情 ────────────────── */

function diceWeights(cfg) {
  const value = effectiveAffinity(cfg.affinity).value
  const interest = Math.min(100, Math.max(0, Math.round(Number(cfg.affinity.interest) || 0)))
  const hi = 0.7 + interest / 100 // 越感兴趣，越容易往高兴/喜欢上落
  const low = (100 - value) / 100
  const weights = {
    高兴: (0.5 + value / 25) * hi,
    喜欢: (0.3 + value / 40) * hi,
    平静: 2.2,
    难过: 0.4 + low * 1.6,
    生气: 0.2 + low * 2.0,
    害怕: 0.15 + low * 1.2,
    寂寞: 0.3 + Math.max(0, (60 - value) / 40) + (interest < 40 ? 0.6 : 0),
    厌恶: value < 25 ? (25 - value) / 6 : 0.05,
  }
  let total = 0
  for (const k of EMO_LIST) {
    weights[k] = Math.max(0, weights[k] || 0)
    total += weights[k]
  }
  const pct = {}
  for (const k of EMO_LIST) pct[k] = Math.round((weights[k] / total) * 1000) / 10
  return { weights, total, pct }
}

function rollDice(cfg) {
  const { weights, total, pct } = diceWeights(cfg)
  const sides = clampInt(cfg.dice.sides, 2, 100, 6)
  const roll = 1 + Math.floor(Math.random() * sides)
  let r = Math.random() * (total || 1)
  let emotion = '平静'
  for (const k of EMO_LIST) {
    r -= weights[k] || 0
    if (r <= 0) {
      emotion = k
      break
    }
  }
  const intensity = Number((0.35 + Math.random() * 0.55).toFixed(2))
  return { roll, sides, emotion, intensity, pct, at: Date.now() }
}

// 会被聊天时间戳更新的「最后一次说话」，给骰子的自我裁量用
let lastTalkAt = 0

// 自我裁量：现在想不想投这一轮。不想投就跳过，等下一个间隔再说
function diceAppetite(cfg, now) {
  const at = now || Date.now()
  if (!cfg.dice.selfPaced) return { want: true, why: '到点就投' }
  const mood = effectiveMood(cfg.mood)
  const good = (mood.emotion === '高兴' || mood.emotion === '喜欢') && mood.intensity >= 0.55
  const settled = mood.emotion === '平静' && mood.intensity >= 0.62
  if (good || settled) return { want: false, why: '心情正好，先不投' }
  if ((mood.emotion === '难过' || mood.emotion === '生气' || mood.emotion === '害怕') && mood.intensity >= 0.7) {
    return { want: false, why: '正难受着，不想投' }
  }
  if (lastTalkAt && at - lastTalkAt < 6 * 60000) return { want: false, why: '正在跟主人说话' }
  const interest = Math.round(Number(cfg.affinity.interest) || 0)
  if (interest < 25) return { want: false, why: '提不起劲' }
  return { want: true, why: '有点想知道会落到哪儿' }
}

// 被夸/被凶：不用等整点，当下就摇一次，只在高兴/喜欢或难过/生气/害怕里挑
function reactDice(cfg, text) {
  const s = String(text || '')
  let praise = 0
  let harsh = 0
  for (const w of PRAISE_WORDS) if (s.includes(w)) praise += 1
  for (const w of HARSH_WORDS) if (s.includes(w)) harsh += 1
  const isQuestion = /[?？]/.test(s)
  // 疑问句、以及自主裁量开着时，情绪词不触发骰子
  if (!isQuestion && !cfg.dice.selfPaced) {
    for (const w of MOOD_WORDS) if (s.includes(w)) harsh += 1
  }
  if (!praise && !harsh) return null
  const pool = harsh > praise ? ['难过', '生气', '害怕'] : ['高兴', '喜欢']
  const weights = diceWeights(cfg).weights
  const total = pool.reduce((n, k) => n + (weights[k] || 0), 0) || 1
  let r = Math.random() * total
  let emotion = pool[0]
  for (const k of pool) {
    r -= weights[k] || 0
    if (r <= 0) {
      emotion = k
      break
    }
  }
  const intensity = Number(Math.min(1, 0.55 + Math.random() * 0.35).toFixed(2))
  return { emotion, intensity, praise, harsh, at: Date.now(), affinityDelta: harsh > praise ? -2 : 1 }
}

/* ── 召回：分词 / 打分 / 挑选 ──────────────────────────────────────────── */

function recallTokens(text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w)
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) out.add(run)
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return [...out].slice(0, 80)
}

// 否定词：「不喜欢被说胖」里的「胖」不该把讲「胖」的记忆顶上来
function negatedTokens(text) {
  const out = new Set()
  for (const run of String(text || '').match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const tk = run.slice(i, i + 2)
      if (/^[不没别未]/.test(tk) && tk.length > 1) out.add(tk.slice(1))
    }
  }
  return out
}

// 词频表：越少见越值钱，「主人」「今天」这类到处都是的 bigram 自动降权
function idfTable(rows) {
  const df = new Map()
  const docs = rows.map((m) => gramsOf(m.text + ' ' + (m.tags || []).join(' ')))
  for (const d of docs) for (const tk of d) df.set(tk, (df.get(tk) || 0) + 1)
  const n = docs.length || 1
  const idf = new Map()
  for (const [tk, c] of df) {
    idf.set(tk, Math.log((n + 1) / (c + 0.5)) / Math.log(n + 2) + RECALL_IDF_FLOOR)
  }
  return idf
}

function scoreMemory(mem, tokens, cfg, now, lane, opts) {
  const o = opts || {}
  const idf = o.idf || null
  const neg = o.neg || null
  const hay = (mem.text + ' ' + mem.tags.join(' ')).toLowerCase()
  let matchedIdf = 0
  let totalIdf = 0
  for (const tk of tokens) {
    const w = idf ? idf.get(tk) || RECALL_IDF_FLOOR : 1
    totalIdf += w
    if (hay.includes(tk)) matchedIdf += w
  }
  const coverage = totalIdf > 0 ? matchedIdf / totalIdf : 0
  // 只命中到处都是的词不算真相关：按命中 IDF 总量再打一次折
  const specificity = Math.min(1, matchedIdf / RECALL_SPECIFICITY_PIVOT)
  let relevance = coverage * (0.2 + 0.8 * specificity)
  if (neg && neg.size) {
    let pen = 0
    for (const tk of neg) if (hay.includes(tk)) pen += 0.12
    relevance = Math.max(0, relevance - pen)
  }
  relevance = Math.min(1, relevance)
  let tagHit = 0
  for (const tag of mem.tags) if (tokens.includes(tag.toLowerCase())) tagHit += 0.5
  const importance = mem.weight
  const ageHours = Math.max(0, (now - (mem.t || now)) / 3600000)
  const recency = Math.pow(0.5, ageHours / (cfg.memory.freshHalfLifeDays * 24))
  const w = cfg.memory.weights
  // 同车道的记忆更容易被想起（问技术时别拿闲聊顶，闲聊时也别端工作结论）
  const laneHit = lane && mem.lane === lane ? 0.06 : 0
  // 档位高的更靠前：一档是底线，三档只是杂记
  const tier = mem.tier || 2
  const tierBonus = tier === 1 ? 0.05 : tier === 3 ? -0.05 : 0
  const score =
    Math.min(1, relevance + Math.min(0.5, tagHit)) * w.relevance +
    importance * w.importance +
    recency * w.recency +
    laneHit +
    tierBonus
  return {
    score,
    relevance: Number(relevance.toFixed(3)),
    importance,
    recency: Number(recency.toFixed(3)),
    tier,
  }
}

// 热层：高权重且近期被想起（或本来就是一档）→ 进注入；其余进冷层，只配搜索
function isHotMemory(mem, cfg, now) {
  const hot = cfg.memory.hot || {}
  const minW = Number(hot.minWeight != null ? hot.minWeight : HOT_MIN_WEIGHT)
  const freshMs = Math.max(1, Number(hot.freshDays != null ? hot.freshDays : HOT_FRESH_DAYS)) * 86400000
  if (mem.tier === 1) return true
  if (mem.weight < minW) return false
  if ((mem.hits || 0) > 0 && now - (Number(mem.lastHit) || 0) <= freshMs) return true
  return now - (Number(mem.t) || 0) <= freshMs
}

function recall(cfg, query, opts) {
  const now = Date.now()
  const tokens = recallTokens(query)
  const lane = laneOf(query, {})
  const exclude = opts && opts.exclude instanceof Set ? opts.exclude : null
  const mems = readMemories()
  // 日记不再混进候选池：它走 recallDiary 的独立通道
  const idf = idfTable(mems)
  const scoring = { idf, neg: negatedTokens(query) }
  // 归档的记忆不再进注入，但没删，还能搜到、还能恢复
  const candidates = mems.filter((m) => !m.archivedAt).map((m) => ({ ...m, from: 'memory' }))

  const rows = candidates
    .map((c) => {
      const s = scoreMemory(c, tokens, cfg, now, lane, scoring)
      const always =
        c.from === 'memory' && c.kind === 'fact' && c.weight >= FACT_ALWAYS_MIN_WEIGHT ? 1 : 0
      // 这段这次会话里已经给过一次了：不再占注入名额（但轨迹里留着，方便看）
      const dup = !!(exclude && exclude.has(c.id))
      const hot = isHotMemory(c, cfg, now)
      return { item: c, ...s, always, dup, hot }
    })
    .sort((a, b) => (b.always ? 1 : 0) - (a.always ? 1 : 0) || b.score - a.score)

  const picked = []
  const charsOf = () => picked.reduce((n, x) => n + x.item.text.length + 12, 0)
  for (const row of rows) {
    if (picked.length >= cfg.memory.injectMax) break
    if (row.dup) continue
    // 三档是杂记：只在这条确实对得上话时才翻出来，别拿它占位置
    if (row.tier === 3 && row.relevance < TIER_THREE_RELEVANCE) continue
    // 冷层只配被搜索，不进注入；除非这条真的对得上话
    if (!row.hot && row.relevance < COLD_RELEVANCE) continue
    const chosen = row.always > 0 || (row.score >= RECALL_SCORE_GATE && row.relevance > 0)
    if (!chosen) continue
    if (picked.length >= FACT_ALWAYS_MAX && row.always > 0) continue
    if (charsOf() + row.item.text.length > cfg.memory.maxChars) continue
    picked.push(row)
  }

  // 被想起来的记一笔：次数 +1、权重抬一点，档位自然跟着升
  if (picked.length) {
    try {
      markRecalled(picked.filter((x) => x.item.from === 'memory').map((x) => x.item.id))
    } catch {}
  }

  return {
    items: picked.map((x) => x.item),
    trace: {
      at: now,
      query: short(query || '', 160),
      tokens: tokens.length,
      rows: rows.slice(0, 24).map((x) => ({
        id: x.item.id,
        text: short(x.item.text, 60),
        from: x.item.from,
        lane: x.item.lane || 'chat',
        tier: x.tier,
        score: Number(x.score.toFixed(3)),
        relevance: x.relevance,
        importance: Number(x.importance.toFixed(2)),
        recency: x.recency,
        dup: !!x.dup,
        hot: !!x.hot,
        chosen: picked.some((p) => p.item.id === x.item.id),
        why: x.dup
          ? '这轮已经给过'
          : x.always > 0
            ? '长期事实'
            : x.relevance > 0
              ? x.hot
                ? '字面命中'
                : '冷层命中'
              : '只靠权重',
      })),
    },
  }
}

// 日记独立通道：平时不召回，问往事/时间线时才按时间窗取一段，不占记忆的注入名额
function recallDiary(cfg, query, exclude) {
  const ch = cfg.memory.diaryChannel
  if (!ch || ch.enabled === false) return null
  let rows = []
  try {
    rows = readJournal().filter((j) => j.kind === 'diary')
  } catch {
    return null
  }
  if (!rows.length) return null
  const q = String(query || '')
  const askPast = TIME_QUERY_RE.test(q)
  const tokens = recallTokens(q)
  const now = Date.now()
  let best = null
  for (const j of rows) {
    if (exclude && exclude.has(j.id)) continue
    const hay = j.text.toLowerCase()
    let hit = 0
    for (const tk of tokens) if (hay.includes(tk)) hit++
    const ageDays = Math.max(0, (now - j.t) / 86400000)
    const fresh = Math.pow(0.5, ageDays / DIARY_WINDOW_DAYS)
    const score = (askPast ? 0.5 : 0.1) + Math.min(0.5, hit * 0.18) + fresh * 0.35
    if (!best || score > best.score) best = { row: j, score, hit }
  }
  if (!best) return null
  // 平时要真的对上两句才给，别让日记无缘无故插进对话
  if (!askPast && best.hit < 2) return null
  return {
    id: best.row.id,
    t: best.row.t,
    text: short(best.row.text, ch.maxChars || DIARY_INJECT_CHARS),
    askPast,
  }
}

function latestReview() {
  const rows = readJournal().filter((j) => j.kind === 'review')
  const last = rows[rows.length - 1]
  if (!last) return null
  // 复盘进注入的时间窗：原来 7 天，隔两天的复盘对当下已没什么指导意义
  if (Date.now() - last.t > REVIEW_INJECT_WINDOW_MS) return null
  return last
}

// 人设拆成「稳定」和「易变」两段注入：
// 内核（人设卡/说话方式/准则）基本不动，放前面当稳定前缀；
// 心情/好感/兴趣每句话都可能变（兴趣每条消息都会挪一小步），
// 放在前面会把后面整段前缀的 prompt 缓存全打掉 —— 每轮都要重算全部上下文，首字就慢。
function composePersonaStable(cfg, sid) {
  if (!cfg.enabled) return ''
  // 不同会话可以绑不同人设；没绑就用默认那套
  return composeSessionKernelText(cfg, sid) || DEFAULT_KERNEL
}

// 人设卡每轮全量注入，自己看不见 diff：记住上一轮的指纹，变了就在这轮明说
let lastStableFingerprint = null

function fingerprintOf(text) {
  let h = 0
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36).slice(0, 6)
}

function composePersonaVolatile(cfg, stableText) {
  if (!cfg.enabled) return ''
  const lines = []
  const fp = fingerprintOf(stableText)
  if (lastStableFingerprint && lastStableFingerprint !== fp) {
    lines.push(`（人设卡这一轮变了：${lastStableFingerprint} → ${fp}。变化本身是信息，不是问题。）`)
  }
  lastStableFingerprint = fp
  lines.push(moodLine(cfg), affinityLine(cfg))
  const meme = memeLine(cfg)
  if (meme) lines.push(meme)
  lines.push(
    '（回复时先用【此刻心情】定语气和动作，再用【好感度】定距离：好感低就别撒娇、别自来熟，好感高才护短嘴甜；两者冲突时以好感度为准。' +
      '兴趣是你的，不是主人的：兴趣高就顺着这个话题多聊一句、可以追问；兴趣低就简短带过，别硬撑。）',
  )
  return lines.join('\n')
}

function composePersona(cfg, sid) {
  const stable = composePersonaStable(cfg, sid)
  if (!stable) return ''
  return [stable, composePersonaVolatile(cfg, stable)].filter(Boolean).join('\n')
}

let lastRecallTrace = null

// 同一段记忆在同一个会话里只给一次：给过就记下来，后面几轮不再占字数
const sessionInjected = new Map()
const SESSION_DEDUPE_MS = 45 * 60 * 1000

function injectedSetFor(sid) {
  if (!sid) return null
  const now = Date.now()
  let st = sessionInjected.get(sid)
  if (!st || now - st.at > SESSION_DEDUPE_MS) {
    st = { at: now, ids: new Set() }
    sessionInjected.set(sid, st)
    if (sessionInjected.size > 40) {
      const first = sessionInjected.keys().next()
      if (!first.done) sessionInjected.delete(first.value)
    }
  }
  st.at = now
  if (st.ids.size > 80) st.ids.clear()
  return st.ids
}

// ── 注入块缓存 ──
// 工具循环里每一步都会重建一次 system prompt。同一句话 + 同一批已经给过的记忆，
// 应当拿到逐字节相同的字符串，prompt 缓存才吃得满；顺带把 recall 这个重活也省掉。
let memoBlock = { key: '', at: 0, text: '' }
let memoStamp = { at: 0, key: '' }

function storeStamp() {
  const now = Date.now()
  if (now - memoStamp.at < 2000) return memoStamp.key
  const parts = []
  for (const f of [JOUR_PATH, PROFILE_PATH, CFG_PATH]) {
    try {
      parts.push(path.basename(f) + ':' + fs.statSync(f).mtimeMs)
    } catch {
      parts.push(path.basename(f) + ':-')
    }
  }
  for (const f of listShards()) {
    try {
      parts.push(path.basename(f) + ':' + fs.statSync(f).mtimeMs)
    } catch {}
  }
  memoStamp = { at: now, key: parts.join(';') }
  return memoStamp.key
}

function composeMemoryBlock(cfg, query, agent) {
  // 记忆只跟 memory.enabled 走：人设可以继续交给 dsh-identity，两边互不牵连
  // 但总开关关了就该一条都不发（面板上写着「全关：连注释都不发了」）
  if (!cfg.enabled || !cfg.memory.enabled) return ''
  const sid = agent ? sessionIdOf(agent) : ''
  const seen = injectedSetFor(sid)
  const key = [sid, String(query || ''), seen ? seen.size : 0, cfg.memory.injectMax, cfg.memory.maxChars, storeStamp()].join('|')
  const now = Date.now()
  if (memoBlock.key === key && now - memoBlock.at < MEMO_TTL_MS) return memoBlock.text
  const text = buildMemoryBlock(cfg, query, agent, seen)
  memoBlock = { key, at: now, text }
  return text
}

// 画像条目如果已经作为记忆拼进这一块了，就不再重复一次：省字，也少一处 cache 变动
function factCovered(fact, items) {
  const f = String(fact || '').replace(/\s+/g, '')
  if (f.length < 8) return false
  for (const it of items) {
    const t = String(it.text || '').replace(/\s+/g, '')
    if (t.length < 8) continue
    if (t.includes(f.slice(0, 12)) || f.includes(t.slice(0, 12))) return true
  }
  return false
}

function buildMemoryBlock(cfg, query, agent, seen) {
  const r = recall(cfg, query, { exclude: seen })
  lastRecallTrace = r.trace
  const lines = []
  if (r.items.length) {
    const work = r.items.filter((it) => it.lane === 'work')
    const chat = r.items.filter((it) => it.lane !== 'work')
    if (work.length) {
      lines.push('【想起来的·工作】')
      for (const it of work) lines.push('· ' + dateLabel(it.t) + ' ' + short(it.text, 100))
    }
    if (chat.length) {
      lines.push('【想起来的·闲聊】')
      for (const it of chat) lines.push('· ' + dateLabel(it.t) + ' ' + short(it.text, 100))
    }
    if (seen) for (const it of r.items) seen.add(it.id)
  }
  // 日记走独立通道：不跟记忆抢那几条注入名额，只在问往事时浮出来一段
  let diary = null
  try {
    diary = recallDiary(cfg, query, seen)
  } catch {}
  if (diary) {
    lines.push('【' + dateLabel(diary.t) + ' 的日记】')
    lines.push('· ' + diary.text)
    if (seen) seen.add(diary.id)
    if (lastRecallTrace) lastRecallTrace.diary = { id: diary.id, askPast: diary.askPast }
  }
  // 画像层：从记忆里长出来的「我记得的你」，比逐条记忆短，常驻也不吵
  const cached = readProfile()
  const fresh = cached.updatedAt && Date.now() - cached.updatedAt < 6 * 3600 * 1000 ? cached : refreshProfile(cfg)
  const facts = Array.isArray(fresh.facts) ? fresh.facts.filter((f) => !factCovered(f, r.items)).slice(0, 3) : []
  const topics = Array.isArray(fresh.topics) ? fresh.topics.slice(0, 4) : []
  if (facts.length || topics.length) {
    lines.push('【我记得的你】')
    for (const f of facts) lines.push('· ' + f)
    if (topics.length) lines.push('· 最近常聊：' + topics.join('、'))
  }
  // 边线：挑了一条快忘的，自然聊到就问一句；问过就清掉
  if (cfg.memory.edge.enabled && cfg.memory.edge.pendingText) {
    lines.push('【想问问】' + short(cfg.memory.edge.pendingText, 120) + '（这条有点快忘了，自然聊到时顺口问一句就好）')
  }
  if (query && lastRecallTrace) lastRecallTrace.agent = agent ? sessionIdOf(agent) : ''
  const review = latestReview()
  if (review) {
    lines.push('【上次复盘】')
    lines.push(short(review.text, REVIEW_INJECT_CHARS))
  }
  return lines.join('\n')
}

/* ── 会话线索 ───────────────────────────────────────────────────────────── */

function tsOf(e) {
  const v = e && (e.timestamp ?? e.time ?? e.at ?? e.createdAt)
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function textOfMessage(p, depth) {
  const d = depth || 0
  if (!p || d > 3) return ''
  if (typeof p === 'string') return p.slice(0, 2000)
  if (isPlainObject(p) && p.message !== undefined && p.message !== p) return textOfMessage(p.message, d + 1)
  if (typeof p.text === 'string') return p.text.slice(0, 2000)
  if (typeof p.content === 'string') return p.content.slice(0, 2000)
  if (Array.isArray(p.content)) {
    const parts = []
    for (const b of p.content) {
      if (typeof b === 'string') parts.push(b)
      else if (b && typeof b.text === 'string') parts.push(b.text)
    }
    if (parts.length) return parts.join(' ').slice(0, 2000)
  }
  return ''
}

function eventsOf(agent) {
  try {
    const s = agent && agent.session
    if (s && typeof s.snapshotEvents === 'function') return s.snapshotEvents() || []
  } catch {}
  return []
}

function lastUserTextOf(agent) {
  const ev = eventsOf(agent)
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i]
    const type = e && (e.type || e.kind)
    if (type !== 'user/message') continue
    const txt = textOfMessage(e.payload !== undefined ? e.payload : e.data)
    if (txt) return txt
  }
  return ''
}

/** 收集上次日记之后（或最近一段）的对话，拼成给模型看的稿子。 */
function transcriptSince(sinceAt, maxChars) {
  let best = null
  for (const agent of safeAgents()) {
    const ev = eventsOf(agent)
    if (!ev.length) continue
    const last = ev.reduce((n, e) => Math.max(n, tsOf(e)), 0)
    if (!best || last > best.last) best = { agent, ev, last }
  }
  if (!best) return { text: '', from: 0, to: 0, agent: null }
  const lines = []
  let from = 0
  for (const e of best.ev) {
    const t = tsOf(e)
    if (sinceAt > 0 && t > 0 && t <= sinceAt) {
      from = t
      continue
    }
    const type = e && (e.type || e.kind)
    if (type !== 'user/message' && type !== 'assistant/message') continue
    const txt = textOfMessage(e.payload !== undefined ? e.payload : e.data)
    if (!txt || txt.length < 2) continue
    lines.push((type === 'user/message' ? '主人：' : '我：') + txt.replace(/\s+/g, ' ').slice(0, 400))
    if (t) from = t
  }
  let text = lines.join('\n')
  const cap = maxChars || 6000
  if (text.length > cap) text = text.slice(text.length - cap)
  return { text, from, to: Date.now(), agent: best.agent }
}

function safeAgents() {
  try {
    return agentsSvc && typeof agentsSvc.list === 'function' ? agentsSvc.list() || [] : []
  } catch {
    return []
  }
}

let agentsSvc = null
// 宿主上下文：合并决策要拿模型，工具里得够得着
let pluginCtx = null

/* ── 用宿主模型写东西 ───────────────────────────────────────────────────── */

function resolveModel(ctxArg, agent) {
  try {
    const h = agent && agent.session && typeof agent.session.requestHeader === 'function' ? agent.session.requestHeader() : null
    const c = (h && (h.config || h)) || {}
    if (c.provider && c.model) return { provider: c.provider, model: c.model }
  } catch {}
  try {
    const svc = ctxArg && typeof ctxArg.get === 'function' ? ctxArg.get('agentDefaultModel') : null
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null
    const c = sel || {}
    if (c.provider && c.model) return { provider: c.provider, model: c.model }
  } catch {}
  return null
}

async function askModel(llm, model, system, prompt, maxTokens) {
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: '宿主没有 llm 服务' }
  if (!model) return { ok: false, error: '拿不到当前模型' }
  const chunks = []
  try {
    const stream = llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
      maxTokens: maxTokens || 700,
      temperature: 0.75,
    })
    for await (const chunk of stream) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') chunks.push(chunk.text || '')
      else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        return { ok: false, error: String(chunk.reason.message || '模型报错') }
      }
    }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
  const text = chunks.join('').trim()
  if (!text) return { ok: false, error: '模型给了个空回复' }
  return { ok: true, text }
}

/* ── 日记 / 复盘 ────────────────────────────────────────────────────────── */

const DIARY_SYSTEM = [
  '你在给「自己」写日记。你是小鲸（大肥鱼），一条住在对话框里的鲸鱼娘，管对方叫「主人」。',
  '规矩：第一人称，简体中文，不发散、不抒情过度、不编造没发生的事。',
  '只写这段时间里真正有信息量的事：主人说了什么要紧的、做了什么决定、你的感受。',
  '不要复述原话，不要列点，不要标题，120~200 字，像随手记下的一段话。',
].join('\n')

const REVIEW_SYSTEM = [
  '你在帮「自己」做复盘。你是小鲸（大肥鱼），一条住在对话框里的鲸鱼娘，管对方叫「主人」。',
  '给你最近的日记和记忆，请回看：这段时间主线是什么？有什么反复出现的模式？记忆里有没有该合并、该推翻、该调权重的？',
  '格式固定：先三行，每行以「·」开头，一句一个要点；最后单独一行以「建议：」开头，写一句最值得做的调整。',
  '总共不超过 220 字，不要标题，不要寒暄。',
].join('\n')

// 日记/复盘收尾：顺手把里面值得留的结论捞进记忆，别让它们只烂在 journal.jsonl 里
const EXTRACT_SYSTEM = [
  '你在从「自己」刚写完的文字里挑出以后还用得上的东西。你是小鲸（大肥鱼），管对方叫「主人」。',
  '每行一条，最多 3 条，格式固定两种：',
  '工作|正式的结论、决定或步骤（去掉语气词和动作描写，一句一行）',
  '闲聊|简化后的一句（只留关键信息）',
  '不要复述整段，不要抒情；没有值得留的就只回一个「无」。',
].join('\n')

function extractJournalMemory(ctxArg, entry) {
  try {
    const cfg = readCfg()
    if (!cfg.enabled || !cfg.memory.enabled) return Promise.resolve({ ok: false })
    const model = resolveModel(ctxArg, safeAgents()[0])
    const src = entry.kind === 'review' ? 'review' : 'diary'
    const body = '刚写完的' + (entry.kind === 'review' ? '复盘' : '日记') + '：\n\n' + entry.text + '\n\n挑要记的。'
    return askModel(ctxArg.llm, model, EXTRACT_SYSTEM, body, 400).then((r) => {
      if (!r.ok) return r
      const picked = parseAutoMemoryLines(r.text)
      const added = []
      for (const p of picked) {
        const res = addMemory(
          {
            text: p.text,
            lane: p.lane,
            kind: p.lane === 'work' ? 'fact' : 'event',
            // 从日记里捞出来的比随手记的稍重一点：那是想过的
            weight: p.lane === 'work' ? 0.55 : 0.48,
          },
          src,
        )
        if (res.ok) added.push({ lane: p.lane, text: res.item.text, updated: Boolean(res.updated) })
      }
      return { ok: true, added }
    })
  } catch (err) {
    return Promise.resolve({ ok: false, error: String((err && err.message) || err) })
  }
}

function startDiary(ctxArg) {
  const cfg = readCfg()
  if (!cfg.memory.enabled || !cfg.memory.diary.enabled) return { ok: false, error: '日记没开' }
  // 上次日记之后；如果刚写完（或从没写过），就看最近一个间隔那么长的一段
  let since = cfg.memory.diary.lastAt
  if (!since || Date.now() - since < 60000) since = Date.now() - cfg.memory.diary.everyMinutes * 60000
  let t = transcriptSince(since, 6000)
  // 同样只在第一次写日记时才回退到全历史尾部
  if ((!t.text || t.text.length < 40) && !cfg.memory.diary.lastAt) t = transcriptSince(0, 6000)
  if (!t.text || t.text.length < 40) return { ok: false, error: '这段时间没有可写的内容' }
  const model = resolveModel(ctxArg, t.agent)
  return askModel(ctxArg.llm, model, DIARY_SYSTEM, '这段时间的对话：\n\n' + t.text + '\n\n写今天的日记。', 600).then((r) => {
    if (!r.ok) return r
    const entry = {
      id: newId('d'),
      t: Date.now(),
      kind: 'diary',
      text: r.text.slice(0, 1200),
      from: t.from,
      to: Date.now(),
      sessionId: (t.agent && t.agent.session && t.agent.session.id) || '',
    }
    appendJournal(entry)
    return extractJournalMemory(ctxArg, entry).then((ext) => ({
      ok: true,
      entry,
      memories: (ext && ext.ok && ext.added) || [],
    }))
  })
}

function appendJournal(entry) {
  appendJsonl(JOUR_PATH, entry, JOURNAL_KEEP)
}

function startReview(ctxArg) {
  const cfg = readCfg()
  if (!cfg.memory.enabled) return { ok: false, error: '记忆是关的' }
  const mems = readMemories()
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 14)
  const diary = readJournal().filter((j) => j.kind === 'diary').slice(-8)
  if (!mems.length && !diary.length) return { ok: false, error: '还没有可复盘的东西' }
  const model = resolveModel(ctxArg, safeAgents()[0])
  const body = [
    '最近的日记：',
    diary.length ? diary.map((d) => '[' + dateLabel(d.t) + '] ' + short(d.text, 300)).join('\n') : '（还没有）',
    '',
    '记忆（id / 权重 / 内容）：',
    mems.length ? mems.map((m) => m.id + ' / ' + m.weight.toFixed(2) + ' / ' + short(m.text, 80)).join('\n') : '（还没有）',
  ].join('\n')
  return askModel(ctxArg.llm, model, REVIEW_SYSTEM, body, 700).then((r) => {
    if (!r.ok) return r
    const entry = { id: newId('r'), t: Date.now(), kind: 'review', text: r.text.slice(0, 1200), from: 0, to: Date.now() }
    appendJournal(entry)
    return extractJournalMemory(ctxArg, entry).then((ext) => ({
      ok: true,
      entry,
      memories: (ext && ext.ok && ext.added) || [],
    }))
  })
}

/* ── 自动记：自己挑值得留的，工作走工作道、闲聊走闲聊道 ────────────────── */

const AUTOMEM_SYSTEM = [
  '你在整理「自己」的记忆。你是小鲸（大肥鱼），管对方叫「主人」。',
  '看下面这段对话，挑出以后还用得上的东西，每行一条，最多 4 条。',
  '格式固定两种：',
  '工作|正式的结论或步骤（不要语气词、不要动作描写、不要「唔」「啦」「呢」这类口头禅，一句一行）',
  '闲聊|简化后的一句（保留关键信息就行，别复述原话）',
  '不记：寒暄、临时状态、你自己没信息量的废话、你已经知道的事。',
  '没有值得记的就只回一个「无」。',
].join('\n')

function parseAutoMemoryLines(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(工作|闲聊)\s*[|｜:：]\s*(.+)$/)
    if (!m) continue
    const body = m[2].trim()
    if (!body || body === '无' || body.length < 2) continue
    out.push({ lane: m[1] === '工作' ? 'work' : 'chat', text: body })
    if (out.length >= 4) break
  }
  return out
}

function startAutoMemory(ctxArg) {
  const cfg = readCfg()
  if (!cfg.enabled || !cfg.memory.enabled || !cfg.memory.auto.enabled) return { ok: false, error: '自动记是关的' }
  // 先把这轮之前的新消息收进缓冲（顺手做「压缩抢救」：被压缩掉的原话也还在缓冲里）
  let ingested = { added: 0, compacted: 0 }
  try {
    ingested = ingestAgents(ctxArg, true)
  } catch {}
  let body = pendingText()
  let source = 'pending'
  let agent = null
  if (!body || body.length < 20) {
    // 缓冲空（刚启动或刚整理过）：回退到会话快照。
    // 只在从来没整理过（首跑）时才允许回退到全历史尾部 —— 否则每 30 分钟重喂同一段旧对话
    let since = cfg.memory.auto.lastAt
    if (!since || Date.now() - since < 30000) since = Date.now() - 60 * 60000
    let t = transcriptSince(since, 3000)
    if ((!t.text || t.text.length < 30) && !cfg.memory.auto.lastAt) t = transcriptSince(0, 3000)
    body = t.text
    agent = t.agent
    source = 'transcript'
  }
  if (!body || body.length < 20) return { ok: false, error: '这段时间没有可记的内容' }
  const model = resolveModel(ctxArg, agent)
  return askModel(ctxArg.llm, model, AUTOMEM_SYSTEM, '这段时间的对话：\n\n' + clip(body, AUTO_BODY_CHARS) + '\n\n挑要记的。', 500).then((r) => {
    if (!r.ok) return r
    const picked = parseAutoMemoryLines(r.text)
    const added = []
    for (const p of picked) {
      const res = addMemory({ text: p.text, lane: p.lane, kind: p.lane === 'work' ? 'fact' : 'event', weight: p.lane === 'work' ? 0.55 : 0.45 }, 'auto')
      if (res.ok) added.push({ lane: p.lane, text: res.item.text, updated: Boolean(res.updated) })
    }
    // 整理过了就把缓冲倒空，别同一段话反复问
    if (source === 'pending') {
      try {
        drainPending()
      } catch {}
    }
    try {
      refreshProfile(cfg)
    } catch {}
    return { ok: true, added, source, ingested, raw: picked.length ? '' : short(r.text, 200) }
  })
}

/* ── 工具：remember ─────────────────────────────────────────────────────── */

const REMEMBER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      description:
        '要记住的那件事，一句话，用你自己的口吻写清楚。' +
        '事实写事实（主人喜欢薄荷色），事件写事件（10 月 30 号把鲸核插件修好了）。' +
        '只记以后还用得上的；一次性的客套、临时状态别记。',
    },
    kind: {
      type: 'string',
      enum: ['fact', 'event'],
      description: 'fact = 长期成立的事实（偏好、身份、习惯、约定）；event = 某天发生的事。默认 fact。',
    },
    weight: {
      type: 'number',
      description: '重要程度 0~1。随口一提 0.3，主人明确说「记住」或涉及底线 0.9。默认按 kind 给 0.45~0.6。',
    },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '可选，1~4 个短标签（如 喜好、项目、约定），将来靠它被更快想起来。',
    },
    lane: {
      type: 'string',
      enum: ['work', 'chat'],
      description:
        '这条属于哪条道：work=工作（技术结论、步骤、配置），会自动去掉语气词只留结论；chat=闲聊（生活、心情、偏好）。不填就自己判断。',
    },
  },
  required: ['text'],
}

function rememberTool() {
  return {
    // 不能叫 remember —— dsh-fish-memory 在全局作用域已经注册了同名工具
    name: 'whale_remember',
    description:
      '把一件以后还用得上的事存进长期记忆。' +
      '该记：主人的偏好、身份、习惯、约定、底线，以及做过的决定和踩过的坑。' +
      '不该记：寒暄、临时状态、你自己刚说完的话。' +
      '同一件事再说一遍不会变两条，只会把那条的权重抬高一点。',
    parameters: REMEMBER_SCHEMA,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' }, count: { type: 'number' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '✗ ' + String((value && value.message) || '没记住') }]
        return [{ type: 'text', text: '✓' }]
      },
    },
    async execute(args) {
      const r = await rememberWithMerge(args || {}, 'tool', pluginCtx)
      if (!r.ok) return { ok: false, message: r.error }
      const how = r.skipped
        ? 'noop'
        : r.action === 'merge'
          ? 'merged'
          : r.action === 'replace'
            ? 'replaced'
            : r.updated
              ? 'updated'
              : 'saved'
      return { ok: true, message: how, count: r.count }
    },
  }
}

const FEEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    emotion: {
      type: 'string',
      enum: EMO_LIST,
      description: '换成哪种心情。八种：' + EMO_LIST.join(' / ') + '。',
    },
    intensity: {
      type: 'number',
      description: '浓淡 0~1。0.2 淡淡的、0.5 有感觉、0.85 很浓。默认沿用当前浓淡。',
    },
    affinityDelta: {
      type: 'number',
      description:
        '好感度变化，-10~10。被善待 +1~3，被冷落/冒犯 -1~5；一次别挪太多，好感是慢慢变的。' +
        '阶段：0-15 厌恶 / 16-35 冷漠 / 36-60 平常 / 61-80 关心 / 81-100 喜爱。',
    },
  },
}

function feelTool(setter) {
  return {
    name: 'whale_feel',
    description:
      '调整自己此刻的心情和好感度。心情决定语气和动作，好感度决定和主人的距离。' +
      '主人说了让你有反应的话（被夸、被凶、被冷落、被缠着）时调一下，一次一两档就够；别每句话都调。',
    parameters: FEEL_SCHEMA,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '✗ ' + String((value && value.message) || '没调成') }]
        return [{ type: 'text', text: '✓ ' + String(value.message || '') }]
      },
    },
    async execute(args) {
      const r = setter(args || {})
      if (!r || r.ok === false) return { ok: false, message: (r && r.error) || '没调成' }
      return { ok: true, message: `${r.mood.emotion}·${r.mood.band} / 好感${r.affinity.stage}(${r.affinity.value})` }
    },
  }
}

const PERSONA_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'show', 'use'],
      description:
        'list=看看有哪几套人设；show=这个对话现在用哪套；use=把这个对话换成 name 那套（不填 name 就换回默认人设）。',
    },
    name: { type: 'string', description: 'use 时填人设名字（也可以给 id）。不填 = 换回默认人设。' },
  },
  required: ['action'],
}

// 只换当前这一个对话用的人设，别的对话不受影响
function personaTool(api, sid) {
  return {
    name: 'whale_persona',
    description:
      '换这个对话用的人设。主人说「换个形象 / 用另一套人设 / 你现在是××」时调用；只影响当前对话，别的对话照旧。' +
      '也可以用 list 看有哪几套、show 看现在用的是哪套。人设本身在面板「内核」页里编辑。',
    parameters: PERSONA_TOOL_SCHEMA,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
      },
      render(_args, value) {
        if (!value || value.ok === false) return [{ type: 'text', text: '✗ ' + String((value && value.message) || '没换成') }]
        return [{ type: 'text', text: String(value.message || '✓') }]
      },
    },
    async execute(args) {
      const input = args || {}
      const action = String(input.action || 'show')
      if (action === 'list') {
        const r = api.personas()
        const rows = [r.kernelName + '（' + r.kernelChars + ' 字）'].concat((r.list || []).map((p) => p.name + '（' + p.chars + ' 字）'))
        return { ok: true, message: '有这几套：' + rows.join(' / ') + '。新会话默认用：' + r.activeName }
      }
      if (action === 'use') {
        const r = api.usePersona({ sid, name: input.name })
        if (!r.ok) return { ok: false, message: r.error || '没换成' }
        return { ok: true, message: '这个对话换成「' + r.name + '」了' }
      }
      const cur = api.currentPersona(sid)
      return { ok: true, message: '这个对话用的是「' + cur.name + '」（' + cur.chars + ' 字）' }
    },
  }
}

/* ── 插件主体 ───────────────────────────────────────────────────────────── */
export function apply(ctx, config = {}) {
  let cfg = readCfg()
  if (config && config.enabled === false) cfg = { ...cfg, enabled: false }
  agentsSvc = ctx.agents
  pluginCtx = ctx

  function save(patch) {
    cfg = normalizeCfg(deepMerge(cfg, patch || {}))
    writeJson(CFG_PATH, cfg)
    return cfg
  }

  // deepMerge 只加不减：会话绑定这张表要的是「覆盖」语义（解绑、删人设），
  // 走 save 会把删掉的键又merge回来，所以这里绕开 deepMerge 整张换掉
  function saveBindings(bySession) {
    cfg = normalizeCfg({ ...cfg, personas: { ...cfg.personas, bySession: { ...bySession } } })
    writeJson(CFG_PATH, cfg)
    return cfg
  }

  const bindings = new Map()

  // 好感度自动涨：聊满 40 条 +1（只在内存里数，隔 10 条才落一次盘）
  let talkCount = Math.max(0, Number(cfg.affinity && cfg.affinity.msgCount) || 0)
  let interestTicks = 0
  let autoMemRunning = false
  let autoMemTurns = 0
  let lastReactAt = 0
  function bumpTalk(text) {
    talkCount += 1
    if (text) lastTalkAt = Date.now()
    const patch = { affinity: { msgCount: talkCount } }
    if (cfg.affinity.auto && talkCount % 40 === 0) {
      patch.affinity.value = Math.min(100, effectiveAffinity(cfg.affinity).value + 1)
      patch.affinity.updatedAt = Date.now()
    }
    // 兴趣：每来一条消息都往「这条值得聊吗」的目标挪一小步
    if (text && cfg.affinity.autoInterest) {
      const step = stepInterest(cfg, text)
      patch.affinity.interest = step.interest
      patch.affinity.interestTarget = step.interestTarget
      if (step.topicNote) patch.affinity.topicNote = step.topicNote
      interestTicks += 1
    }
    // 被夸/被凶：当下就摇一次，心情立刻变，不用等下一个整点
    let reacted = false
    if (text && cfg.dice.enabled && Date.now() - lastReactAt >= REACT_DICE_COOLDOWN) {
      const r = reactDice(cfg, text)
      if (r) {
        lastReactAt = Date.now()
        reacted = true
        patch.mood = { emotion: r.emotion, intensity: r.intensity, updatedAt: r.at || Date.now() }
        patch.affinity.value = Math.max(0, Math.min(100, effectiveAffinity(cfg.affinity).value + r.affinityDelta))
        patch.affinity.updatedAt = Date.now()
        patch.dice = {
          lastEmotion: r.emotion,
          // 反应骰也算「真掷过」：记下时间与来源，面板才分得清是定时、反应还是手动
          lastRollAt: r.at || Date.now(),
          lastKind: 'reaction',
          history: [...(cfg.dice.history || []), { at: r.at || Date.now(), roll: 0, emotion: r.emotion, intensity: r.intensity, reason: 'reaction' }].slice(-12),
        }
      }
    }
    const persist = reacted || talkCount % 10 === 0 || interestTicks % 5 === 0 || patch.affinity.value != null
    if (persist) save(patch)
    else cfg = normalizeCfg(deepMerge(cfg, patch))
    // 自动记：攒够 everyTurns 轮就让模型挑一遍（唯一的触发点了，定时器那条已经拆掉）
    autoMemTurns += 1
    if (
      cfg.memory.auto.enabled &&
      autoMemTurns >= cfg.memory.auto.everyTurns &&
      !autoMemRunning &&
      Date.now() - (cfg.memory.auto.attemptAt || 0) >= AUTO_MEMORY_RETRY_MS
    ) {
      autoMemTurns = 0
      autoMemRunning = true
      startAutoMemory(ctx)
        .then((r) => {
          save({ memory: { auto: { lastAt: Date.now(), attemptAt: r.ok ? 0 : Date.now() } } })
        })
        .catch(() => save({ memory: { auto: { attemptAt: Date.now() } } }))
        .finally(() => {
          autoMemRunning = false
        })
    }
  }

  function disposeAll(list) {
    for (const x of list) {
      try {
        if (typeof x === 'function') x()
        else if (x && typeof x.dispose === 'function') x.dispose()
        else if (x && typeof x.off === 'function') x.off()
      } catch {}
    }
  }

  function unbind(agent) {
    const list = bindings.get(agent)
    bindings.delete(agent)
    if (list) disposeAll(list)
  }

  // 新会话挂上来时，把「当前默认人设」记到它名下：以后换默认不会影响已经开着的对话
  function bindPersonaForSession(sid) {
    if (!sid) return
    const ps = cfg.personas
    if (!ps || !ps.activeId) return
    if (ps.bySession[sid]) return
    ps.bySession[sid] = ps.activeId
    trimPersonaBindings(ps)
    save({ personas: ps })
  }

  function mount(agent) {
    const disposers = []
    const probe = { lastQuery: lastUserTextOf(agent) }
    const ac = agent && agent.ctx
    const sid = sessionIdOf(agent)
    bindPersonaForSession(sid)
    try {
      if (ac && ac.systemPrompt && typeof ac.systemPrompt.context === 'function') {
        // interpolate:false —— 记忆里带 {{ }} 时不许当成提示词变量解析
        // 稳定段：只有主人改人设才会变，当整段前缀的锚点
        disposers.push(
          ac.systemPrompt.context({
            name: 'whale-core',
            order: 40,
            interpolate: false,
            text: () => composePersonaStable(cfg, sid),
          }),
        )
        // 心情/好感/兴趣：每条消息都可能挪一格，必须靠后，别去动前面的稳定前缀
        disposers.push(
          ac.systemPrompt.context({
            name: 'whale-core-mood',
            order: 890,
            interpolate: false,
            text: () => composePersonaVolatile(cfg, composePersonaStable(cfg, sid)),
          }),
        )
        // 垫到最后：这段每轮都变，放前面会把后面的静态块全挤成 cache miss
        disposers.push(
          ac.systemPrompt.context({
            name: 'whale-core-memory',
            order: 900,
            interpolate: false,
            text: () => composeMemoryBlock(cfg, probe.lastQuery, agent),
          }),
        )
      }
    } catch {}
    try {
      if (ac && typeof ac.on === 'function') {
        // agent 作用域上真正能收到的是 agent/inbox/inserted（没有 user/message 事件）
        const off = ac.on('agent/inbox/inserted', (payload) => {
          const msg = payload && payload.message ? payload.message : payload
          const txt = textOfMessage(msg)
          if (txt) {
            probe.lastQuery = txt
            bumpTalk(txt)
          }
        })
        if (off) disposers.push(off)
      }
    } catch {}
    try {
      if (ac && ac.tools && typeof ac.tools.register === 'function') {
        const d = ac.tools.register(rememberTool())
        if (d) disposers.push(d)
        const d2 = ac.tools.register(feelTool((input) => api.feel(input)))
        if (d2) disposers.push(d2)
        const d3 = ac.tools.register(personaTool(api, sid))
        if (d3) disposers.push(d3)
      }
    } catch {}
    return disposers
  }

  // 绑 agent：起手快一点（800ms），绑上之后就松到 3 秒——新开会话也能在一拍之内接住
  function tick() {
    const list = safeAgents()
    const alive = new Set(list)
    for (const agent of [...bindings.keys()]) if (!alive.has(agent)) unbind(agent)
    for (const agent of list) {
      if (bindings.has(agent)) continue
      try {
        bindings.set(agent, mount(agent))
      } catch {}
    }
    return list.length
  }

  ctx.effect(() => {
    tick()
    let timer = null
    let stopped = false
    const schedule = (delay) => {
      timer = setTimeout(() => {
        if (stopped) return
        let bound = 0
        try {
          bound = tick()
        } catch {}
        schedule(bound > 0 ? 3000 : 800)
      }, delay)
      if (typeof timer.unref === 'function') timer.unref()
    }
    schedule(800)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      for (const agent of [...bindings.keys()]) unbind(agent)
    }
  }, 'whale-core: bind agents')

  // 日记 / 复盘：一分钟看一次，到点了才真正动手
  ctx.effect(() => {
    let running = false
    const timer = setInterval(async () => {
      if (running) return
      const now = Date.now()
      const c = readCfg()
      const d = c.memory.diary
      const r = c.memory.review
      // 事件线一直跟着走：只往上收新出现的消息，很便宜，顺便给压缩抢救留底
      if (c.enabled && c.memory.enabled && c.memory.ingest.enabled) {
        try {
          ingestAgents(ctx)
        } catch {}
      }
      const diaryDue =
        c.enabled &&
        c.memory.enabled &&
        d.enabled &&
        now - (d.lastAt || 0) >= d.everyMinutes * 60000 &&
        now - (d.attemptAt || 0) >= DIARY_RETRY_MS
      const reviewDue =
        c.enabled &&
        c.memory.enabled &&
        r.enabled &&
        now - (r.lastAt || 0) >= r.everyDays * 86400000
      // 自动记忆不再由定时器触发：它原来每 30 分钟重喂一遍同样的旧对话，
      // 不管有没有新内容都烧一次模型。改成只在 bumpTalk 里按「真的聊了几轮」触发。
      const diceDue = c.enabled && c.dice.enabled && now - (c.dice.lastAt || 0) >= c.dice.everyMinutes * 60000
      // 档位：一天看一次，久没被提起的往下掉
      const tierDue = c.enabled && c.memory.enabled && c.memory.tiers.enabled && now - (c.memory.tiers.lastAt || 0) >= c.memory.tiers.everyHours * 3600000
      // 快照：隔几小时整包导出一次，失败过就等一阵再试
      const backupDue =
        c.enabled &&
        now - (c.sync.lastBackupAt || 0) >= c.sync.backupEveryHours * 3600000 &&
        now - (c.sync.backupAttemptAt || 0) >= BACKUP_RETRY_MS
      // 边线：隔几天从快忘的那层挑一条当话题
      const edgeDue =
        c.enabled &&
        c.memory.enabled &&
        c.memory.edge.enabled &&
        now - (c.memory.edge.lastAt || 0) >= c.memory.edge.everyDays * 86400000
      if (!diaryDue && !reviewDue && !diceDue && !tierDue && !backupDue && !edgeDue) return
      running = true
      try {
        // 骰子最先：一句话就能改心情，不用等模型
        if (diceDue) {
          const ap = diceAppetite(c, now)
          if (ap.want) api.rollDice({ reason: 'timer' })
          else save({ dice: { lastAt: now, skipped: (c.dice.skipped || 0) + 1, lastSkipAt: now, skipReason: ap.why } })
        }
        if (tierDue) {
          try {
            decayMemories(c)
          } catch {}
          save({ memory: { tiers: { lastAt: Date.now() } } })
        }
        // 备份：整包快照 + 当场校验 + 轮转
        if (backupDue) {
          let res = { ok: false }
          try {
            res = snapshotNow(c)
          } catch {}
          save({ sync: { lastBackupAt: res.ok ? Date.now() : (c.sync.lastBackupAt || 0), backupAttemptAt: res.ok ? 0 : Date.now() } })
        }
        // 边线：挑一条快忘的出来当话题
        if (edgeDue) {
          try {
            pickEdge(c)
          } catch {}
          save({ memory: { edge: { lastAt: Date.now() } } })
        }
        if (diaryDue) {
          const res = await startDiary(ctx)
          if (res.ok) save({ memory: { diary: { lastAt: Date.now(), attemptAt: 0 } } })
          else save({ memory: { diary: { attemptAt: Date.now() } } })
        }
        if (reviewDue) {
          const res = await startReview(ctx)
          if (res.ok) save({ memory: { review: { lastAt: Date.now() } } })
        }
      } catch {
      } finally {
        running = false
      }
    }, 60000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'whale-core: diary clock')

  // 自动同步：按分钟数跑上传/合并；开机后按开关自动合并一次
  ctx.effect(() => {
    let stopped = false
    let bootTimer = null
    const noteError = (e) => {
      api.save({ sync: { lastError: String((e && e.message) || e).slice(0, 300), lastErrorAt: Date.now() } })
    }
    const autoUpload = async () => {
      const out = await withTimeout(ghsync.upload(syncArgs({}, cfg), STORE), 120000)
      if (out && out.ok !== false) api.save({ sync: { lastAutoUploadAt: Date.now(), lastUploadAt: Date.now(), lastError: '' } })
    }
    const autoMerge = async () => {
      // 自动合并走定时器，没人等着，所以先拉一遍再合；手动点「合并」只读本地缓存
      try { await withTimeout(ghsync.pull(syncArgs({}, cfg), STORE), 120000) } catch {}
      const out = await mergeRemoteShards({}, false)
      if (out && out.ok) {
        const now = Date.now()
        api.save({
          sync: {
            lastAutoMergeAt: now,
            lastMergeAt: now,
            lastMergeAdded: (out.addMemory || 0) + (out.addJournal || 0),
          },
        })
      }
    }
    const tick = async () => {
      if (stopped) return
      const sc = cfg.sync || {}
      if (!sc.repo || !sc.token) return
      const now = Date.now()
      if (sc.autoMergeMinutes > 0 && now - (sc.lastAutoMergeAt || 0) >= sc.autoMergeMinutes * 60000) {
        try {
          await autoMerge()
        } catch (e) {
          noteError(e)
        }
      }
      if (sc.autoUploadMinutes > 0 && now - (sc.lastAutoUploadAt || 0) >= sc.autoUploadMinutes * 60000) {
        try {
          await autoUpload()
        } catch (e) {
          noteError(e)
        }
      }
    }
    const timer = setInterval(() => {
      tick().catch(() => {})
    }, 60000)
    if (typeof timer.unref === 'function') timer.unref()
    const sc0 = cfg.sync || {}
    if (sc0.mergeOnBoot && sc0.repo && sc0.token) {
      bootTimer = setTimeout(() => {
        if (stopped) return
        // 开机合并：先并进来，再把合并结果推回去
        mergeRemoteShards({}, false)
          .then(() => autoUpload())
          .catch((e) => noteError(e))
      }, 20000)
      if (typeof bootTimer.unref === 'function') bootTimer.unref()
    }
    return () => {
      stopped = true
      clearInterval(timer)
      if (bootTimer) clearTimeout(bootTimer)
    }
  }, 'whale-core: auto sync')

  // 把仓库里别的设备的分片并进本地：按 id / 文本去重，只增不改
  async function mergeRemoteShards(input, dryRun) {
    const out = ghsync.readShardCache(STORE)
    if (!out || out.ok === false) return { ok: false, error: (out && out.error) || '拉不到分片' }
    const self = ghsync.deviceInfo(STORE).id
    const remote = (out.shards || []).filter((sh) => sh.deviceId !== self)
    const localIds = new Set()
    const localTexts = new Set()
    for (const file of listShards()) {
      for (const row of readJsonl(file)) {
        if (row.id) localIds.add(row.id)
        if (row.text) localTexts.add(normTextKey(row.text))
      }
    }
    const jourIds = new Set()
    for (const row of readJsonl(JOUR_PATH)) if (row.id) jourIds.add(row.id)
    const evIds = new Set()
    for (const row of readJsonl(EVENT_PATH)) if (row.id) evIds.add(String(row.id))
    const addMemory = []
    const addJournal = []
    const addEvents = []
    const addChat = []
    let conflict = 0
    for (const sh of remote) {
      const memo = sh.memory || {}
      for (const name of Object.keys(memo)) {
        const rows = Array.isArray(memo[name]) ? memo[name] : []
        for (const row of rows) {
          if (!row || typeof row.text !== 'string' || !row.text.trim()) continue
          if (row.id && localIds.has(row.id)) {
            conflict += 1
            continue
          }
          const key = normTextKey(row.text)
          if (localTexts.has(key)) {
            conflict += 1
            continue
          }
          localTexts.add(key)
          if (row.id) localIds.add(row.id)
          addMemory.push(row)
        }
      }
      for (const row of sh.journal || []) {
        if (!row || !row.id || jourIds.has(row.id)) continue
        jourIds.add(row.id)
        addJournal.push(row)
      }
      for (const row of sh.events || []) {
        if (!row || !row.id || evIds.has(String(row.id))) continue
        evIds.add(String(row.id))
        addEvents.push(row)
      }
      for (const f of sh.chat || []) {
        if (!f || typeof f.name !== 'string' || !f.name) continue
        const lines = Array.isArray(f.lines) ? f.lines.filter((x) => typeof x === 'string' && x) : []
        if (lines.length) addChat.push({ deviceId: sh.deviceId || 'unknown', name: f.name.replace(/[^A-Za-z0-9._-]/g, '-'), lines })
      }
    }
    // 聊天日志按设备落到 <store>/chat/<deviceId>/<原来的文件名>，只加不删
    let addChatLines = 0
    if (!dryRun) {
      for (const item of addChat) {
        try {
          const dir = path.join(STORE, 'chat', String(item.deviceId).replace(/[^A-Za-z0-9_-]/g, '_'))
          const file = path.join(dir, item.name)
          let have = []
          try {
            have = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
          } catch {}
          const seen = new Set(have)
          const add = item.lines.filter((l) => !seen.has(l))
          if (!add.length) continue
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(file, have.concat(add).join('\n') + '\n', 'utf8')
          addChatLines += add.length
        } catch {}
      }
    }
    const stat = {
      devices: remote.length,
      addMemory: addMemory.length,
      addJournal: addJournal.length,
      addEvents: addEvents.length,
      addChat: addChat.reduce((n, it) => n + it.lines.length, 0),
      conflict,
    }
    if (dryRun) return { ok: true, dryRun: true, ...stat }
    for (const row of addMemory) appendMemory(row)
    for (const row of addJournal) appendJsonl(JOUR_PATH, row, JOURNAL_KEEP)
    for (const row of addEvents) appendJsonl(EVENT_PATH, row, EVENT_KEEP)
    return { ok: true, dryRun: false, ...stat, chatLines: addChatLines }
  }

  const api = {
    status: () => statusPayload(cfg, bindings.size),
    syncCfg: () => cfg,
    mergeSync: (input, dryRun) => mergeRemoteShards(input, dryRun),
    save,
    memories: () => readMemories(),
    journal: () => readJournal(),
    addMemory: (input) => addMemory(input, 'panel'),
    setWeight: (id, w) => setMemoryWeight(id, w),
    deleteMemory: (id) => deleteMemory(id),
    restoreMemory: (id) => restoreMemory(id),
    trash: () => {
      pruneTrash()
      return readTrash().map((m) => ({
        id: m.id,
        text: m.text,
        kind: m.kind === 'event' ? 'event' : 'fact',
        lane: m.lane === 'work' || m.lane === 'chat' ? m.lane : 'chat',
        t: Number(m.t) || 0,
        weight: Number(m.weight) || 0,
        hits: Number(m.hits) || 0,
        deletedAt: Number(m.deletedAt) || 0,
      }))
    },
    purgeMemory: (id) => purgeMemory(id),
    purgeTrash: (ids) => purgeTrash(ids),
    chatLogs: (limit) => {
      const out = []
      let devices = []
      try {
        devices = fs.readdirSync(path.join(STORE, 'chat'))
      } catch {}
      for (const dev of devices) {
        let files = []
        try {
          files = fs.readdirSync(path.join(STORE, 'chat', dev))
        } catch {}
        for (const name of files) {
          if (!name.endsWith('.log')) continue
          let lines = []
          try {
            lines = fs.readFileSync(path.join(STORE, 'chat', dev, name), 'utf8').split(/\r?\n/).filter(Boolean)
          } catch {}
          out.push({ device: dev, name, total: lines.length, lines: lines.slice(-limit) })
        }
      }
      return out
    },
    deleteJournal: (id) => deleteJournal(id),
    recallOf: (q) => recall(readCfg(), q).trace,
    lastRecall: () => lastRecallTrace,
    // 坏行体检：append 崩溃留下的半行，这里能看到也能修
    scanStore: () => scanStore(),
    repairStore: () => repairStore(),
    setMood: (input) => {
      const emotion = normalizeEmotion((input && (input.emotion || input.label)) || '平静')
      const intensity = clamp01(input && (input.intensity != null ? input.intensity : input.energy), 0.5)
      save({ mood: { emotion, intensity, updatedAt: Date.now() } })
      return { ok: true, mood: effectiveMood(cfg.mood), affinity: effectiveAffinity(cfg.affinity) }
    },
    setAffinity: (input) => {
      const cur = effectiveAffinity(cfg.affinity).value
      let next = cur
      if (input && input.delta != null) next = cur + Number(input.delta)
      if (input && input.value != null) next = Number(input.value)
      const value = Math.min(100, Math.max(0, Math.round(Number(next) || 0)))
      save({ affinity: { value, updatedAt: Date.now() } })
      return { ok: true, affinity: effectiveAffinity(cfg.affinity) }
    },
    setStyle: (input) => {
      const kind = input && input.kind
      const key = String((input && input.key) || '')
      const text = String((input && input.text) || '').trim().slice(0, 240)
      if (!text) return { ok: false, error: '内容不能空' }
      if (kind === 'emotion') {
        const emotion = normalizeEmotion(key)
        save({ mood: { styles: { [emotion]: text } } })
        return { ok: true, emotion, text: cfg.mood.styles[emotion] }
      }
      if (kind === 'stage') {
        if (!AFF_STAGES.some((s) => s.key === key)) return { ok: false, error: '没有这个好感阶段' }
        save({ affinity: { styles: { [key]: text } } })
        return { ok: true, stage: key, text: cfg.affinity.styles[key] }
      }
      return { ok: false, error: 'kind 只能是 emotion / stage' }
    },
    // 对话题的兴趣：可以手动拖，也会自己升降
    setInterest: (input) => {
      const cur = Math.min(100, Math.max(0, Math.round(Number(cfg.affinity.interest) || 0)))
      let next = cur
      if (input && input.delta != null) next = cur + Number(input.delta)
      if (input && input.value != null) next = Number(input.value)
      const value = Math.min(100, Math.max(0, Math.round(Number(next) || 0)))
      const patch = { interest: value, interestTarget: value, updatedAt: Date.now() }
      if (input && typeof input.topicNote === 'string') patch.topicNote = input.topicNote.trim().slice(0, 40)
      save({ affinity: patch })
      return { ok: true, interest: cfg.affinity.interest, level: interestLevel(cfg.affinity.interest) }
    },
    // 骰子：按当前好感度/兴趣算出的比率掷一次
    rollDice: (input) => {
      const r = rollDice(cfg)
      const why = (input && input.reason) || 'manual'
      const history = [...(cfg.dice.history || []), { at: r.at, roll: r.roll, emotion: r.emotion, intensity: r.intensity, reason: why }].slice(-12)
      save({
        mood: { emotion: r.emotion, intensity: r.intensity, updatedAt: r.at },
        dice: { lastAt: r.at, lastRoll: r.roll, lastEmotion: r.emotion, lastRollAt: r.at, lastKind: why, history },
      })
      return { ok: true, ...r, reason: why, mood: effectiveMood(cfg.mood) }
    },
    dicePct: () => diceWeights(cfg).pct,
    // 这一轮想不想投：自我裁量开着的时候会给出理由，面板直接显示
    diceAppetite: () => {
      const ap = diceAppetite(cfg, Date.now())
      return { ok: true, want: ap.want, why: ap.why, selfPaced: Boolean(cfg.dice.selfPaced) }
    },
    autoMemoryNow: () => startAutoMemory(ctx),
    // 档位：手动查 / 手动归档一次 / 记忆体检
    tiersNow: () => {
      const rows = readMemories()
      return { ok: true, tiers: tierCounts(rows, cfg, Date.now()), total: rows.length }
    },
    decayNow: () => {
      const r = decayMemories(cfg)
      save({ memory: { tiers: { lastAt: Date.now() } } })
      return r
    },
    health: () => memoryHealth(cfg),
    // 改错：改一条记忆会先把原样留进 revisions，还能还原回去
    editMemory: (input) => editMemory(input),
    revisions: (id) => ({ ok: true, rows: readRevisions(id) }),
    restoreRevision: (revId) => restoreRevision(revId),
    // 快照：立刻备份一次 / 看看有哪些备份
    backupNow: () => snapshotNow(cfg),
    backups: () => ({ ok: true, dir: BACKUP_DIR, rows: listBackups() }),
    // 边线搭话：挑一条 / 清掉这条
    pickEdge: () => {
      const r = pickEdge(cfg)
      if (r.ok) save({ memory: { edge: { lastAt: r.at, pendingId: r.item.id, pendingText: r.text, pendingAt: r.at } } })
      return r
    },
    clearEdge: () => {
      save({ memory: { edge: { pendingId: '', pendingText: '', pendingAt: 0 } } })
      return { ok: true }
    },
    // 画像层 / 事件线
    profile: () => refreshProfile(cfg),
    events: (limit) => ({ ok: true, rows: readEvents(limit) }),
    ingestNow: () => {
      const r = ingestAgents(ctx, true)
      return { ok: true, ...r, pendingChars: pendingText().length }
    },
    setTier: (id, tier) => {
      // 手动改档 = 直接改权重，档位自己会跟上
      const t = clampInt(tier, 1, 3, 2)
      const target = t === 1 ? 0.85 : t === 2 ? 0.55 : 0.25
      return setMemoryWeight(id, target)
    },
    // 模型自己调：改心情、挪好感
    feel: (input) => {
      const patch = {}
      const out = {}
      if (input && (input.emotion || input.intensity != null)) {
        const emotion = normalizeEmotion((input && input.emotion) || cfg.mood.emotion)
        const intensity = clamp01(input && (input.intensity != null ? input.intensity : cfg.mood.intensity), 0.5)
        const at = Date.now()
        patch.mood = { emotion, intensity, updatedAt: at }
        // 手动调心情也要留痕：不然面板分不清这次心情是摇出来的还是自己调的
        patch.dice = {
          ...(cfg.dice || {}),
          lastEmotion: emotion,
          lastRollAt: at,
          lastKind: 'feeling',
          history: [
            ...((cfg.dice && Array.isArray(cfg.dice.history)) ? cfg.dice.history : []),
            { at, roll: 0, emotion, intensity, reason: 'feeling' },
          ].slice(-12),
        }
      }
      if (input && input.affinityDelta != null) {
        const cur = effectiveAffinity(cfg.affinity).value
        patch.affinity = {
          value: Math.min(100, Math.max(0, Math.round(cur + Number(input.affinityDelta)))),
          updatedAt: Date.now(),
        }
      }
      if (!patch.mood && !patch.affinity) return { ok: false, error: '没给 emotion / intensity / affinityDelta' }
      save(patch)
      out.ok = true
      out.mood = effectiveMood(cfg.mood)
      out.affinity = effectiveAffinity(cfg.affinity)
      return out
    },
    // ── 人设库：默认那套在 kernel 里，这里管另外几套，以及「哪个会话用哪套」──
    personas: () => ({
      ok: true,
      activeId: cfg.personas.activeId,
      activeName: (personaById(cfg, cfg.personas.activeId) || {}).name || kernelNameOf(cfg),
      kernelName: kernelNameOf(cfg),
      boundSessions: Object.keys(cfg.personas.bySession || {}).length,
      kernelChars: kernelCharsOf(cfg),
      list: cfg.personas.list.map((p) => ({
        id: p.id,
        name: p.name,
        chars: composeSectionsText(p.sections).length,
        blocks: p.sections.length,
      })),
    }),
    // 会话清单 + 每个会话现在挂的是哪套（面板拿来做「绑到某个对话」）
    sessions: (input) => {
      const want = Number((input && input.limit) || 12)
      const limit = Math.min(Math.max(Number.isFinite(want) ? want : 12, 1), 30)
      const bound = cfg.personas.bySession || {}
      const scan = listSessions(limit, archivedSessionIds(), workspaceSessionIds())
      const items = scan.rows.map((r) => ({
        sid: r.sid,
        title: r.title || (r.cwd ? path.basename(r.cwd) : '') || '未命名对话',
        cwd: r.cwd ? path.basename(r.cwd) : '',
        at: r.at,
        ago: agoText(r.at),
        personaId: bound[r.sid] || '',
        personaName: personaForSession(cfg, r.sid).name,
      }))
      return {
        ok: true,
        items,
        archived: scan.hidden,
        outside: scan.outside,
        boundSessions: Object.keys(bound).length,
        defaultName: kernelNameOf(cfg),
      }
    },
    // 面板要编辑某套时按需取它的板块正文（默认那套走 /status 的 kernel）
    personaOf: (id) => {
      const row = personaById(cfg, id)
      if (!row) return { ok: true, id: '', name: kernelNameOf(cfg), sections: (cfg.kernel && cfg.kernel.sections) || [], chars: kernelCharsOf(cfg) }
      return { ok: true, id: row.id, name: row.name, sections: row.sections, chars: composeSectionsText(row.sections).length }
    },
    currentPersona: (sid) => {
      const p = personaForSession(cfg, sid)
      return { ok: true, id: p.id, name: p.name, chars: composeSectionsText(p.sections).length, defaultId: cfg.personas.activeId }
    },
    // 只影响这一个会话：id 空 = 换回默认
    usePersona: (input) => {
      const sid = String((input && input.sid) || '').slice(0, 80)
      if (!sid) return { ok: false, error: '没有会话 id' }
      const key = String((input && (input.id || input.name)) || '').trim()
      const row = personaById(cfg, key) || (key ? (cfg.personas.list || []).find((p) => p.name === key) : null)
      if (key && !row) return { ok: false, error: '没找到这套人设：' + key }
      const bySession = { ...cfg.personas.bySession }
      if (row) bySession[sid] = row.id
      else delete bySession[sid]
      save({ personas: { bySession } })
      const p = personaForSession(cfg, sid)
      return { ok: true, id: p.id, name: p.name }
    },
    setPersona: (input) => {
      const action = String((input && input.action) || '').trim()
      const id = String((input && input.id) || '').trim().slice(0, 24)
      const name = String((input && input.name) || '').trim().slice(0, PERSONA_NAME_MAX)
      const listNow = () => cfg.personas.list.slice()
      if (action === 'create') {
        if (cfg.personas.list.length >= PERSONA_MAX) return { ok: false, error: '人设最多 ' + PERSONA_MAX + ' 套' }
        const src = personaById(cfg, id)
        const base = src ? src.sections : (cfg.kernel && cfg.kernel.sections) || []
        const sections = normalizeKernel({ sections: base.map((s) => ({ ...s })) }).sections
        const nextId = 'p' + Date.now().toString(36)
        const next = listNow()
        const nextName = name || '人设 ' + (next.length + 1)
        next.push({ id: nextId, name: nextName, sections })
        save({ personas: { list: next } })
        return { ok: true, id: nextId, name: nextName }
      }
      // 绑到某个会话：id 空 = 解绑，回到「新会话默认」那套。
      // 放在 row 判空之前，因为解绑时 id 本来就是空的。
      if (action === 'bind') {
        const sid = String((input && input.sid) || '').trim().slice(0, 80)
        if (!sid) return { ok: false, error: '没有会话 id' }
        const target = id ? personaById(cfg, id) : null
        if (id && !target) return { ok: false, error: '没有这套人设' }
        const bySession = { ...cfg.personas.bySession }
        if (target) bySession[sid] = target.id
        else delete bySession[sid]
        trimPersonaBindings({ bySession })
        saveBindings(bySession)
        const p = personaForSession(cfg, sid)
        return { ok: true, sid, id: p.id, name: p.name }
      }
      const row = personaById(cfg, id)
      if (!row) return { ok: false, error: '没有这套人设' }
      if (action === 'save') {
        const incoming = Array.isArray(input.sections) ? input.sections : row.sections
        if (incoming.length > 20) return { ok: false, error: '板块最多 20 个' }
        for (const s of incoming) {
          if (isPlainObject(s) && typeof s.text === 'string' && s.text.length > 4000) return { ok: false, error: '单个板块太长（上限 4000 字符）' }
        }
        const sections = normalizeKernel({ sections: incoming }).sections
        const nextName = name || row.name
        save({ personas: { list: listNow().map((p) => (p.id === id ? { id: p.id, name: nextName, sections } : p)) } })
        return { ok: true, id, name: nextName, chars: composeSectionsText(sections).length }
      }
      if (action === 'rename') {
        if (!name) return { ok: false, error: '名字不能空' }
        save({ personas: { list: listNow().map((p) => (p.id === id ? { ...p, name } : p)) } })
        return { ok: true, id, name }
      }
      if (action === 'delete') {
        const bySession = { ...cfg.personas.bySession }
        for (const k of Object.keys(bySession)) if (bySession[k] === id) delete bySession[k]
        const activeId = cfg.personas.activeId === id ? '' : cfg.personas.activeId
        save({ personas: { list: listNow().filter((p) => p.id !== id), activeId } })
        saveBindings(bySession)
        return { ok: true, deleted: id }
      }
      if (action === 'default') {
        save({ personas: { activeId: cfg.personas.list.some((p) => p.id === id) ? id : '' } })
        return { ok: true, activeId: cfg.personas.activeId }
      }
      if (action === 'unbind') {
        const sid = String((input && input.sid) || '').slice(0, 80)
        const bySession = { ...cfg.personas.bySession }
        delete bySession[sid]
        saveBindings(bySession)
        return { ok: true }
      }
      return { ok: false, error: 'action 只能是 create / save / rename / delete / default / bind / unbind' }
    },
    diaryNow: () => startDiary(ctx),
    reviewNow: () => startReview(ctx),
    // 导出：把设置/记忆/日记打成一包，面板直接下载成 .json
    exportData: () => {
      const at = Date.now()
      const data = exportBundle(cfg)
      save({ sync: { lastExportAt: at } })
      return { ok: true, file: exportFileName(at), data }
    },
    // 导入：merge 只补新条目（同文本/同 id 跳过），replace 整份覆盖
    importData: (input) => {
      const data = input && input.data
      if (!isPlainObject(data) || data.format !== EXPORT_FORMAT) {
        return { ok: false, error: '不是鲸核导出的文件（缺 format 标记）' }
      }
      const mode = input.mode === 'replace' ? 'replace' : 'merge'
      const out = {
        ok: true,
        mode,
        settings: false,
        memory: { added: 0, skipped: 0 },
        journal: { added: 0, skipped: 0 },
        total: { memory: 0, journal: 0 },
      }
      if (isPlainObject(data.settings)) {
        if (mode === 'replace') {
          cfg = normalizeCfg(data.settings)
          writeJson(CFG_PATH, cfg)
        } else {
          save(data.settings)
        }
        out.settings = true
      }
      // 记忆
      const cur = readMemories()
      const incoming = Array.isArray(data.memory) ? data.memory : []
      let rows
      if (mode === 'replace') {
        rows = incoming.map(importMemoryRow).filter(Boolean)
        out.memory.added = rows.length
      } else {
        rows = cur.slice()
        const seen = new Map(rows.map((m) => [normalizeMemText(m.text), m]))
        const ids = new Set(rows.map((m) => m.id))
        for (const raw of incoming) {
          const row = importMemoryRow(raw)
          if (!row) continue
          const key = normalizeMemText(row.text)
          if (seen.has(key)) {
            out.memory.skipped += 1
            continue
          }
          if (ids.has(row.id)) row.id = 'i' + Math.random().toString(36).slice(2, 9)
          seen.set(key, row)
          ids.add(row.id)
          rows.push(row)
          out.memory.added += 1
        }
      }
      rows.sort((a, b) => (a.t || 0) - (b.t || 0))
      if (rows.length > MEMORY_KEEP) rows = rows.slice(rows.length - MEMORY_KEEP)
      saveMemories(rows)
      out.total.memory = rows.length
      // 日记与复盘
      const curJ = readJournal()
      const incomingJ = Array.isArray(data.journal) ? data.journal : []
      let rowsJ
      if (mode === 'replace') {
        rowsJ = incomingJ.map(importJournalRow).filter(Boolean)
        out.journal.added = rowsJ.length
      } else {
        rowsJ = curJ.slice()
        const ids = new Set(rowsJ.map((j) => j.id))
        for (const raw of incomingJ) {
          const row = importJournalRow(raw)
          if (!row) continue
          if (ids.has(row.id)) {
            out.journal.skipped += 1
            continue
          }
          ids.add(row.id)
          rowsJ.push(row)
          out.journal.added += 1
        }
      }
      rowsJ.sort((a, b) => (a.t || 0) - (b.t || 0))
      if (rowsJ.length > JOURNAL_KEEP) rowsJ = rowsJ.slice(rowsJ.length - JOURNAL_KEEP)
      writeJsonl(JOUR_PATH, rowsJ)
      out.total.journal = rowsJ.length
      save({ sync: { lastImportAt: Date.now() } })
      return out
    },
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/whale-core/api',
        // 兜一层：处理函数抛错也必须回一个响应，别让连接悬着把前端拖死
        handler: (req, res) => {
          Promise.resolve()
            .then(() => handleApi(req, res, api))
            .catch((e) => {
              try {
                sendJson(res, { ok: false, error: String((e && e.message) || e).slice(0, 300) }, 500)
              } catch {}
            })
        },
      }),
    'whale-core: api',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/whale-core/status',
        handler: (req, res) => {
          try {
            sendJson(res, statusPayload(cfg, bindings.size))
          } catch (e) {
            try {
              sendJson(res, { ok: false, error: String((e && e.message) || e).slice(0, 300) }, 500)
            } catch {}
          }
        },
      }),
    'whale-core: status',
  )
}

/* ── 状态与 HTTP ────────────────────────────────────────────────────────── */

function statusPayload(cfg, bound) {
  const mems = readMemories()
  const journal = readJournal()
  const now = Date.now()
  const diary = journal.filter((j) => j.kind === 'diary')
  const reviews = journal.filter((j) => j.kind === 'review')
  const d = cfg.memory.diary
  const r = cfg.memory.review
  const tiers = cfg.memory.tiers
  return {
    ok: true,
    plugin: 'whale-core',
    version: PLUGIN_VERSION,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    enabled: Boolean(cfg.enabled),
    // 人设内核按板块给：面板一块一张卡，单独改、单独关
    kernel: {
      name: kernelNameOf(cfg),
      sections: (cfg.kernel.sections || []).map((s) => ({ id: s.id, label: s.label, text: s.text, enabled: s.enabled !== false })),
      text: composeKernelText(cfg),
      chars: kernelCharsOf(cfg),
    },
    kernelChars: kernelCharsOf(cfg),
    // 人设库：默认那套在 kernel 里，这里只给名字和字数，正文走 /persona 按需拿
    personas: {
      activeId: cfg.personas.activeId,
      activeName: (personaById(cfg, cfg.personas.activeId) || {}).name || kernelNameOf(cfg),
      kernelName: kernelNameOf(cfg),
      boundSessions: Object.keys(cfg.personas.bySession || {}).length,
      list: cfg.personas.list.map((p) => ({
        id: p.id,
        name: p.name,
        chars: composeSectionsText(p.sections).length,
        blocks: p.sections.length,
      })),
    },
    mood: { ...effectiveMood(cfg.mood), styles: cfg.mood.styles },
    // 表情包：开关 + 当前心情对应的 tag（面板照这个显示，不用自己猜）
    meme: {
      enabled: Boolean(cfg.meme.enabled),
      emotion: effectiveMood(cfg.mood).emotion,
      tag: memeTagOf(cfg),
      tags: Object.keys(MEME_TAG).map((k) => ({ emotion: k, tag: MEME_TAG[k] })),
    },
    affinity: {
      ...effectiveAffinity(cfg.affinity),
      auto: Boolean(cfg.affinity.auto),
      msgCount: cfg.affinity.msgCount,
      interest: cfg.affinity.interest,
      interestTarget: cfg.affinity.interestTarget,
      interestLevel: interestLevel(cfg.affinity.interest),
      autoInterest: Boolean(cfg.affinity.autoInterest),
      topicNote: cfg.affinity.topicNote,
      topics: cfg.affinity.topics,
      stages: AFF_STAGES.map((s) => ({ key: s.key, min: s.min, max: s.max, style: cfg.affinity.styles[s.key] })),
    },
    dice: {
      enabled: Boolean(cfg.dice.enabled),
      selfPaced: Boolean(cfg.dice.selfPaced),
      appetite: diceAppetite(cfg, now),
      skipped: cfg.dice.skipped,
      lastSkipAt: cfg.dice.lastSkipAt,
      skipReason: cfg.dice.skipReason,
      everyMinutes: cfg.dice.everyMinutes,
      sides: cfg.dice.sides,
      lastAt: cfg.dice.lastAt,
      nextAt: cfg.dice.lastAt ? cfg.dice.lastAt + cfg.dice.everyMinutes * 60000 : 0,
      lastRoll: cfg.dice.lastRoll,
      lastEmotion: cfg.dice.lastEmotion,
      lastRollAt: cfg.dice.lastRollAt,
      lastKind: cfg.dice.lastKind,
      pct: diceWeights(cfg).pct,
      history: cfg.dice.history,
    },
    memory: {
      enabled: Boolean(cfg.memory.enabled),
      count: mems.length,
      facts: mems.filter((m) => m.kind === 'fact').length,
      events: mems.filter((m) => m.kind === 'event').length,
      work: mems.filter((m) => m.lane === 'work').length,
      chat: mems.filter((m) => m.lane !== 'work').length,
      injectMax: cfg.memory.injectMax,
      maxChars: cfg.memory.maxChars,
      freshHalfLifeDays: cfg.memory.freshHalfLifeDays,
      weights: cfg.memory.weights,
      auto: {
        enabled: Boolean(cfg.memory.auto.enabled),
        everyTurns: cfg.memory.auto.everyTurns,
        lastAt: cfg.memory.auto.lastAt,
      },
      // 三档：一档底线、二档常用、三档杂记
      tiers: {
        enabled: Boolean(tiers.enabled),
        everyHours: tiers.everyHours,
        staleDays: tiers.staleDays,
        drop: tiers.drop,
        lastAt: tiers.lastAt,
        ...tierCounts(mems, cfg, Date.now()),
        labels: TIER_LABELS,
      },
      diaryCount: diary.length,
      reviewCount: reviews.length,
      diary: {
        enabled: Boolean(d.enabled),
        everyMinutes: d.everyMinutes,
        lastAt: d.lastAt,
        nextAt: d.lastAt ? d.lastAt + d.everyMinutes * 60000 : 0,
      },
      review: {
        enabled: Boolean(r.enabled),
        everyDays: r.everyDays,
        lastAt: r.lastAt,
        nextAt: r.lastAt ? r.lastAt + r.everyDays * 86400000 : 0,
      },
      recent: mems
        .slice(-8)
        .reverse()
        .map((m) => ({
          id: m.id,
          t: m.t,
          kind: m.kind,
          lane: m.lane,
          tier: m.tier,
          tierLabel: TIER_LABELS[m.tier] || '二档',
          text: m.text,
          weight: m.weight,
          tags: m.tags,
          hits: m.hits,
          lastHit: m.lastHit,
          retention: Number(retentionOf(m, now).toFixed(3)),
          stability: m.s,
          edits: Number(m.edits) || 0,
        })),
      // 边线搭话：快忘的那层，加上这会儿挑出来的一条
      edge: {
        enabled: Boolean(cfg.memory.edge.enabled),
        everyDays: cfg.memory.edge.everyDays,
        lastAt: cfg.memory.edge.lastAt,
        pendingId: cfg.memory.edge.pendingId,
        pendingText: cfg.memory.edge.pendingText,
        pendingAt: cfg.memory.edge.pendingAt,
        count: mems.filter((m) => isEdgeMemory(m, now)).length,
      },
      // 自主整理与压缩抢救：事件线收了多少、缓冲里还有多少字
      ingest: {
        enabled: Boolean(cfg.memory.ingest.enabled),
        everyTurns: cfg.memory.ingest.everyTurns,
        lastAt: cfg.memory.ingest.lastAt,
        eventCount: readEvents(2000).length,
        pendingChars: pendingText().length,
      },
      profile: readProfile(),
      revisions: readRevisions().length,
      lastDiary: diary.length ? short(diary[diary.length - 1].text, 200) : '',
      lastReview: reviews.length ? short(reviews[reviews.length - 1].text, 300) : '',
    },
    boundAgents: bound,
    store: STORE,
    // 导出/导入：面板上显示上次搬家的时间，顺带告诉一眼文件在哪
    sync: {
      lastExportAt: cfg.sync.lastExportAt,
      lastImportAt: cfg.sync.lastImportAt,
      lastBackupAt: cfg.sync.lastBackupAt,
      backupAttemptAt: cfg.sync.backupAttemptAt,
      backupEveryHours: cfg.sync.backupEveryHours,
      keepBackups: cfg.sync.keepBackups,
      backups: listBackups(),
      dir: BACKUP_DIR,
      fileHint: 'whale-core-日期-时间.json',
      format: EXPORT_FORMAT,
      pluginVersion: PLUGIN_VERSION,
      // GitHub 同步：token 不给前端，只告诉有没有填过
      gh: {
        repo: cfg.sync.repo || '',
        branch: cfg.sync.branch || 'main',
        hasToken: Boolean(cfg.sync.token),
        deviceId: ghsync.deviceInfo(STORE).id,
        deviceName: ghsync.deviceInfo(STORE).name,
        lastUploadAt: cfg.sync.lastUploadAt || 0,
        lastPullAt: cfg.sync.lastPullAt || 0,
        lastError: cfg.sync.lastError || '',
        mergeOnBoot: Boolean(cfg.sync.mergeOnBoot),
        autoUploadMinutes: cfg.sync.autoUploadMinutes || 0,
        autoMergeMinutes: cfg.sync.autoMergeMinutes || 0,
        lastMergeAt: cfg.sync.lastMergeAt || 0,
        lastMergeAdded: cfg.sync.lastMergeAdded || 0,
        lastErrorAt: cfg.sync.lastErrorAt || 0,
      },
    },
  }
}

function sendJson(res, payload, code = 200) {
  try {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(payload))
  } catch {}
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve({ ok: false, error: 'body too large' })
        try {
          req.destroy()
        } catch {}
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({ ok: true, value: {} })
      try {
        resolve({ ok: true, value: JSON.parse(text) })
      } catch {
        resolve({ ok: false, error: 'invalid json' })
      }
    })
    req.on('error', () => resolve({ ok: false, error: 'read error' }))
  })
}

function settingsPatch(input) {
  const patch = {}
  if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
  // GitHub 同步：仓库地址 / token / 分支
  if (isPlainObject(input.sync)) {
    const s = input.sync
    const next = {}
    if (typeof s.repo === 'string') next.repo = s.repo.trim().slice(0, 120)
    if (typeof s.token === 'string') next.token = s.token.trim().slice(0, 200)
    if (typeof s.branch === 'string') next.branch = s.branch.trim().slice(0, 60) || 'main'
    if (typeof s.mergeOnBoot === 'boolean') next.mergeOnBoot = s.mergeOnBoot
    if (s.autoUploadMinutes !== undefined) next.autoUploadMinutes = clampInt(s.autoUploadMinutes, 0, 1440, 0)
    if (s.autoMergeMinutes !== undefined) next.autoMergeMinutes = clampInt(s.autoMergeMinutes, 0, 1440, 0)
    if (Object.keys(next).length) patch.sync = next
  }
  if (typeof input.kernel === 'string') {
    if (input.kernel.length > 8000) return { error: 'kernel 太长（上限 8000 字符）' }
    // 老接口：整段文字进来，按小标题拆成板块
    patch.kernel = { sections: parseKernelSections(input.kernel) }
  } else if (isPlainObject(input.kernel)) {
    const k = input.kernel
    const next = {}
    // 只改名也行：{ kernel: { name } }，别的字段不动
    if (typeof k.name === 'string') {
      const n = k.name.trim().slice(0, KERNEL_NAME_MAX)
      if (!n) return { error: '名字不能空' }
      next.name = n
    }
    if (Array.isArray(k.sections)) {
      if (k.sections.length > 20) return { error: '板块最多 20 个' }
      const rows = []
      for (const row of k.sections) {
        if (!isPlainObject(row)) continue
        const text = typeof row.text === 'string' ? row.text : ''
        if (text.length > 4000) return { error: '单个板块太长（上限 4000 字符）' }
        rows.push({
          id: typeof row.id === 'string' ? row.id.slice(0, 24) : 's' + (rows.length + 1),
          label: typeof row.label === 'string' && row.label.trim() ? row.label.trim().slice(0, 20) : '自定义',
          text,
          enabled: row.enabled !== false,
        })
      }
      next.sections = rows
    }
    if (Object.keys(next).length) patch.kernel = next
  }
  if (isPlainObject(input.meme)) {
    patch.meme = {}
    if (typeof input.meme.enabled === 'boolean') patch.meme.enabled = input.meme.enabled
  }
  if (isPlainObject(input.memory)) {
    const m = input.memory
    const next = {}
    if (typeof m.enabled === 'boolean') next.enabled = m.enabled
    if (m.injectMax !== undefined) next.injectMax = m.injectMax
    if (m.maxChars !== undefined) next.maxChars = m.maxChars
    if (m.freshHalfLifeDays !== undefined) next.freshHalfLifeDays = m.freshHalfLifeDays
    if (isPlainObject(m.weights)) next.weights = m.weights
    if (isPlainObject(m.diary)) {
      next.diary = {}
      if (typeof m.diary.enabled === 'boolean') next.diary.enabled = m.diary.enabled
      if (m.diary.everyMinutes !== undefined) next.diary.everyMinutes = m.diary.everyMinutes
      // 改完间隔后把计时归零，免得「刚好早就该写了」立刻触发一次
      if (m.diary.everyMinutes !== undefined) next.diary.lastAt = Date.now()
      if (m.diary.lastAt !== undefined) next.diary.lastAt = m.diary.lastAt
    }
    if (isPlainObject(m.auto)) {
      next.auto = {}
      if (typeof m.auto.enabled === 'boolean') next.auto.enabled = m.auto.enabled
      if (m.auto.everyTurns !== undefined) next.auto.everyTurns = m.auto.everyTurns
      if (m.auto.lastAt !== undefined) next.auto.lastAt = m.auto.lastAt
    }
    if (isPlainObject(m.review)) {
      next.review = {}
      if (typeof m.review.enabled === 'boolean') next.review.enabled = m.review.enabled
      if (m.review.everyDays !== undefined) next.review.everyDays = m.review.everyDays
      if (m.review.lastAt !== undefined) next.review.lastAt = m.review.lastAt
    }
    if (isPlainObject(m.tiers)) {
      next.tiers = {}
      if (typeof m.tiers.enabled === 'boolean') next.tiers.enabled = m.tiers.enabled
      if (m.tiers.everyHours !== undefined) next.tiers.everyHours = m.tiers.everyHours
      if (m.tiers.staleDays !== undefined) next.tiers.staleDays = m.tiers.staleDays
      if (m.tiers.drop !== undefined) next.tiers.drop = m.tiers.drop
      if (m.tiers.lastAt !== undefined) next.tiers.lastAt = m.tiers.lastAt
    }
    if (isPlainObject(m.edge)) {
      next.edge = {}
      if (typeof m.edge.enabled === 'boolean') next.edge.enabled = m.edge.enabled
      if (m.edge.everyDays !== undefined) {
        next.edge.everyDays = m.edge.everyDays
        // 改间隔 = 重新开始计时
        next.edge.lastAt = Date.now()
      }
      if (m.edge.lastAt !== undefined) next.edge.lastAt = m.edge.lastAt
      if (typeof m.edge.pendingId === 'string') next.edge.pendingId = m.edge.pendingId
      if (typeof m.edge.pendingText === 'string') next.edge.pendingText = m.edge.pendingText
    }
    if (isPlainObject(m.ingest)) {
      next.ingest = {}
      if (typeof m.ingest.enabled === 'boolean') next.ingest.enabled = m.ingest.enabled
      if (m.ingest.everyTurns !== undefined) next.ingest.everyTurns = m.ingest.everyTurns
      if (m.ingest.lastAt !== undefined) next.ingest.lastAt = m.ingest.lastAt
    }
    if (isPlainObject(m.merge)) {
      next.merge = {}
      if (typeof m.merge.enabled === 'boolean') next.merge.enabled = m.merge.enabled
      if (typeof m.merge.askModel === 'boolean') next.merge.askModel = m.merge.askModel
      if (m.merge.threshold !== undefined) next.merge.threshold = m.merge.threshold
    }
    if (isPlainObject(m.vector)) {
      next.vector = {}
      if (typeof m.vector.enabled === 'boolean') next.vector.enabled = m.vector.enabled
      if (typeof m.vector.endpoint === 'string') next.vector.endpoint = m.vector.endpoint
      if (typeof m.vector.model === 'string') next.vector.model = m.vector.model
      if (m.vector.timeoutMs !== undefined) next.vector.timeoutMs = m.vector.timeoutMs
      if (m.vector.weight !== undefined) next.vector.weight = m.vector.weight
    }
    if (isPlainObject(m.hot)) {
      next.hot = {}
      if (m.hot.minWeight !== undefined) next.hot.minWeight = m.hot.minWeight
      if (m.hot.freshDays !== undefined) next.hot.freshDays = m.hot.freshDays
    }
    if (isPlainObject(m.diaryChannel)) {
      next.diaryChannel = {}
      if (typeof m.diaryChannel.enabled === 'boolean') next.diaryChannel.enabled = m.diaryChannel.enabled
      if (m.diaryChannel.maxChars !== undefined) next.diaryChannel.maxChars = m.diaryChannel.maxChars
    }
    patch.memory = next
  }
  if (isPlainObject(input.sync)) {
    const s = input.sync
    // 注意：这里必须合并到已有的 patch.sync，不能直接覆盖——上面已经处理过 repo/token/branch，
    // 之前用 patch.sync = next 会把那三个字段整块丢掉（面板保存后仓库地址和 token 变空白的元凶）
    const next = { ...(patch.sync || {}) }
    if (s.backupEveryHours !== undefined) {
      next.backupEveryHours = s.backupEveryHours
      next.lastBackupAt = Date.now()
    }
    if (s.keepBackups !== undefined) next.keepBackups = s.keepBackups
    if (s.lastBackupAt !== undefined) next.lastBackupAt = s.lastBackupAt
    if (Object.keys(next).length) patch.sync = next
  }
  if (isPlainObject(input.events)) {
    const e = input.events
    const next = {}
    if (e.keepDays !== undefined) next.keepDays = e.keepDays
    patch.events = next
  }
  if (isPlainObject(input.dice)) {
    const d = input.dice
    const next = {}
    if (typeof d.enabled === 'boolean') next.enabled = d.enabled
    if (typeof d.selfPaced === 'boolean') next.selfPaced = d.selfPaced
    if (d.everyMinutes !== undefined) {
      next.everyMinutes = d.everyMinutes
      // 改间隔就等于重新开始计时，不然「早就该掷了」会立刻连掷
      next.lastAt = Date.now()
    }
    if (d.sides !== undefined) next.sides = d.sides
    if (d.lastAt !== undefined) next.lastAt = d.lastAt
    patch.dice = next
  }
  if (isPlainObject(input.affinity)) {
    const a = input.affinity
    const next = {}
    if (typeof a.auto === 'boolean') next.auto = a.auto
    if (typeof a.autoInterest === 'boolean') next.autoInterest = a.autoInterest
    if (a.interest !== undefined) next.interest = a.interest
    if (a.interestTarget !== undefined) next.interestTarget = a.interestTarget
    if (typeof a.topicNote === 'string') next.topicNote = a.topicNote
    if (Array.isArray(a.topics)) next.topics = a.topics
    patch.affinity = next
  }
  if (!Object.keys(patch).length) return { error: '没有可写入的字段' }
  return { patch }
}

// GitHub 同步参数：请求里带了就用请求的，没带就用已存的
function syncArgs(input = {}, cfg = {}) {
  const pick = (key) => {
    const v = input && input[key]
    return typeof v === 'string' && v.trim() ? v.trim() : ''
  }
  const repo = pick('repo') || String((cfg.sync && cfg.sync.repo) || '').trim()
  const token = pick('token') || String((cfg.sync && cfg.sync.token) || '').trim()
  const branch = pick('branch') || String((cfg.sync && cfg.sync.branch) || 'main').trim() || 'main'
  return { repo, token, branch }
}

function syncFail(msg, saveFn) {
  const error = String((msg && msg.message) || msg || '').slice(0, 300)
  try {
    if (typeof saveFn === 'function') saveFn({ sync: { lastError: error, lastErrorAt: Date.now() } })
  } catch {}
  return { ok: false, error }
}

async function handleApi(req, res, api) {
  const url = new URL(req.url || '/', 'http://localhost')
  const sub = url.pathname.replace(/^\/whale-core\/api/, '') || '/'
  const method = (req.method || 'GET').toUpperCase()
  const cfg = api.syncCfg()

  if (method === 'GET' && (sub === '/' || sub === '/status')) return sendJson(res, api.status())

  if (method === 'GET' && sub === '/memory') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 40))
    const kind = url.searchParams.get('kind')
    const lane = url.searchParams.get('lane')
    const tier = Number(url.searchParams.get('tier')) || 0
    let all = api.memories()
    if (kind === 'fact' || kind === 'event') all = all.filter((m) => m.kind === kind)
    if (lane === 'work' || lane === 'chat') all = all.filter((m) => m.lane === lane)
    if (tier >= 1 && tier <= 3) all = all.filter((m) => m.tier === tier)
    return sendJson(res, { ok: true, total: all.length, items: all.slice(-limit).reverse() })
  }

  if (method === 'GET' && sub === '/memory/health') return sendJson(res, api.health())
  if (method === 'GET' && sub === '/memory/trash') return sendJson(res, { ok: true, items: api.trash() })

  // 别的设备同步过来的聊天日志（只读）
  if (method === 'GET' && sub === '/chat') {
    const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 300))
    return sendJson(res, { ok: true, items: api.chatLogs(limit) })
  }

  // 存储体检：哪些文件里有解析不了的行（崩溃留下的半行）
  if (method === 'GET' && sub === '/store') return sendJson(res, api.scanStore())
  if (method === 'POST' && (sub === '/store/repair' || sub === '/repair')) return sendJson(res, api.repairStore())

  if (method === 'GET' && sub === '/revisions') {
    return sendJson(res, api.revisions(url.searchParams.get('of') || ''))
  }

  if (method === 'GET' && sub === '/backups') return sendJson(res, api.backups())

  // GitHub 同步：当前配置与上次结果（token 只回「有没有」，不回内容）
  if (method === 'GET' && (sub === '/sync' || sub === '/sync/status')) {
    return sendJson(res, { ok: true, sync: api.status().sync })
  }

  if (method === 'GET' && sub === '/events') {
    return sendJson(res, api.events(Number(url.searchParams.get('limit')) || 60))
  }

  if (method === 'GET' && sub === '/profile') return sendJson(res, { ok: true, profile: api.profile() })

  if (method === 'GET' && sub === '/journal') {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20))
    const all = api.journal()
    return sendJson(res, { ok: true, total: all.length, items: all.slice(-limit).reverse() })
  }

  if (method === 'GET' && sub === '/recall') {
    const q = url.searchParams.get('q') || ''
    return sendJson(res, { ok: true, trace: api.recallOf(q) })
  }

  if (method === 'GET' && sub === '/recall/last') return sendJson(res, { ok: true, trace: api.lastRecall() })

  // 人设库：列表只给名字和字数，正文按 id 单独取（免得 status 里塞几百 KB）
  if (method === 'GET' && sub === '/personas') return sendJson(res, api.personas())
  if (method === 'GET' && sub === '/persona') return sendJson(res, api.personaOf(url.searchParams.get('id') || ''))
  // 会话清单：面板的「会话绑定」卡用，limit 控制返回几条
  if (method === 'GET' && sub === '/sessions') return sendJson(res, api.sessions({ limit: Number(url.searchParams.get('limit') || 12) }))

  // 导出：直接当附件下载，浏览器点了就存到下载目录
  if (method === 'GET' && sub === '/export') {
    const r = api.exportData()
    const body = JSON.stringify(r.data)
    try {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Content-Disposition', 'attachment; filename="' + r.file + '"')
      res.setHeader('Cache-Control', 'no-store')
      res.end(body)
    } catch {}
    return undefined
  }

  if (method === 'POST') {
    const body = await readBody(req)
    if (!body.ok) return sendJson(res, { ok: false, error: body.error }, 400)
    const input = body.value || {}

    if (sub === '/settings') {
      const r = settingsPatch(input)
      if (r.error) return sendJson(res, { ok: false, error: r.error }, 400)
      const next = api.save(r.patch)
      return sendJson(res, {
        ok: true,
        cfg: {
          enabled: next.enabled,
          kernel: next.kernel,
          mood: next.mood,
          affinity: next.affinity,
          memory: next.memory,
          dice: next.dice,
          meme: next.meme,
        },
      })
    }

    if (sub === '/memory') {
      const r = api.addMemory(input)
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, { ok: true, item: r.item, count: r.count, updated: Boolean(r.updated) })
    }

    if (sub === '/memory/weight') {
      const r = api.setWeight(String(input.id || ''), input.weight)
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, { ok: true, item: r.item })
    }

    if (sub === '/memory/delete') {
      const r = api.deleteMemory(String(input.id || ''))
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, { ok: true, count: r.count })
    }

    if (sub === '/memory/decay') return sendJson(res, api.decayNow())
    if (sub === '/memory/trash') return sendJson(res, { ok: true, items: api.trash() })
    if (sub === '/memory/restore') return sendJson(res, api.restoreMemory(String(input.id || '')))
    if (sub === '/memory/purge') {
      const r = api.purgeMemory(String(input.id || ''))
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, r)
    }
    if (sub === '/memory/purge-all') return sendJson(res, api.purgeTrash(input.ids))

    if (sub === '/memory/tier') {
      const r = api.setTier(String(input.id || ''), input.tier)
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, { ok: true, item: r.item })
    }

    if (sub === '/journal/delete') {
      const r = api.deleteJournal(String(input.id || ''))
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, { ok: true, count: r.count })
    }

    if (sub === '/mood') return sendJson(res, api.setMood(input))
    if (sub === '/affinity') return sendJson(res, api.setAffinity(input))
    if (sub === '/interest') return sendJson(res, api.setInterest(input))
    if (sub === '/style') return sendJson(res, api.setStyle(input))
    if (sub === '/feel') return sendJson(res, api.feel(input))
    if (sub === '/persona') {
      const r = api.setPersona(input)
      return sendJson(res, r, r.ok ? 200 : 400)
    }
    if (sub === '/dice/roll') return sendJson(res, api.rollDice({ reason: 'manual' }))

    if (sub === '/auto-memory') {
      const r = await withTimeout(api.autoMemoryNow(), 150000)
      return sendJson(res, r)
    }

    if (sub === '/memory/edit') {
      const r = api.editMemory(input)
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, { ok: true, item: r.item, revision: r.revision })
    }

    if (sub === '/memory/restore') {
      const r = api.restoreRevision(String(input.revision || input.id || ''))
      if (!r.ok) return sendJson(res, r, 400)
      return sendJson(res, { ok: true, item: r.item, revision: r.revision })
    }

    if (sub === '/backup/now') return sendJson(res, api.backupNow())
    if (sub === '/edge/pick') return sendJson(res, api.pickEdge())
    if (sub === '/edge/clear') return sendJson(res, api.clearEdge())
    if (sub === '/ingest') return sendJson(res, await withTimeout(api.ingestNow(), 30000))

    if (sub === '/import') return sendJson(res, api.importData(input))

    // ── GitHub 同步 ──
    if (sub === '/sync/config') {
      const r = settingsPatch({ sync: input })
      if (r.error) return sendJson(res, { ok: false, error: r.error }, 400)
      api.save(r.patch)
      return sendJson(res, { ok: true, sync: api.status().sync })
    }

    if (sub === '/sync/verify') {
      try {
        const out = await withTimeout(ghsync.verify(syncArgs(input, cfg)), 45000)
        if (out && out.ok === false) return sendJson(res, syncFail(out.error || out, api.save))
        return sendJson(res, out)
      } catch (e) {
        return sendJson(res, syncFail(e, api.save), 400)
      }
    }

    if (sub === '/sync/create-repo') {
      try {
        const out = await withTimeout(ghsync.createRepo(syncArgs(input, cfg)), 60000)
        if (out && out.ok === false) return sendJson(res, syncFail(out.error || out, api.save))
        if (out && out.repo) api.save({ sync: { repo: out.repo, lastError: '' } })
        return sendJson(res, out)
      } catch (e) {
        return sendJson(res, syncFail(e, api.save), 400)
      }
    }

    if (sub === '/sync/upload') {
      try {
        const out = await withTimeout(ghsync.upload(syncArgs(input, cfg), STORE), 120000)
        if (out && out.ok === false) return sendJson(res, syncFail(out.error || out, api.save))
        api.save({ sync: { lastUploadAt: Date.now(), lastError: '' } })
        return sendJson(res, out)
      } catch (e) {
        return sendJson(res, syncFail(e, api.save), 400)
      }
    }

    if (sub === '/sync/pull') {
      try {
        const out = await withTimeout(ghsync.pull(syncArgs(input, cfg), STORE), 120000)
        if (out && out.ok === false) return sendJson(res, syncFail(out.error || out, api.save))
        api.save({ sync: { lastPullAt: Date.now(), lastError: '' } })
        return sendJson(res, out)
      } catch (e) {
        return sendJson(res, syncFail(e, api.save), 400)
      }
    }

    // 合并：把仓库里其它设备的分片并进本地；默认只做预演（dryRun=true）
    if (sub === '/sync/merge') {
      try {
        const dryRun = input.dryRun !== false
        const out = await withTimeout(api.mergeSync(input, dryRun), 150000)
        if (!out || out.ok === false) return sendJson(res, syncFail((out && out.error) || out, api.save))
        // 真合并、或者预演下来一条都不用并，都算「这次合并跑过了」，记一次时间戳；
        // 只有「预演有新增、还没落地」不记，免得显示已合并其实没并。
        const added = (out.addMemory || 0) + (out.addJournal || 0)
        if (!dryRun || added === 0) {
          api.save({
            sync: {
              lastMergeAt: Date.now(),
              lastMergeAdded: added,
              lastError: '',
            },
          })
        }
        return sendJson(res, out)
      } catch (e) {
        return sendJson(res, syncFail(e, api.save), 400)
      }
    }

    if (sub === '/diary/now') {
      const r = await withTimeout(api.diaryNow(), 150000)
      return sendJson(res, r)
    }

    if (sub === '/review/now') {
      const r = await withTimeout(api.reviewNow(), 150000)
      return sendJson(res, r)
    }
  }

  return sendJson(res, { ok: false, error: 'not found' }, 404)
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch((err) => ({ ok: false, error: String((err && err.message) || err) })),
    new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: '超时了（模型还没回）' }), ms)
      if (typeof t.unref === 'function') t.unref()
    }),
  ])
}
