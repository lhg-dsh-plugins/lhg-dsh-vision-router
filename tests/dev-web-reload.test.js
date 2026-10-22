import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { assertDevArtifacts, createBuildQueue, startDevBrowser, validateDevTarget } from '../scripts/dev-web-reload.mjs'

const target = { url: 'http://127.0.0.1:19000/?token=NOT_A_REAL_TOKEN', chrome: resolve('test-chrome') }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const until = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await sleep(10)
  }
  assert.fail('timed out waiting for queued task')
}
const deferred = () => {
  let release
  const promise = new Promise(done => { release = done })
  return { promise, release }
}

test('dev browser is opt-in and refuses remote, credentialed, or insecure targets', () => {
  for (const bad of ['https://localhost:1/', 'http://example.com/', 'http://0.0.0.0/',
    'http://localhost.evil.invalid/', 'http://user:password@127.0.0.1/', 'file:///tmp/test',
    'javascript:alert(1)']) {
    assert.throws(() => validateDevTarget(bad, target.chrome), /loopback/)
  }
  assert.throws(() => validateDevTarget(target.url, 'chrome'), /absolute Chrome path/)
  assert.equal(validateDevTarget('http://[::1]:19999/', target.chrome).url, 'http://[::1]:19999/')
})

test('bursty events coalesce without concurrent builds, edits during build cause one more build', async () => {
  const first = deferred()
  const second = deferred()
  let starts = 0; let executing = 0; let peak = 0
  const queue = createBuildQueue({ debounceMs: 0, async build() {
    starts++; executing++; peak = Math.max(peak, executing)
    if (starts === 1) await first.promise
    if (starts === 2) second.release()
    executing--
  } })
  try {
    queue.request(); queue.request(); queue.request()
    await until(() => starts === 1)
    queue.request(); queue.request()
    await sleep(25)
    assert.equal(starts, 1)
    first.release()
    await second.promise
    assert.equal(starts, 2)
    assert.equal(peak, 1)
  } finally { first.release(); queue.close() }
})

test('build failures are reported and next successful edit is still processed', async () => {
  const errors = []
  const ready = deferred()
  let starts = 0
  const queue = createBuildQueue({ debounceMs: 0, onError: e => errors.push(e.message), async build() {
    if (++starts === 1) throw new Error('build intentionally rejected')
    ready.release()
  } })
  try {
    queue.request()
    await until(() => errors.length === 1)
    queue.request()
    await ready.promise
    assert.deepEqual(errors, ['build intentionally rejected'])
    assert.equal(starts, 2)
  } finally { queue.close() }
})

test('valid browser uses private CDP pipe and never allows external requests', async () => {
  const invoked = []; const listeners = new Map()
  const fakePage = {
    isClosed: () => false,
    url: () => 'http://127.0.0.1:19000/',
    setRequestInterception: async value => invoked.push('interception:' + value),
    on: (name, fn) => listeners.set(name, fn),
    goto: async url => { assert.equal(url, target.url); invoked.push('goto'); return {status:()=>200} },
    reload: async () => { invoked.push('reload'); return {status:()=>200} },
  }
  let launch
  const handle = await startDevBrowser(target, {loadPuppeteer:async()=>({launch:async options=>{
    launch = options
    return { newPage:async()=>fakePage, close:async()=>invoked.push('close') }
  }})})
  const requests = []
  const makeRequest = url => ({url:()=>url, continue:async()=>requests.push('continue'),abort:async()=>requests.push('abort')})
  listeners.get('request')(makeRequest('http://127.0.0.1:19000/api/test'))
  listeners.get('request')(makeRequest('https://evil.invalid/token'))
  listeners.get('request')(makeRequest('http://localhost.evil.invalid/'))
  await sleep(0)
  await handle.reload()
  await handle.close()
  assert.deepEqual(requests, ['continue', 'abort', 'abort'])
  assert.equal(launch.pipe, true)
  assert.equal(launch.executablePath, target.chrome)
  assert.deepEqual(invoked,['interception:true','goto','reload','close'])
  await assert.rejects(handle.reload(), /closed/)
})

test('browser initialization error closes owned Chrome without leaking secret URL', async () => {
  let closed = 0
  await assert.rejects(startDevBrowser(target, {loadPuppeteer:async()=>({launch:async()=>({
    newPage:async()=>({setRequestInterception:async()=>{},on:()=>{},isClosed:()=>false,goto:async()=>({status:()=>503})}),
    close:async()=>{closed++},
  })})}),/503/)
  assert.equal(closed, 1)
})

test('only a complete DSH Client factory is accepted after rebuild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dvr-dev-web-artifacts-'))
  try {
    await mkdir(join(dir, 'lib'))
    for (const file of ['entry.js','index.js','lib/public-entry.js']) await writeFile(join(dir,file),'export {}')
    await writeFile(join(dir, 'lib/client.js'), 'unrelated broken JavaScript')
    await assert.rejects(assertDevArtifacts(dir), /factory/)
    await writeFile(join(dir, 'lib/client.js'), "window.__ModuleLoader__.load({ id: 'dsh-vision-router', factory: ()=>({}) })")
    await assertDevArtifacts(dir)
  } finally { await rm(dir, {force:true,recursive:true}) }
})

test('native DSH Web HMR is opt-in and suppresses full page reload when SSE is healthy', async () => {
  let calls = 0; let closed = 0
  const page = {
    isClosed: () => false, url: () => 'http://127.0.0.1:19000/',
    setRequestInterception: async () => {}, on: () => {},
    goto: async () => ({ status: () => 200 }),
    evaluate: async fn => { assert.equal(typeof fn, 'function'); calls++; return true },
    reload: async () => { assert.fail('must not navigate on native HMR') },
  }
  const handle = await startDevBrowser({ ...target, reloadMode: 'native-hmr' }, {
    loadPuppeteer: async () => ({ launch: async () => ({
      newPage: async () => page, close: async () => { closed++ },
    }) }),
  })
  await handle.reload()
  await handle.close()
  assert.equal(calls, 1)
  assert.equal(closed, 1)
  assert.throws(() => validateDevTarget(target.url, target.chrome, 'nonsense'), /Unsupported/)
})

test('native HMR fails closed and releases its private Chrome when DSH SSE is absent', async () => {
  let closed = 0
  await assert.rejects(startDevBrowser({ ...target, reloadMode: 'native-hmr' }, {
    loadPuppeteer: async () => ({ launch: async () => ({
      newPage: async () => ({
        isClosed: () => false, url: () => 'http://127.0.0.1:19000/',
        setRequestInterception: async () => {}, on: () => {},
        goto: async () => ({status: () => 200}), evaluate: async () => false,
      }), close: async () => { closed++ },
    }) }),
  }), /Native DSH Web HMR is unavailable/)
  assert.equal(closed, 1)
})
