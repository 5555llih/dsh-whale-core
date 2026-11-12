import https from 'node:https'
import tls from 'node:tls'
/* ── GitHub 同步 ─────────────────────────────────────────────────────────────
 * 走 GitHub REST API 直接读写文件，不依赖 git 二进制。
 * 每台设备只写自己那一片 data/<deviceId>.json，落盘时按条目 id 合并，
 * 所以两台机器各写各的不会撞车；同一个仓库同时也是一份带历史的离线备份。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

const API = 'https://api.github.com'
const UA = 'dsh-whale-core-sync'
const SNAP_DIR = 'data'

function ghHeaders(token, extra) {
  return Object.assign(
    {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + token,
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
    },
    extra || {},
  )
}

/* 国内到 api.github.com 的连接偶尔会卡住十几秒甚至直接连不上，
 * 所以每次请求都带 25 秒超时，网络层错误重试两次（HTTP 错误码不重试）。 */
// 走系统证书库：本机装了 TLS 中间人（如 Steamcommunity_302 会劫持 github 域名）时，Node 自带 CA 不认它的根证书
let extraCACerts = null

// 本机装了 TLS 加速器时，它的根证书只在 Windows 用户证书库里，
// Node 的 system CA 读不到，于是允许从 <store>\sync\mitm-ca.pem 里补一份。
export function loadExtraCA(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'sync', 'mitm-ca.pem'), 'utf8')
    extraCACerts = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || null
  } catch {
    extraCACerts = null
  }
  return extraCACerts ? extraCACerts.length : 0
}

function systemCAs() {
  try {
    // 用 Node 自带的根证书打底（只有 system 库时链常常拼不全），再叠系统的和补的
    const bundled = Array.isArray(tls.rootCertificates) ? tls.rootCertificates.slice() : []
    let system = []
    try { system = tls.getCACertificates('system') || [] } catch {}
    const all = bundled.concat(system, extraCACerts || [])
    return all.length ? all : undefined
  } catch {
    return undefined
  }
}

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 6 })

// 最小 Response 形状：调用方只用 ok / status / text()
function ghRequest(url, init, signal) {
  return new Promise((resolve, reject) => {
    let u
    try { u = new URL(url) } catch (e) { reject(e); return }
    const opts = {
      method: ((init && init.method) || 'GET').toUpperCase(),
      headers: Object.assign({}, (init && init.headers) || {}),
      servername: u.hostname,
      ca: systemCAs(),
      agent: keepAliveAgent,
    }
    const req = https.request(u, opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        const code = res.statusCode || 0
        resolve({ ok: code >= 200 && code < 300, status: code, text: async () => body.toString('utf8') })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'))
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    }
    if (init && init.body) req.write(init.body)
    req.end()
  })
}

async function ghFetch(url, init, tries = 3) {
  let lastErr = null
  for (let i = 0; i < tries; i += 1) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 25000)
    try {
      return await ghRequest(url, init, ctrl.signal)
    } catch (err) {
      lastErr = err
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    } finally {
      clearTimeout(timer)
    }
  }
  const detail = (lastErr && (lastErr.cause && lastErr.cause.code || lastErr.code || lastErr.message)) || 'network error'
  const wrapped = new Error('连不上 GitHub（' + detail + '），稍后再试')
  wrapped.status = 0
  throw wrapped
}

async function gh(token, apiPath, init) {
  const res = await ghFetch(API + apiPath, Object.assign({}, init, { headers: ghHeaders(token, init && init.headers) }))
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || text.slice(0, 160) || 'HTTP ' + res.status
    const err = new Error('GitHub ' + res.status + '：' + msg)
    err.status = res.status
    throw err
  }
  return json
}

/* 设备 id：第一次用到时生成，之后固定。 */
export function deviceInfo(store) {
  const dir = path.join(store, 'sync')
  const file = path.join(dir, 'device.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && raw.id) {
      if (!raw.name) raw.name = '鲸核设备'
      return raw
    }
  } catch {}
  const id = 'dev-' + crypto.randomBytes(6).toString('hex')
  const info = { id, name: '鲸核设备', createdAt: Date.now() }
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(info, null, 2), 'utf8')
  } catch {}
  return info
}

export function renameDevice(store, name) {
  const info = deviceInfo(store)
  const next = Object.assign({}, info, { name: String(name || '').trim().slice(0, 40) || info.name })
  try {
    fs.writeFileSync(path.join(store, 'sync', 'device.json'), JSON.stringify(next, null, 2), 'utf8')
  } catch {}
  return next
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readJsonlFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const rows = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        rows.push(JSON.parse(t))
      } catch {}
    }
    return rows
  } catch {
    return []
  }
}

/* 事件线与 QQ 聊天日志也要带走：不然换台机器，记得的只是一句总结，
 * 当时的原话全在原来那台机器上。都取最近一截，别把仓库撑爆。 */
const EVENT_SYNC_MAX = 800
const CHAT_SYNC_FILES = 3
const CHAT_SYNC_LINES = 600

function tailJsonl(file, max) {
  const rows = readJsonlFile(file)
  return rows.length > max ? rows.slice(rows.length - max) : rows
}

// QQ 插件的日志按天写：<cwd>/logs/dsh-qq-YYYY-MM-DD.log。找几处可能的地方。
function chatLogDirs(store) {
  const cands = [
    path.join(store, '..', 'logs'),
    path.join(store, '..', 'dsh-qq', 'logs'),
    path.join(process.cwd(), 'logs'),
  ]
  return cands.filter((d, i) => cands.indexOf(d) === i)
}

export function readChatLogs(store) {
  const out = []
  for (const dir of chatLogDirs(store)) {
    let names = []
    try {
      names = fs.readdirSync(dir).filter((f) => /^dsh-qq-\d{4}-\d{2}-\d{2}\.log$/.test(f))
    } catch {
      continue
    }
    names.sort()
    for (const name of names.slice(-CHAT_SYNC_FILES)) {
      let lines = []
      try {
        lines = fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/).filter(Boolean)
      } catch {
        continue
      }
      out.push({ name, lines: lines.slice(-CHAT_SYNC_LINES) })
    }
  }
  return out
}

export function chatLogDir(store) {
  return chatLogDirs(store)[0]
}

/* ── 完整聊天记录（每一句） ────────────────────────────────────────
 * DSH 把会话写在 $DSH_HOME/sessions/<cwd>/<sessionId>/session.v4.jsonl.zstd，
 * 每行一个事件，多帧 zstd 顺序追加。这里逐帧解开、只取真正的对话：
 *   user/message        data.source.kind === 'user' 的才算「人说的」
 *   assistant/message   data.message.content 里 type==='text' 的部分（推理过程不要）
 * 工具调用/结果不入库，否则体积会翻好几倍。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const TRANSCRIPT_MSG_MAX = 8000
const TRANSCRIPT_TOTAL_MAX = 6000000

function zstdFrames(buf) {
  const starts = []
  let i = -1
  while ((i = buf.indexOf(ZSTD_MAGIC, i + 1)) !== -1) starts.push(i)
  if (!starts.length) return []
  const out = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)))
    } catch {}
  }
  return out
}

function clip(text) {
  const t = String(text == null ? '' : text)
  return t.length > TRANSCRIPT_MSG_MAX ? t.slice(0, TRANSCRIPT_MSG_MAX) + '…' : t
}

function textOf(content) {
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n')
  }
  return ''
}

function parseSessionFile(file) {
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return null
  }
  const frames = zstdFrames(buf)
  if (!frames.length) return null
  const rows = []
  for (const frame of frames) {
    for (const line of frame.toString('utf8').split('\n')) {
      if (!line) continue
      try {
        rows.push(JSON.parse(line))
      } catch {}
    }
  }
  const meta = rows.find((r) => r && r.type === 'session') || {}
  const messages = []
  for (const r of rows) {
    if (!r || !r.data) continue
    if (r.type === 'user/message') {
      if (!r.data.source || r.data.source.kind !== 'user') continue
      const text = textOf(r.data.content)
      if (text) messages.push({ role: 'user', at: r.time || 0, text: clip(text) })
    } else if (r.type === 'assistant/message') {
      const msg = r.data.message || {}
      const text = textOf(msg.content)
      if (text) messages.push({ role: 'assistant', at: r.time || 0, text: clip(text) })
    }
  }
  return {
    sessionId: meta.id || path.basename(path.dirname(file)),
    cwd: meta.cwd || '',
    startedAt: meta.createdAt || 0,
    messages,
  }
}

/* 读本机的全部会话，按时间从旧到新；超预算时先丢最旧的。 */
export function readTranscripts(store) {
  const root = path.join(path.dirname(store), 'sessions')
  let dirs = []
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
  const found = []
  for (const dir of dirs) {
    try {
      for (const sub of fs.readdirSync(path.join(root, dir))) {
        const file = path.join(root, dir, sub, 'session.v4.jsonl.zstd')
        if (fs.existsSync(file)) found.push(file)
      }
    } catch {}
  }
  const sessions = []
  for (const file of found) {
    const parsed = parseSessionFile(file)
    if (parsed && parsed.messages.length) sessions.push(parsed)
  }
  sessions.sort((a, b) => a.startedAt - b.startedAt)
  let total = 0
  const kept = []
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i]
    const size = s.messages.reduce((n, m) => n + m.text.length, 0)
    if (total + size > TRANSCRIPT_TOTAL_MAX && kept.length) break
    total += size
    kept.unshift(s)
  }
  return kept
}

/* 交接条：本机每十分钟把「刚才聊到哪」写成一行，随分片一起上传；
 * 另一台读到之后，在记忆块最前面接一句，别让两边像两个人。 */
const HANDOFF_MAX = 300

export function readHandoff(store, limit = 30) {
  const rows = readJsonlFile(path.join(store, 'sync', 'handoff.jsonl'))
  const n = Math.max(1, Math.min(200, Number(limit) || 30))
  return rows.slice(-n)
}

export function appendHandoff(store, entry) {
  const dir = path.join(store, 'sync')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  const file = path.join(dir, 'handoff.jsonl')
  const rows = readJsonlFile(file)
  rows.push(entry)
  const kept = rows.slice(-HANDOFF_MAX)
  try {
    fs.writeFileSync(file, kept.map((r) => JSON.stringify(r)).join('\n') + '\n')
  } catch {}
  return entry
}

/* 打包一份快照：设置（去掉 token）、人设、记忆分片、日记、事件线、QQ 聊天日志。 */
export function buildSnapshot(store, cfg) {
  const settings = readJsonFile(path.join(store, 'settings.json'), null)
  if (settings && settings.sync) {
    settings.sync = Object.assign({}, settings.sync)
    delete settings.sync.token
  }
  const memory = {}
  try {
    const dir = path.join(store, 'memory')
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue
      memory[f] = readJsonlFile(path.join(dir, f))
    }
  } catch {}
  const device = deviceInfo(store)
  return {
    format: 'dsh-whale-core-sync',
    version: 1,
    deviceId: device.id,
    deviceName: device.name,
    exportedAt: Date.now(),
    settings,
    profile: readJsonFile(path.join(store, 'profile.json'), null),
    memory,
    journal: readJsonlFile(path.join(store, 'journal.jsonl')),
    events: tailJsonl(path.join(store, 'events.jsonl'), EVENT_SYNC_MAX),
    chat: readChatLogs(store),
    transcripts: readTranscripts(store),
    handoff: readHandoff(store, 30),
  }
}

function splitRepo(repo) {
  const s = String(repo || '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(s)
  if (!m) return null
  return { owner: m[1], name: m[2] }
}

export function parseArgs(input) {
  const repo = splitRepo(input.repo)
  if (!repo) throw new Error('仓库要写成 用户名/仓库名，或者直接粘仓库链接')
  const token = String(input.token || '').trim()
  if (!token) throw new Error('还没有填 GitHub token')
  if (!/^(gh[pousr]_|github_pat_)/.test(token)) throw new Error('这不像 GitHub token（应以 ghp_ / github_pat_ 开头）')
  const branch = String(input.branch || 'main').trim() || 'main'
  return { repo: repo.owner + '/' + repo.name, token, branch }
}

export async function createRepo(input) {
  const token = String(input.token || '').trim()
  if (!token) throw new Error('还没有填 GitHub token')
  const name = String(input.name || 'whale-sync')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '-')
  const body = {
    name,
    private: true,
    auto_init: true,
    description: '鲸核数据同步（私有）',
  }
  const me = await gh(token, '/user', { method: 'GET' })
  let repo = null
  try {
    repo = await gh(token, '/user/repos', { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    // 已经建过了就当成功，直接把地址给它
    if (e.status === 422) {
      repo = await gh(token, '/repos/' + me.login + '/' + name, { method: 'GET' })
    } else {
      throw e
    }
  }
  return { owner: me.login, repo: me.login + '/' + repo.name, private: repo.private !== false, url: repo.html_url }
}

export async function upload(input, store) {
  const { repo, token, branch } = parseArgs(input)
  const snapshot = buildSnapshot(store, null)
  const body = JSON.stringify(snapshot)
  const file = SNAP_DIR + '/' + snapshot.deviceId + '.json'
  const content = Buffer.from(body, 'utf8').toString('base64')

  let sha = null
  try {
    const cur = await gh(token, '/repos/' + repo + '/contents/' + file + '?ref=' + encodeURIComponent(branch), { method: 'GET' })
    if (cur && cur.sha) sha = cur.sha
  } catch (e) {
    if (e.status !== 404) throw e
  }

  const payload = {
    message: '鲸核同步 ' + snapshot.deviceId + ' · ' + new Date().toISOString(),
    content,
  }
  if (sha) payload.sha = sha
  if (!sha) payload.branch = branch

  const res = await gh(token, '/repos/' + repo + '/contents/' + file, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
  return {
    ok: true,
    repo,
    branch,
    file,
    deviceId: snapshot.deviceId,
    bytes: Buffer.byteLength(body, 'utf8'),
    counts: {
      memory: Object.values(snapshot.memory).reduce((n, rows) => n + rows.length, 0),
      journal: snapshot.journal.length,
      buckets: Object.keys(snapshot.memory).length,
      events: (snapshot.events || []).length,
      chat: (snapshot.chat || []).reduce((n, f) => n + (f.lines || []).length, 0),
      sessions: (snapshot.transcripts || []).length,
      messages: (snapshot.transcripts || []).reduce((n, s) => n + (s.messages || []).length, 0),
    },
    commit: res && res.commit ? res.commit.sha.slice(0, 8) : '',
    at: Date.now(),
  }
}

/* 拉别的设备的分片，只读，返回每片摘要 + 合并后的条目（不落盘）。 */
export async function pull(input, store) {
  const { repo, token, branch } = parseArgs(input)
  const self = deviceInfo(store).id
  const list = await gh(token, '/repos/' + repo + '/contents/' + SNAP_DIR + '?ref=' + encodeURIComponent(branch), { method: 'GET' })
  const shards = []
  const full = []
  const files = (Array.isArray(list) ? list : []).filter((it) => it && it.type === 'file' && /\.json$/.test(it.name))
  const bodies = await Promise.all(files.map((it) => gh(token, '/repos/' + repo + '/contents/' + it.path + '?ref=' + encodeURIComponent(branch), { method: 'GET' }).catch(() => null)))
  for (let k = 0; k < files.length; k += 1) {
    const item = files[k]
    const one = bodies[k]
    if (!one) continue
    let parsed = null
    try {
      parsed = JSON.parse(Buffer.from(String(one.content || ''), 'base64').toString('utf8'))
    } catch {}
    shards.push({
      file: item.name,
      deviceId: (parsed && parsed.deviceId) || item.name.replace(/\.json$/, ''),
      deviceName: (parsed && parsed.deviceName) || '',
      exportedAt: (parsed && parsed.exportedAt) || 0,
      isSelf: ((parsed && parsed.deviceId) || '') === self,
      memory: parsed && parsed.memory ? Object.values(parsed.memory).reduce((n, rows) => n + (Array.isArray(rows) ? rows.length : 0), 0) : 0,
      journal: parsed && Array.isArray(parsed.journal) ? parsed.journal.length : 0,
      events: parsed && Array.isArray(parsed.events) ? parsed.events.length : 0,
      chat: parsed && Array.isArray(parsed.chat) ? parsed.chat.reduce((n, f) => n + ((f && f.lines) || []).length, 0) : 0,
    })
    full.push({
      file: item.name,
      deviceId: (parsed && parsed.deviceId) || item.name.replace(/\.json$/, ''),
      deviceName: (parsed && parsed.deviceName) || '',
      exportedAt: (parsed && parsed.exportedAt) || 0,
      memory: parsed && parsed.memory ? parsed.memory : {},
      journal: parsed && Array.isArray(parsed.journal) ? parsed.journal : [],
      events: parsed && Array.isArray(parsed.events) ? parsed.events : [],
      chat: parsed && Array.isArray(parsed.chat) ? parsed.chat : [],
    })
  }
  shards.sort((a, b) => b.exportedAt - a.exportedAt)
  full.sort((a, b) => b.exportedAt - a.exportedAt)
  writeShardCache(store, repo, branch, full)
  return { ok: true, repo, branch, shards, count: shards.length, at: Date.now() }
}

export async function verify(input) {
  const parsed = parseArgs(input)
  const me = await gh(parsed.token, '/user', { method: 'GET' })
  let repoInfo = null
  try {
    repoInfo = await gh(parsed.token, '/repos/' + parsed.repo, { method: 'GET' })
  } catch (e) {
    if (e.status === 404) return { ok: true, login: me.login, repo: parsed.repo, exists: false }
    throw e
  }
  return {
    ok: true,
    login: me.login,
    repo: parsed.repo,
    exists: true,
    private: repoInfo.private !== false,
    canPush: Boolean(repoInfo.permissions && repoInfo.permissions.push),
    branch: parsed.branch,
  }
}

// ── 本地分片缓存：拉取负责下载落盘，合并只读本地，不再联网 ──
function shardCacheFile(store) {
  return path.join(store, 'sync', 'shards-cache.json')
}

export function writeShardCache(store, repo, branch, shards) {
  try {
    fs.mkdirSync(path.join(store, 'sync'), { recursive: true })
    fs.writeFileSync(shardCacheFile(store), JSON.stringify({ repo, branch, at: Date.now(), shards }, null, 2), 'utf8')
  } catch {}
}

export function readShardCache(store) {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(shardCacheFile(store), 'utf8'))
  } catch {
    return { ok: false, error: '本地还没有拉取过，先点「拉取」' }
  }
  const shards = Array.isArray(raw && raw.shards) ? raw.shards : []
  if (!shards.length) return { ok: false, error: '本地缓存是空的，先点「拉取」' }
  return { ok: true, repo: raw.repo, branch: raw.branch, shards, count: shards.length, at: raw.at }
}

export async function fetchShards(input, store) {
  const { repo, token, branch } = parseArgs(input)
  const self = deviceInfo(store)
  const dir = await gh(token, '/repos/' + repo + '/contents/' + SNAP_DIR + '?ref=' + encodeURIComponent(branch), { method: 'GET' })
  const shards = []
  const files = (Array.isArray(dir) ? dir : []).filter((it) => it && it.type === 'file' && /\.json$/.test(it.name))
  const bodies = await Promise.all(files.map((it) => gh(token, '/repos/' + repo + '/contents/' + it.path + '?ref=' + encodeURIComponent(branch), { method: 'GET' }).catch(() => null)))
  for (let k = 0; k < files.length; k += 1) {
    const item = files[k]
    const one = bodies[k]
    if (!one) continue
    let parsed = null
    try {
      parsed = JSON.parse(Buffer.from(String(one.content || ''), 'base64').toString('utf8'))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    shards.push({
      file: item.name,
      deviceId: parsed.deviceId || item.name.replace(/\.json$/, ''),
      deviceName: parsed.deviceName || '',
      exportedAt: Number(parsed.exportedAt) || 0,
      isSelf: (parsed.deviceId || '') === self.id,
      memory: parsed.memory && typeof parsed.memory === 'object' ? parsed.memory : {},
      journal: Array.isArray(parsed.journal) ? parsed.journal : [],
    })
  }
  shards.sort((a, b) => b.exportedAt - a.exportedAt)
  return { ok: true, repo, branch, shards, count: shards.length, at: Date.now() }
}
