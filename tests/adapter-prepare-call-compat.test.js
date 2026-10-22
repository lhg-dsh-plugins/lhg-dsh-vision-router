import test from 'node:test'
import assert from 'node:assert/strict'

import {
  contextWithCoalescedAdapterUpdates,
  ensureAdapterContracts,
  ensureAdapterPrepareCall,
} from '../lib/adapter-update-coalescer.js'
import {
  contextWithVisionRuntimePerformance,
  createVisionRuntimePerformanceStore,
  withVisionRuntimePerformanceScope,
} from '../lib/vision-runtime-performance.js'

test('legacy Vision Router adapter gains DSH 0.1.1 prepareCall semantics', async () => {
  const calls = []
  const legacy = {
    async resolveModel(provider, model, signal) {
      calls.push(['resolve', provider, model, signal])
      return { provider, id: model, name: 'Legacy twin', inputModalities: ['text', 'image'] }
    },
    async *stream(options) {
      calls.push(['stream', options])
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const signal = new AbortController().signal

  const adapted = ensureAdapterPrepareCall(legacy)
  assert.equal(adapted, legacy, 'extensible plugin adapters keep their registration identity')
  assert.equal(typeof adapted.prepareCall, 'function')

  const prepared = await adapted.prepareCall('opencode-go-vision', 'qwen3.6-plus', signal)
  assert.deepEqual(prepared.model, {
    provider: 'opencode-go-vision',
    id: 'qwen3.6-plus',
    name: 'Legacy twin',
    inputModalities: ['text', 'image'],
  })

  const chunks = []
  for await (const chunk of prepared.stream({ provider: 'opencode-go-vision', model: 'qwen3.6-plus' })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks, [{ type: 'finish', reason: { kind: 'stop' } }])
  assert.equal(calls[0][0], 'resolve')
  assert.equal(calls[0][3], signal)
  assert.equal(calls[1][0], 'stream')
})

test('native prepareCall implementations remain authoritative', async () => {
  const nativePrepareCall = async () => ({
    model: { provider: 'native', id: 'm', name: 'native' },
    stream: async function* () {},
  })
  const adapter = {
    prepareCall: nativePrepareCall,
    async *stream() {},
  }

  assert.equal(ensureAdapterPrepareCall(adapter), adapter)
  assert.equal(adapter.prepareCall, nativePrepareCall)
})

test('frozen legacy adapters use a compatibility proxy without mutation', async () => {
  const legacy = Object.freeze({
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const adapted = ensureAdapterPrepareCall(legacy)
  assert.notEqual(adapted, legacy)
  assert.equal(Object.hasOwn(legacy, 'prepareCall'), false)
  const prepared = await adapted.prepareCall('vision-http', 'free-model')
  assert.deepEqual(prepared.model, {
    provider: 'vision-http',
    id: 'free-model',
    name: 'free-model',
  })
})

test('DSH 0.1.2 imageRequestPricing compatibility uses the base-class undefined default', () => {
  const adapter = {
    async *stream() {},
  }
  const beforeKeys = Object.keys(adapter)

  const adapted = ensureAdapterContracts(adapter, { imageRequestPricing: true })
  assert.equal(adapted, adapter, 'extensible plugin adapters keep their registration identity')
  assert.equal(typeof adapted.imageRequestPricing, 'function')
  assert.equal(adapted.imageRequestPricing('deepseek-vision', 'deepseek-v4-pro'), undefined)
  assert.deepEqual(Object.keys(adapter), beforeKeys, 'compat methods stay non-enumerable like base-class methods')
})

test('declared imageRequestPricing remains authoritative and is never replaced by compat', () => {
  const pricing = { priceImages: () => [] }
  const declared = (provider, model) => provider === 'native-mm' && model === 'vision' ? pricing : undefined
  const adapter = {
    imageRequestPricing: declared,
    async *stream() {},
  }

  const adapted = ensureAdapterContracts(adapter, { imageRequestPricing: true })
  assert.equal(adapted, adapter)
  assert.equal(adapted.imageRequestPricing, declared)
  assert.equal(adapted.imageRequestPricing('native-mm', 'vision'), pricing)
})

test('non-function imageRequestPricing is repaired before DSH can call it', () => {
  const adapter = {
    imageRequestPricing: null,
    async *stream() {},
  }

  const adapted = ensureAdapterContracts(adapter, { imageRequestPricing: true })
  assert.equal(adapted, adapter)
  assert.equal(typeof adapted.imageRequestPricing, 'function')
  assert.equal(adapted.imageRequestPricing('vision-http', 'm'), undefined)
})

test('frozen adapters gain both DSH adapter contracts through one compatibility proxy', async () => {
  const legacy = Object.freeze({
    async *stream() {
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const adapted = ensureAdapterContracts(legacy, { imageRequestPricing: true })
  assert.notEqual(adapted, legacy)
  assert.equal(Object.hasOwn(legacy, 'prepareCall'), false)
  assert.equal(Object.hasOwn(legacy, 'imageRequestPricing'), false)
  assert.equal(typeof adapted.prepareCall, 'function')
  assert.equal(typeof adapted.imageRequestPricing, 'function')
  assert.equal(adapted.imageRequestPricing('vision-chain', 'm'), undefined)
  const prepared = await adapted.prepareCall('vision-chain', 'm')
  assert.equal(prepared.model.provider, 'vision-chain')
  assert.equal(prepared.model.id, 'm')
})

test('coalesced Vision Router context adapts only registrations made through its llm view', async () => {
  const registrations = []
  const llm = {
    registerAdapter(providers, adapter) {
      registrations.push({ providers, adapter })
      return () => {}
    },
  }
  const ctx = {
    llm,
    on() { return () => {} },
  }
  const wrapped = contextWithCoalescedAdapterUpdates(ctx)

  const pluginAdapter = {
    async resolveModel(provider, model) { return { provider, id: model, name: model } },
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  }
  wrapped.llm.registerAdapter(['deepseek-vision'], pluginAdapter)
  assert.equal(typeof registrations[0].adapter.prepareCall, 'function')
  assert.equal(
    typeof registrations[0].adapter.imageRequestPricing,
    'undefined',
    'pre-0.1.2 Hosts must keep the historical adapter shape',
  )
  await assert.doesNotReject(() => registrations[0].adapter.prepareCall('deepseek-vision', 'deepseek-v4-pro'))

  const foreignAdapter = { async *stream() {} }
  llm.registerAdapter(['foreign'], foreignAdapter)
  assert.equal(typeof registrations[1].adapter.prepareCall, 'undefined')
  assert.equal(typeof registrations[1].adapter.imageRequestPricing, 'undefined')
})

test('DSH 0.1.2 token-meter calls cannot crash on any Vision Router duck-typed route', () => {
  const registrations = new Map()
  const llm = {
    registerAdapter(providers, adapter) {
      for (const provider of providers) registrations.set(provider, adapter)
      return () => {}
    },
    imageRequestPricing(provider, model) {
      return registrations.get(provider)?.imageRequestPricing(provider, model)
    },
  }
  const ctx = {
    llm,
    on() { return () => {} },
  }
  const wrapped = contextWithCoalescedAdapterUpdates(ctx)
  const routes = [
    'deepseek-official-native',
    'deepseek-official',
    'vision-http',
    'deepseek-vision',
    'vendor-vision',
    'vision-chain',
  ]

  for (const route of routes) {
    wrapped.llm.registerAdapter([route], { async *stream() {} })
  }

  for (const route of routes) {
    assert.doesNotThrow(() => llm.imageRequestPricing(route, 'model'))
    assert.equal(llm.imageRequestPricing(route, 'model'), undefined)
  }

  const foreign = { async *stream() {} }
  llm.registerAdapter(['foreign'], foreign)
  assert.equal(typeof foreign.imageRequestPricing, 'undefined', 'foreign registrations are never mutated')
  assert.throws(
    () => llm.imageRequestPricing('foreign', 'model'),
    /imageRequestPricing is not a function/,
    'the fixture reproduces the exact Host failure outside the scoped compat boundary',
  )
})

test('explicit route-owned image pricing survives registration through the DSH 0.1.2 seam', () => {
  const registrations = new Map()
  const llm = {
    registerAdapter(providers, adapter) {
      for (const provider of providers) registrations.set(provider, adapter)
      return () => {}
    },
    imageRequestPricing(provider, model) {
      return registrations.get(provider)?.imageRequestPricing(provider, model)
    },
  }
  const wrapped = contextWithCoalescedAdapterUpdates({ llm, on() { return () => {} } })
  const pricing = { priceImages: () => [] }
  const adapter = {
    imageRequestPricing(provider, model) {
      return provider === 'native-mm' && model === 'vision' ? pricing : undefined
    },
    async *stream() {},
  }

  wrapped.llm.registerAdapter(['native-mm'], adapter)
  assert.equal(llm.imageRequestPricing('native-mm', 'vision'), pricing)
})

test('DSH 0.1.1 prepareCall compatibility composes with runtime performance observation', async () => {
  let time = 1_000
  const now = () => time
  const registrations = []
  const base = {
    on() { return () => {} },
    llm: {
      registerAdapter(providers, adapter) {
        registrations.push({ providers, adapter })
        return () => {}
      },
      async *stream() {
        time += 240
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const coalesced = contextWithCoalescedAdapterUpdates(base)
  const store = createVisionRuntimePerformanceStore({ now, minSamples: 1 })
  const observed = contextWithVisionRuntimePerformance(coalesced, store, {
    now,
    observationAllowed: () => true,
  })

  observed.llm.registerAdapter(['deepseek-vision'], {
    async resolveModel(provider, model) { return { provider, id: model, name: model } },
    async *stream() { yield { type: 'finish', reason: { kind: 'stop' } } },
  })
  assert.equal(typeof registrations[0].adapter.prepareCall, 'function')

  await withVisionRuntimePerformanceScope('vision_ocr', {}, async () => {
    for await (const _chunk of observed.llm.stream({ provider: 'p', model: 'm' })) {
      // consume exact observed stream
    }
  })
  assert.equal(store.get('p/m').runtimeLatencyMsByAxis.ocr, 240)
})

test('DSH 0.2.1 imageRequestTarget defaults to normalized image identity without changing legacy adapters', () => {
  const adapter = { async *stream() {} }
  const beforeKeys = Object.keys(adapter)
  assert.equal(ensureAdapterContracts(adapter), adapter)
  assert.equal('imageRequestTarget' in adapter, false, 'legacy Host does not require the new method')
  const adapted = ensureAdapterContracts(adapter, { imageRequestTarget: true })
  assert.equal(adapted, adapter)
  assert.deepEqual(adapted.imageRequestTarget('vision-http', 'model', {
    width: 2048, height: 1024, bytes: 512_000,
  }), { width: 2048, height: 1024, maxBytes: 512_000 })
  assert.deepEqual(Object.keys(adapter), beforeKeys, 'compat method must be non-enumerable')
})

test('DSH 0.2.1 imageRequestTarget preserves explicit route projection', () => {
  const projection = { width: 768, height: 768, maxBytes: 200_000 }
  const native = (_provider, _model, _image) => projection
  const adapter = { imageRequestTarget: native, async *stream() {} }
  const adapted = ensureAdapterContracts(adapter, { imageRequestPricing: true, imageRequestTarget: true })
  assert.equal(adapted, adapter)
  assert.equal(adapted.imageRequestTarget, native)
  assert.equal(adapted.imageRequestTarget('vendor', 'visual', { width: 3000, height: 3000, bytes: 999_999 }), projection)
})

test('DSH 0.2.1 frozen adapters receive all three methods through one scoped proxy', async () => {
  const adapter = Object.freeze({ async *stream() {} })
  const adapted = ensureAdapterContracts(adapter, { imageRequestPricing: true, imageRequestTarget: true })
  assert.notEqual(adapted, adapter)
  assert.equal(adapted, ensureAdapterContracts(adapter, { imageRequestPricing: true, imageRequestTarget: true }))
  assert.equal(Object.hasOwn(adapter, 'imageRequestTarget'), false)
  assert.equal(typeof adapted.prepareCall, 'function')
  assert.equal(adapted.imageRequestPricing('vision', 'model'), undefined)
  assert.deepEqual(adapted.imageRequestTarget('vision', 'model', { width: 20, height: 10, bytes: 100 }),
    { width: 20, height: 10, maxBytes: 100 })
  const prepared = await adapted.prepareCall('vision', 'model')
  assert.equal(prepared.model.id, 'model')
})

test('DSH 0.2.1 imageRequestTarget is scoped to DVR registrations and gated by Host capability', () => {
  const registered = new Map()
  const llm = {
    registerAdapter(providers, adapter) {
      for (const provider of providers) registered.set(provider, adapter)
      return () => {}
    },
    imageRequestTarget(provider, model, image) {
      return registered.get(provider).imageRequestTarget(provider, model, image)
    },
  }
  const wrapped = contextWithCoalescedAdapterUpdates({ llm, on() { return () => {} } })
  wrapped.llm.registerAdapter(['vision-http'], { async *stream() {} })
  assert.deepEqual(llm.imageRequestTarget('vision-http', 'model', { width: 300, height: 200, bytes: 40_000 }),
    { width: 300, height: 200, maxBytes: 40_000 })
  const foreign = { async *stream() {} }
  llm.registerAdapter(['foreign'], foreign)
  assert.equal(typeof foreign.imageRequestTarget, 'undefined')
  assert.throws(() => llm.imageRequestTarget('foreign', 'model', { width: 1, height: 1, bytes: 1 }),
    /imageRequestTarget is not a function/)
})
