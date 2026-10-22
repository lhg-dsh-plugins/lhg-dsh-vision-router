/**
 * Issue #697: an opt-in development watcher. This module is never imported by
 * the published plugin and does not modify DSH client carriers or Host APIs.
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function validateDevTarget(raw, chrome, reloadMode = 'page') {
  let url
  try { url = new URL(raw) } catch { throw new Error('Expected a local DSH Web URL') }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username || url.password || !isAbsolute(chrome || '')) {
    throw new Error('Development reload requires HTTP loopback DSH and an absolute Chrome path')
  }
  if (!['page', 'native-hmr'].includes(reloadMode)) throw new Error('Unsupported development reload mode')
  return { url: url.href, chrome, reloadMode }
}

export function createBuildQueue({ build, onError = console.error, debounceMs = 180 }) {
  if (typeof build !== 'function' || !Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new TypeError('build must be a function; debounceMs must be nonnegative')
  }
  let closed = false
  let building = false
  let pending = false
  let timer
  const run = async () => {
    if (closed || building || !pending) return
    building = true
    pending = false
    try { await build() }
    catch (error) {
      try { onError(error) } catch { /* notification cannot stop the watcher */ }
    } finally {
      building = false
      if (!closed && pending && timer === undefined) {
        timer = setTimeout(() => { timer = undefined; void run() }, 0)
      }
    }
  }
  return {
    request() {
      if (closed) return
      pending = true
      clearTimeout(timer)
      timer = setTimeout(() => { timer = undefined; void run() }, debounceMs)
    },
    close() {
      closed = true
      pending = false
      clearTimeout(timer)
      timer = undefined
    },
  }
}

export async function startDevBrowser({ url, chrome, headless = false, reloadMode = 'page' }, { loadPuppeteer } = {}) {
  const target = validateDevTarget(url, chrome, reloadMode)
  // Puppeteer is an existing DVR dependency. Chrome gets its own temporary
  // user profile and a private CDP pipe, not a globally reachable debug port.
  const imported = loadPuppeteer ? await loadPuppeteer() : await import('puppeteer-core')
  const puppeteer = imported.default || imported
  let browser
  try {
    browser = await puppeteer.launch({
      executablePath: target.chrome,
      headless,
      pipe: true,
      args: ['--no-first-run', '--no-default-browser-check', '--no-proxy-server',
        '--disable-background-networking', '--disable-extensions'],
    })
    const page = await browser.newPage()
    // Auth-bearing development URLs must never cause browser requests to a
    // third-party host, including redirects and HTML subresources.
    await page.setRequestInterception(true)
    page.on('request', request => {
      let allowed = false
      try {
        const u = new URL(request.url())
        allowed = (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname))
          || ['data:', 'blob:', 'about:'].includes(u.protocol)
      } catch { /* deny unrecognized URLs */ }
      void (allowed ? request.continue() : request.abort()).catch(() => {})
    })
    let stopped = false
    let tail = Promise.resolve()
    const navigate = async (initial) => {
      if (stopped || page.isClosed()) throw new Error('Development Chrome page was closed')
      const response = initial
        ? await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 15000 })
        : await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 })
      if (response && response.status() >= 400) {
        throw new Error(`DSH Web returned HTTP ${response.status()}`)
      }
      if (!LOOPBACK_HOSTS.has(new URL(page.url()).hostname)) {
        throw new Error('DSH navigated away from loopback')
      }
    }
    await navigate(true)
    if (target.reloadMode === 'native-hmr') {
      const ready = await page.evaluate(async () => {
        if (!globalThis.__DSH_BOOT__?.entries?.some(row => row.id === '@deepseek-ai/dsh-client-hmr')) return false
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 4_000)
        try {
          const response = await fetch('/plugins/events', { signal: controller.signal, cache: 'no-store' })
          return response.ok && response.headers.get('content-type')?.includes('text/event-stream') === true
        } catch { return false }
        finally { clearTimeout(timer); controller.abort() }
      })
      if (!ready) throw new Error('Native DSH Web HMR is unavailable; use page reload mode')
    }
    return {
      reload() {
        if (stopped) return Promise.reject(new Error('Development Chrome was closed'))
        const next = tail.then(() => target.reloadMode === 'native-hmr' ? undefined : navigate(false))
        tail = next.catch(() => {})
        return next
      },
      async close() {
        if (stopped) return
        stopped = true
        await tail
        await browser.close()
      },
    }
  } catch (error) {
    await browser?.close().catch(() => {})
    throw error
  }
}

export async function assertDevArtifacts(root = ROOT) {
  for (const filename of ['entry.js', 'index.js', 'lib/public-entry.js', 'lib/client.js']) {
    await access(join(root, filename))
  }
  const client = await readFile(join(root, 'lib/client.js'), 'utf8')
  if (!client.includes("id: 'dsh-vision-router'") ||
    !client.includes('window.__ModuleLoader__.load(')) {
    throw new Error('Generated DSH Client factory no longer satisfies the loader contract')
  }
}

function childCommand(binary, args, onChild) {
  return new Promise((yes, no) => {
    const win = process.platform === 'win32'
    const child = win
      ? spawn('cmd.exe', ['/d', '/s', '/c', binary, ...args], { cwd: ROOT, stdio: 'inherit' })
      : spawn(binary, args, { cwd: ROOT, stdio: 'inherit' })
    onChild(child)
    child.once('error', no)
    child.once('close', (code, signal) => {
      onChild(undefined)
      if (code === 0) yes()
      else no(new Error(`${binary} ${args.join(' ')} exited ${signal ?? code}`))
    })
  })
}

function main() {
  let browser
  let child
  let stopping = false
  let buildCount = 0
  const browserTarget = process.env.DVR_DEV_WEB_URL
    ? validateDevTarget(process.env.DVR_DEV_WEB_URL, process.env.DVR_DEV_CHROME,
      process.env.DVR_DEV_RELOAD_MODE || 'page')
    : null
  const queue = createBuildQueue({
    async build() {
      const current = ++buildCount
      console.log(`[dev:web] build ${current} started`)
      // The hand-embedded maintenance action must match its canonical source.
      await childCommand('node', ['scripts/sync-client-embedded-modules.mjs', '--check'], x => { child = x })
      await childCommand('node', ['scripts/dev-staged-build.mjs'], x => { child = x })
      await assertDevArtifacts()
      await childCommand('node', ['scripts/verify-source-artifact-map.mjs'], x => { child = x })
      console.log(`[dev:web] build ${current} ready`)
      if (!browserTarget || stopping) return
      try {
        if (!browser) {
          const opened = await startDevBrowser({ ...browserTarget,
            headless: process.env.DVR_DEV_HEADLESS === '1' })
          if (stopping) { await opened.close(); return }
          browser = opened
          console.log(browserTarget.reloadMode === 'native-hmr'
            ? '[dev:web] upstream native Web HMR is active; page remains mounted'
            : '[dev:web] isolated Web Chrome opened')
        } else {
          await browser.reload()
          console.log(browserTarget.reloadMode === 'native-hmr'
            ? '[dev:web] valid build; DSH native HMR watches the Client artifact'
            : '[dev:web] isolated Web Chrome refreshed')
        }
      } catch (error) {
        // Puppeteer errors can embed the secret token URL. Never print them.
        console.error('[dev:web] browser refresh failed (build is valid); check isolated DSH/Chrome')
        const stale = browser
        browser = undefined
        await stale?.close().catch(() => {})
      }
    },
    onError: error => console.error('[dev:web] build failed; no browser refresh:', error),
  })
  const watched = []
  function addWatch(path, recursive, isRelevant) {
    watched.push(watch(join(ROOT, path), { recursive }, (_event, filename) => {
      if (!filename || isRelevant(String(filename))) queue.request()
    }))
  }
  try {
    addWatch('src', true, () => true)
    addWatch('scripts', false, name => /^(?:build-source-artifacts|dev-staged-build|sync-client-embedded-modules|verify-source-artifact-map)\.mjs$/.test(name))
    addWatch('.', false, name => /^(?:package\.json|tsconfig\.build\.json)$/.test(name))
  } catch (error) {
    for (const w of watched) w.close()
    throw error
  }
  function stop() {
    if (stopping) return
    stopping = true
    queue.close()
    for (const w of watched) w.close()
    child?.kill('SIGTERM')
    void browser?.close().catch(error => console.error('[dev:web] failed to close Chrome:', error))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  queue.request()
  console.log('[dev:web] watching src/; Client runs only after verified rebuild')
  if (browserTarget) console.log(`[dev:web] isolated Chrome mode: ${browserTarget.reloadMode}`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
