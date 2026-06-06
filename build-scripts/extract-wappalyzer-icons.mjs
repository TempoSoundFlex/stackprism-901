#!/usr/bin/env node
// 从本地安装的 Wappalyzer 扩展抽取与我们 rules name 命中的图标,放到 public/skills/<slug>.{svg,png}
// 用法:WAPPALYZER_ICON_DIR=<wappalyzer 安装目录的 images/icons> node build-scripts/extract-wappalyzer-icons.mjs
// 默认到百分浏览器(Cent Browser)的 Wappalyzer 6.12.2 安装路径找
// 设计参考:https://github.com/setube/stackprism/issues/6
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const DEFAULT_DIR =
  'C:/Users/19622/AppData/Local/CentBrowser/User Data/Default/Extensions/gppongmhjkpfnbhagpmjfkannfbllamg/6.12.2_0/images/icons'
const ICON_DIR = process.env.WAPPALYZER_ICON_DIR || DEFAULT_DIR
const RULES_DIR = path.join(repoRoot, 'public', 'rules')
const OUTPUT_DIR = path.join(repoRoot, 'public', 'skills')
const CUSTOM_DIR = path.join(__dirname, 'custom-icons')
const MANIFEST_PATH = path.join(repoRoot, 'src', 'ui', 'components', 'skills-index.json')

// service worker / page-detector 在运行时硬编码塞到识别结果里、不在 rules JSON 中出现的技术名
const EXTRA_NAMES = ['HTTP/2', 'HTTP/3', 'HTTPS']

// 规则 name → Wappalyzer 图标文件 basename(不带后缀)的手写别名。
// 用在自动 slug 匹配 + 首词兜底都查不到 Wappalyzer 图标时,作为最后一档兜底。
// key 是我们规则里的 tech.name(原文,大小写区分);value 是 Wappalyzer images/icons/ 下的文件名
const ICON_NAME_ALIASES = {
  'Hotwire Turbo': 'Turbo',
  AWS: 'Amazon Web Services',
  'AWS CloudFront': 'Amazon Cloudfront',
  'AWS S3 / Static Hosting': 'Amazon S3',
  'shadcn-vue': 'shadcn-ui',
  'Tencent EdgeOne': 'EdgeOne'
}

// 首词品牌别名:把我们规则常用的简写品牌前缀映射到 Wappalyzer 命名风格,
// 让首词兜底也能正确命中(AWS Bedrock / AWS Amplify / AWS Textract 等都走 Amazon Web Services 主 logo)
const BRAND_FIRST_WORD_ALIASES = {
  AWS: 'Amazon Web Services',
  Alibaba: 'Alibaba Cloud'
}

if (!fs.existsSync(ICON_DIR)) {
  console.error(`找不到 Wappalyzer 图标目录:${ICON_DIR}`)
  console.error('请设置环境变量 WAPPALYZER_ICON_DIR 指向本地安装的 images/icons 目录')
  process.exit(1)
}

const collectNames = (node, out) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const i of node) collectNames(i, out)
    return
  }
  if (typeof node.name === 'string') out.add(node.name.trim())
  for (const v of Object.values(node)) collectNames(v, out)
}

const walk = (dir, files = []) => {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e)
    if (fs.statSync(p).isDirectory()) walk(p, files)
    else if (e.endsWith('.json')) files.push(p)
  }
  return files
}

// 规范化函数:跟 TechChip / issue#6 保持一致
// 小写 + `&`→`and` + `+`→`plus`,保留 [a-z0-9] 和 CJK 统一表意文字(让"百度统计"、"飞书"这类纯中文名也能查到)
const normalize = raw =>
  String(raw ?? '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9一-龥]+/g, '')

// 拆别名:` / `(带空格)只在别名分隔时出现,保留 HTTP/2 这类纯版本号写法
const primaryName = raw =>
  String(raw || '')
    .split(' / ')[0]
    .trim()

// 收 Wappalyzer 图标库:slug → [候选文件名(可能多种扩展名)]
const iconBySlug = new Map()
for (const f of fs.readdirSync(ICON_DIR)) {
  if (!f.endsWith('.svg') && !f.endsWith('.png')) continue
  const slug = normalize(f.replace(/\.(svg|png)$/i, ''))
  if (!slug) continue
  if (!iconBySlug.has(slug)) iconBySlug.set(slug, [])
  iconBySlug.get(slug).push(f)
}

// 收我们 rules 里所有 name + EXTRA_NAMES
const ruleNames = new Set(EXTRA_NAMES)
for (const f of walk(RULES_DIR)) {
  try {
    collectNames(JSON.parse(fs.readFileSync(f, 'utf8')), ruleNames)
  } catch {
    // ignore parse errors
  }
}

// 清掉旧的输出目录,重新抽
if (fs.existsSync(OUTPUT_DIR)) fs.rmSync(OUTPUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// 给定一个 name,返回命中的 Wappalyzer slug(可能跟 localKey 不同,例如 cloudflarewebanalytics → cloudflare)
const matchWappalyzerSlug = name => {
  // 0. 手写 alias 优先:Hotwire Turbo → Turbo 之类拼接 / 复合命名的特殊情况
  const aliased = ICON_NAME_ALIASES[name]
  if (aliased) {
    const aliasSlug = normalize(aliased)
    if (aliasSlug && iconBySlug.has(aliasSlug)) return aliasSlug
  }
  const base = primaryName(name)
  const fullSlug = normalize(base)
  if (iconBySlug.has(fullSlug)) return fullSlug
  // 首词兜底:"Cloudflare Web Analytics" → "Cloudflare" → cloudflare;
  // "Microsoft Teams" → "Microsoft"。会用品牌主 logo,牺牲一点准确度换覆盖率
  const firstWord = base.split(/\s+/)[0]
  if (!firstWord) return null
  // 先经过品牌别名(AWS → Amazon Web Services),再走 slug 匹配
  const brandAliased = BRAND_FIRST_WORD_ALIASES[firstWord] || firstWord
  const firstSlug = normalize(brandAliased)
  if (firstSlug && firstSlug !== fullSlug && iconBySlug.has(firstSlug)) return firstSlug
  return null
}

let mappedKeys = 0
let prefixMatched = 0
let svgCount = 0
let pngCount = 0
let customCount = 0
let totalBytes = 0
// skillsIndex:localKey(规则名 slug) → 实际磁盘文件名(可能多个 key 共用一个文件,节省体积)
const skillsIndex = {}
// 已写到磁盘的 Wappalyzer slug → 文件名,避免重复写
const writtenFiles = new Map()
const seenLocalKeys = new Set()

for (const name of ruleNames) {
  const localKey = normalize(primaryName(name))
  if (!localKey || seenLocalKeys.has(localKey)) continue
  const matchedSlug = matchWappalyzerSlug(name)
  if (!matchedSlug) continue

  let filename = writtenFiles.get(matchedSlug)
  if (!filename) {
    // 第一次见这个 Wappalyzer slug,落盘一份;优先 svg
    const candidates = iconBySlug.get(matchedSlug)
    const file = candidates.find(c => c.endsWith('.svg')) || candidates[0]
    const ext = path.extname(file).toLowerCase().slice(1)
    filename = matchedSlug + '.' + ext
    const dst = path.join(OUTPUT_DIR, filename)
    fs.copyFileSync(path.join(ICON_DIR, file), dst)
    writtenFiles.set(matchedSlug, filename)
    totalBytes += fs.statSync(dst).size
    if (ext === 'svg') svgCount++
    else pngCount++
  }

  seenLocalKeys.add(localKey)
  skillsIndex[localKey] = filename
  mappedKeys++
  if (matchedSlug !== localKey) prefixMatched++
}

// 自定义图标:覆盖 Wappalyzer 没有的(HTTPS 锁、未来补充的)。
// 自定义图标比 Wappalyzer 优先
if (fs.existsSync(CUSTOM_DIR)) {
  for (const f of fs.readdirSync(CUSTOM_DIR)) {
    if (!/\.(svg|png|ico)$/i.test(f)) continue
    const slug = normalize(f.replace(/\.(svg|png|ico)$/i, ''))
    if (!slug) continue
    const ext = path.extname(f).toLowerCase().slice(1)
    const filename = slug + '.' + ext
    const dst = path.join(OUTPUT_DIR, filename)
    fs.copyFileSync(path.join(CUSTOM_DIR, f), dst)
    if (!skillsIndex[slug]) mappedKeys++
    skillsIndex[slug] = filename
    customCount++
    totalBytes += fs.statSync(dst).size
  }
}

// 写出 skills-index.json,运行时 TechChip 用它判断本地是否有图标,避免无意义 404
const sortedIndex = {}
for (const slug of Object.keys(skillsIndex).sort()) sortedIndex[slug] = skillsIndex[slug]
const out = { schemaVersion: 1, skillsIndex: sortedIndex }
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(out) + '\n', 'utf8')

console.log(
  `抽取完成:${mappedKeys} 个映射 → ${writtenFiles.size + customCount} 个物理文件 ` +
    `(svg: ${svgCount}, png: ${pngCount}, custom: ${customCount}, 首词兜底: ${prefixMatched})`
)
console.log(`输出目录:${OUTPUT_DIR}`)
console.log(`总大小:${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`索引:${MANIFEST_PATH}`)
