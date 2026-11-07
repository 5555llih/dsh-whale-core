/* ── GitHub 同步 ─────────────────────────────────────────────────────────────
 * 走 GitHub REST API 直接读写文件，不依赖 git 二进制。
 * 每台设备只写自己那一片 data/<deviceId>.json，落盘时按条目 id 合并，
 * 所以两台机器各写各的不会撞车；同一个仓库同时也是一份带历史的离线备份。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

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
async function ghFetch(url, init, tries = 3) {
  let lastErr = null
  for (let i = 0; i < tries; i += 1) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 25000)
    try {
      return await fetch(url, Object.assign({}, init, { signal: ctrl.signal }))
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

/* 打包一份快照：设置（去掉 token）、人设、记忆分片、日记。
 * 事件线和 pending 只在本机有意义，不往外带。 */
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
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || item.type !== 'file' || !/\.json$/.test(item.name)) continue
    const one = await gh(token, '/repos/' + repo + '/contents/' + item.path + '?ref=' + encodeURIComponent(branch), { method: 'GET' })
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
    })
  }
  shards.sort((a, b) => b.exportedAt - a.exportedAt)
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

// 拉取全部分片的**完整内容**（pull() 只给统计，合并要正文）
export async function fetchShards(input, store) {
  const { repo, token, branch } = parseArgs(input)
  const self = deviceInfo(store)
  const dir = await gh(token, '/repos/' + repo + '/contents/' + SNAP_DIR + '?ref=' + encodeURIComponent(branch), { method: 'GET' })
  const shards = []
  for (const item of Array.isArray(dir) ? dir : []) {
    if (!item || item.type !== 'file' || !/\.json$/.test(item.name)) continue
    const one = await gh(token, '/repos/' + repo + '/contents/' + item.path + '?ref=' + encodeURIComponent(branch), { method: 'GET' })
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
