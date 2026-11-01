// Drives the app in headless Chromium: screenshots at common laptop sizes and
// rough timings, optionally with the CPU throttled to mimic a slow laptop.
// Uses the production build (run `pnpm build` first), or with --dev the dev
// server, where React's StrictMode runs effects twice.
// Usage: node bench/ui.ts <out-dir> [--dev] [--throttle 6] [--dark] [--sizes 1366x768,...] [--model file.stl --mass report.txt]
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer, preview } from 'vite'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const out = args[0] && !args[0].startsWith('--') ? args[0] : 'bench/out'
const throttle = Number(opt('--throttle') ?? 1)
const modelPath = opt('--model')
const massPath = opt('--mass')
const dark = args.includes('--dark')
const sizes = (opt('--sizes') ?? '1280x720,1366x768,1440x900,1920x1080,900x800').split(',').map((s) => s.split('x').map(Number))

mkdirSync(out, { recursive: true })
const server = args.includes('--dev')
  ? await (await createServer({ server: { port: 4317 }, logLevel: 'warn' })).listen()
  : await preview({ preview: { port: 4317 }, logLevel: 'warn' })
const url = server.resolvedUrls!.local[0]
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })

async function timed<T>(label: string, f: () => Promise<T>): Promise<T> {
  const t = performance.now()
  const r = await f()
  console.log(`${label}: ${Math.round(performance.now() - t)} ms`)
  return r
}

for (const [w, h] of sizes) {
  const tag = `${w}x${h}`
  const page = await browser.newPage({ viewport: { width: w, height: h }, colorScheme: dark ? 'dark' : 'light' })
  page.on('pageerror', (e) => console.log(`[${tag}] page error: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && console.log(`[${tag}] console: ${m.text()}`))
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  }
  await page.goto(url)
  await page.screenshot({ path: join(out, `${tag}-0-empty.png`) })
  if (modelPath) {
    await timed(`[${tag}] load model`, async () => {
      await page.setInputFiles('input[type=file]', modelPath)
      await page.waitForSelector('.topbar .file', { timeout: 180000 })
    })
    if (massPath) {
      await timed(`[${tag}] first pose list`, async () => {
        await page.fill('.mass textarea', readFileSync(massPath, 'utf8'))
        await page.waitForSelector('.poses table', { timeout: 180000 })
      })
    }
  } else {
    await timed(`[${tag}] sample bot to pose list`, async () => {
      await page.click('text=Try the sample bot')
      await page.waitForSelector('.poses table', { timeout: 180000 })
    })
  }
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(out, `${tag}-1-poses.png`) })
  await page.click('.tabs button:has-text("Basins")')
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(out, `${tag}-2-basins.png`) })
  await page.click('.tabs button:has-text("Hits")')
  await timed(`[${tag}] heatmap`, () => page.waitForSelector('.legend', { timeout: 180000 }))
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(out, `${tag}-3-hits.png`) })

  // A rising hit (elevation 45°, in 5° steps), then click the middle of the viewport to probe it.
  await page.locator('.slider input').first().focus()
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(1500)
  console.log(`[${tag}] elevation now: ${await page.locator('.slider output').first().textContent()}`)
  const box = (await page.locator('.canvas').boundingBox())!
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(out, `${tag}-4-hits-probe.png`) })

  // Drop it from a point near the top of the shell and let it roll.
  await page.click('.tabs button:has-text("Basins")')
  await page.waitForTimeout(500)
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.3)
  await page.waitForTimeout(4000)
  await page.screenshot({ path: join(out, `${tag}-5-roll.png`) })
  await page.close()
}
await browser.close()
await server.close()
