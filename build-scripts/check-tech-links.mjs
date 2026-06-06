#!/usr/bin/env node
// 扫描 public/rules/ 下所有规则 JSON,收集 `name` 字段,跟 public/tech-links.json 的 key 比对
// 报告:
//   1. tech-links 里有 key 但所有规则文件里都没出现 → 孤儿链接(没规则在用)
//   2. 规则里有 name 但 tech-links 缺 key → 缺链接(点击没跳转 URL)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const rulesDir = join(repoRoot, 'public', 'rules')
const techLinksPath = join(repoRoot, 'public', 'tech-links.json')

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, files)
    } else if (entry.endsWith('.json')) {
      files.push(full)
    }
  }
  return files
}

function collectNames(node, names, source) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectNames(item, names, source)
    return
  }
  if (typeof node.name === 'string' && node.name.trim()) {
    const key = node.name.trim()
    const existing = names.get(key)
    if (existing) existing.add(source)
    else names.set(key, new Set([source]))
  }
  for (const value of Object.values(node)) {
    collectNames(value, names, source)
  }
}

const techLinksRoot = JSON.parse(readFileSync(techLinksPath, 'utf8'))
const techLinks = techLinksRoot.links || techLinksRoot
const techLinkKeys = new Set(Object.keys(techLinks))

const ruleNames = new Map() // name → Set<sourceFile>
for (const file of walk(rulesDir)) {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    collectNames(json, ruleNames, relative(repoRoot, file))
  } catch (error) {
    console.error(`[ERROR] parse ${relative(repoRoot, file)}: ${error.message}`)
    process.exitCode = 2
  }
}

// 这些识别在 src/injected/page-detector.ts 里直接 add，不走 public/rules/* JSON 规则
// 所以扫描规则时找不到 name，但 tech-links 里需要保留对应链接
for (const name of ['HTTPS', 'HTTP/2', 'HTTP/3', 'Content Security Policy', 'Service Worker']) {
  if (!ruleNames.has(name)) ruleNames.set(name, new Set(['<built-in>']))
}

const orphanLinks = []
for (const key of techLinkKeys) {
  if (!ruleNames.has(key)) orphanLinks.push(key)
}

const missingLinks = []
for (const name of ruleNames.keys()) {
  if (!techLinkKeys.has(name)) missingLinks.push(name)
}

console.log(`扫描结果`)
console.log(`  规则文件:${walk(rulesDir).length} 个`)
console.log(`  规则中出现的 name:${ruleNames.size} 个唯一值`)
console.log(`  tech-links 总键数:${techLinkKeys.size}`)
console.log('')

console.log(`孤儿链接(tech-links 有键,但所有规则里都没引用):${orphanLinks.length}`)
for (const name of orphanLinks.sort()) {
  console.log(`  - "${name}"`)
}

console.log('')
console.log(`缺链接(规则里有 name,但 tech-links 无键):${missingLinks.length}`)
for (const name of missingLinks.sort()) {
  const sources = [...ruleNames.get(name)].sort().join(', ')
  console.log(`  - "${name}"  ← ${sources}`)
}

if (orphanLinks.length || missingLinks.length) {
  process.exitCode = 1
}
