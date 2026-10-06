// 通风判定口径的回归校验：打包 scripts/sanity-ventilation.ts 后直接在 node 里跑。
// 用 esbuild 的 JS API，平台二进制由 esbuild 按当前系统自行解析。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'

const outfile = 'node_modules/.cache/sanity-ventilation.mjs'

await build({
  entryPoints: ['scripts/sanity-ventilation.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  alias: { '@': './src' },
  outfile,
  logLevel: 'silent',
})

await import(pathToFileURL(outfile).href)
