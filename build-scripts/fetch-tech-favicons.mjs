#!/usr/bin/env node
// 给 tech-links.json 里"有官网但 Wappalyzer 没收图标"的 tech 自动抓官网 favicon,
// 保存到 build-scripts/custom-icons/<slug>.{svg,png,ico},随后被 extract-wappalyzer-icons.mjs 复制到 public/skills/
//
// 工作流:
//   1. 读 tech-links.json 拿所有 tech 名 → 官网 URL 映射
//   2. 跳过 skills-index 已经有图标的 slug
//   3. 跳过黑名单域名(github/npm/wordpress.org/drupal.org 等"非品牌官网"位置)
//   4. 抓 HTML head 找最大 favicon:SVG → apple-touch-icon → 32+ PNG → /favicon.ico
//   5. 下载保存
//
// 用法:
//   node build-scripts/fetch-tech-favicons.mjs            # 全量
//   node build-scripts/fetch-tech-favicons.mjs --limit=50 # 只跑前 50 个

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const TECH_LINKS_PATH = path.join(repoRoot, 'public', 'tech-links.json')
const MANIFEST_PATH = path.join(repoRoot, 'src', 'ui', 'components', 'skills-index.json')
const OUTPUT_DIR = path.join(__dirname, 'custom-icons')

const CONCURRENCY = 8
const TIMEOUT_MS = 6000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const limit = Number(args.find(a => a.startsWith('--limit='))?.split('=')[1] || 0)
const force = args.includes('--force')
const onlyName = args.find(a => a.startsWith('--only='))?.split('=')[1] || ''

// 这些域名是"非品牌官网"集散地,即使 tech-links 里指向它们也不能拿来当品牌 logo
const DOMAIN_BLOCKLIST = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'sourceforge.net',
  'npmjs.com',
  'www.npmjs.com',
  'wordpress.org',
  'drupal.org',
  'packagist.org',
  'cdnjs.com',
  'unpkg.com',
  'jsdelivr.com',
  'cdn.jsdelivr.net',
  'yarnpkg.com',
  'pypi.org',
  'mvnrepository.com',
  'nuget.org',
  'rubygems.org',
  'crates.io',
  'hex.pm',
  'pkg.go.dev',
  'pub.dev',
  'developer.mozilla.org',
  'w3.org',
  'www.w3.org',
  'spec.whatwg.org',
  'tc39.es',
  'caniuse.com',
  'web.dev',
  'developers.google.com',
  'docs.microsoft.com',
  'learn.microsoft.com',
  'docs.aws.amazon.com'
])

// 我们规则里有些 name 不是品牌名(协议/规范类),用官网 favicon 没意义
const NAME_SKIP = new Set([
  'HTTPS',
  'HTTP/2',
  'HTTP/3',
  'JavaScript',
  'WebSocket',
  'WebAssembly',
  'ES Modules',
  'PWA Manifest',
  'Service Worker'
])

const normalize = raw =>
  String(raw || '')
    .toLowerCase()
    .replace(/\./g, 'dot')
    .replace(/\+/g, 'plus')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9一-龥]/g, '')

const primaryName = name =>
  String(name || '')
    .split(/\s*\/\s*/)[0]
    .trim() || String(name || '').trim()

const slugFromName = name => normalize(primaryName(name))

const sleep = ms => new Promise(r => setTimeout(r, ms))

// 拉取带超时,签名 200
const fetchWithTimeout = async (url, init = {}) => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...(init.headers || {}) }
    })
    return res
  } finally {
    clearTimeout(timer)
  }
}

const parseSizes = sizes => {
  if (!sizes) return 0
  const m = /(\d+)x(\d+)/i.exec(String(sizes))
  return m ? Math.min(Number(m[1]), Number(m[2])) : 0
}

// 从 HTML head 找最大 favicon 候选
const extractFaviconCandidates = (html, baseUrl) => {
  const candidates = []
  const linkPattern = /<link\b[^>]+>/gi
  let m
  while ((m = linkPattern.exec(html))) {
    const tag = m[0]
    const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || ''
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || ''
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || ''
    const sizes = /\bsizes\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || ''
    if (!href) continue
    const lowerRel = rel.toLowerCase()
    if (!/(icon|apple-touch-icon|mask-icon)/.test(lowerRel)) continue
    let abs
    try {
      abs = new URL(href, baseUrl).toString()
    } catch {
      continue
    }
    const isSvg = /\.svg(?:$|[?#])/i.test(abs) || /svg/i.test(type)
    const isApple = /apple-touch-icon/.test(lowerRel)
    const size = parseSizes(sizes)
    // 评分:SVG > apple-touch > 大 size > 普通 icon
    let score = 0
    if (isSvg) score += 1000
    if (isApple) score += 300
    score += size
    candidates.push({ url: abs, score, type })
  }
  return candidates.sort((a, b) => b.score - a.score)
}

const extFromUrlAndType = (url, contentType) => {
  if (/\.svg(?:$|[?#])/i.test(url) || /svg/i.test(contentType)) return 'svg'
  if (/\.png(?:$|[?#])/i.test(url) || /png/i.test(contentType)) return 'png'
  if (/\.ico(?:$|[?#])/i.test(url) || /x-icon|icon/i.test(contentType)) return 'ico'
  if (/\.jpe?g(?:$|[?#])/i.test(url) || /jpe?g/i.test(contentType)) return 'png' // 用 .png 后缀容纳 jpeg(浏览器 img 会自动识别)
  return ''
}

const fetchIcon = async (techName, websiteUrl) => {
  let origin
  try {
    origin = new URL(websiteUrl).origin
  } catch {
    return { ok: false, reason: 'invalid-url' }
  }
  // 1. 抓 origin HTML,从 <link rel="icon"> 找最大候选(就算 HTML 拉不下来,也兜底直接打 /favicon.ico)
  let html = ''
  try {
    const res = await fetchWithTimeout(origin, {})
    if (res.ok) html = await res.text()
  } catch {
    // 忽略,继续走 fallback
  }
  const candidates = extractFaviconCandidates(html, origin)
  // 2. fallback:apple-touch-icon / favicon.ico 几个标准位置
  candidates.push({ url: new URL('/apple-touch-icon.png', origin).toString(), score: 200, type: '' })
  candidates.push({ url: new URL('/favicon.svg', origin).toString(), score: 100, type: '' })
  candidates.push({ url: new URL('/favicon.ico', origin).toString(), score: 0, type: '' })

  const tried = []
  for (const cand of candidates) {
    try {
      const res = await fetchWithTimeout(cand.url, {})
      if (!res.ok) {
        tried.push(`${cand.url}=${res.status}`)
        continue
      }
      const buf = Buffer.from(await res.arrayBuffer())
      const contentType = res.headers.get('content-type') || ''
      if (buf.length < 64) {
        tried.push(`${cand.url}=tooSmall(${buf.length})`)
        continue
      }
      if (buf.length > 512 * 1024) {
        tried.push(`${cand.url}=tooLarge(${buf.length})`)
        continue
      }
      const ext = extFromUrlAndType(cand.url, contentType)
      if (!ext) {
        tried.push(`${cand.url}=unknownExt(ct=${contentType})`)
        continue
      }
      return { ok: true, ext, buf, sourceUrl: cand.url, score: cand.score }
    } catch (e) {
      tried.push(`${cand.url}=err:${e?.name || 'unknown'}`)
      continue
    }
  }
  return { ok: false, reason: 'no-icon-found', tried }
}

// ---------------- 主流程 ----------------

const techLinks = JSON.parse(fs.readFileSync(TECH_LINKS_PATH, 'utf8')).links || {}
const skillsIndex = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).skillsIndex || {}

fs.mkdirSync(OUTPUT_DIR, { recursive: true })
const existingCustom = new Set(fs.readdirSync(OUTPUT_DIR).map(f => normalize(f.replace(/\.(svg|png|ico)$/i, ''))))

const queue = []
for (const [name, url] of Object.entries(techLinks)) {
  if (!url || typeof url !== 'string') continue
  if (NAME_SKIP.has(name)) continue
  if (onlyName && name !== onlyName) continue
  const slug = slugFromName(name)
  if (!slug) continue
  if (!force && skillsIndex[slug]) continue // 已有 Wappalyzer / 之前抓的图标,跳过
  if (!force && existingCustom.has(slug)) continue
  let host
  try {
    host = new URL(url).host.toLowerCase()
  } catch {
    continue
  }
  if (DOMAIN_BLOCKLIST.has(host)) continue
  queue.push({ name, url, slug })
}

console.log(
  `[plan] 候选 tech 数:${queue.length}(总 tech: ${Object.keys(techLinks).length},Wappalyzer 已覆盖: ${Object.keys(skillsIndex).length})`
)
const todo = limit > 0 ? queue.slice(0, limit) : queue
console.log(`[plan] 本次抓:${todo.length} 个(${limit > 0 ? '--limit=' + limit : '全量'})`)

let okCount = 0
let failCount = 0
const fails = []

const runBatch = async batch => {
  const results = await Promise.all(
    batch.map(async item => {
      const r = await fetchIcon(item.name, item.url)
      if (!r.ok) {
        failCount++
        fails.push({ name: item.name, slug: item.slug, reason: r.reason, tried: r.tried })
        return
      }
      const filename = item.slug + '.' + r.ext
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), r.buf)
      okCount++
      console.log(`  ✓ ${item.name.padEnd(40)} ${r.ext.padEnd(4)} ${r.buf.length}B  ${r.sourceUrl.slice(0, 80)}`)
    })
  )
  return results
}

;(async () => {
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const batch = todo.slice(i, i + CONCURRENCY)
    await runBatch(batch)
    if (i % 40 === 0) await sleep(200) // 节流,别太凶
  }
  console.log(`\n[done] ok=${okCount} fail=${failCount}`)
  if (fails.length && fails.length <= 30) {
    console.log('\n失败明细(前 30):')
    fails.slice(0, 30).forEach(f => {
      console.log(`  · ${f.name.padEnd(40)} ${f.reason}`)
      if (f.tried) f.tried.forEach(t => console.log(`      ${t}`))
    })
  }
  console.log(`\n下一步:跑 \`node build-scripts/extract-wappalyzer-icons.mjs\` 让 custom-icons/ 复制到 public/skills/ 并更新 manifest`)
})()
