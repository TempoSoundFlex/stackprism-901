import { cpSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import archiver from 'archiver'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(root, 'dist')
const firefoxDir = resolve(root, 'dist-firefox')

if (!existsSync(distDir)) {
  console.error('[package-firefox] dist/ not found, run `pnpm build` first')
  process.exit(1)
}

rmSync(firefoxDir, { recursive: true, force: true })
cpSync(distDir, firefoxDir, { recursive: true })

// --- Bundle background script as IIFE ---
// CRXJS outputs background as ES modules with code-split shared chunks.
// Firefox background scripts don't support ES modules, so we rebundle
// the entry point into a single IIFE via esbuild.

const loaderPath = resolve(firefoxDir, 'service-worker-loader.js')
const loaderCode = readFileSync(loaderPath, 'utf8')
const entryMatch = loaderCode.match(/import\s+'\.\/(assets\/[^']+)'/)
if (!entryMatch) {
  console.error('[package-firefox] could not resolve service-worker-loader entry')
  process.exit(1)
}

const entryPath = resolve(firefoxDir, entryMatch[1])
const backgroundPath = resolve(firefoxDir, 'background.js')

await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  format: 'iife',
  outfile: backgroundPath,
  target: 'es2022',
  platform: 'browser',
  logLevel: 'warning'
})

console.log('[package-firefox] bundled background.js as IIFE')

// --- Transform manifest.json ---

const manifestPath = resolve(firefoxDir, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

if (manifest.background?.service_worker) {
  manifest.background = { scripts: ['background.js'] }
}

manifest.browser_specific_settings = {
  gecko: {
    id: 'stackprism@setube.github.io',
    strict_min_version: '128.0'
  }
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
console.log('[package-firefox] manifest.json transformed')

// --- Package .xpi ---

const releaseDir = resolve(root, 'release')
if (!existsSync(releaseDir)) mkdirSync(releaseDir)

const version = manifest.version
const xpiName = `stackprism-v${version}.xpi`
const xpiPath = resolve(releaseDir, xpiName)

await new Promise((ok, reject) => {
  const output = createWriteStream(xpiPath)
  const archive = archiver('zip', { zlib: { level: 9 } })
  output.on('close', ok)
  archive.on('error', reject)
  archive.pipe(output)
  archive.glob('**', { cwd: firefoxDir, dot: true })
  archive.finalize()
})

console.log(`[package-firefox] created release/${xpiName}`)
