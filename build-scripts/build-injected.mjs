import { spawnSync } from 'node:child_process'
import { rmSync, mkdirSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(__dirname, '..')

const entries = ['page-detector', 'page-source-search']

const outDir = resolve(root, 'public/injected')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const entry of entries) {
  console.log(`\n[build-injected] building ${entry}.iife.js`)
  const result = spawnSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.injected.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, INJECTED_ENTRY: entry },
    shell: true
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  // Vite IIFE lib mode emits `var X=function(){...}()` as the last statement.
  // chrome.scripting.executeScript({files}) needs the script's last *expression*
  // value to surface as `result`, so append a bare reference to the IIFE name.
  const globalName = `__StackPrismInjected_${entry.replace(/-/g, '_')}__`
  const filePath = resolve(outDir, `${entry}.iife.js`)
  appendFileSync(filePath, `\n${globalName};\n`)
}

console.log('\n[build-injected] done')
