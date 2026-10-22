import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { publishVerifiedArtifacts, stagedBuild } from '../scripts/dev-staged-build.mjs'

const oldClient = "window.__ModuleLoader__.load({ id: 'dsh-vision-router', factory: () => 'old' })"
const newClient = "window.__ModuleLoader__.load({ id: 'dsh-vision-router', factory: () => 'new' })"

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dvr-stage-unit-'))
  const stage = join(root, 'stage')
  const dest = join(root, 'destination')
  await mkdir(join(stage, 'lib'), { recursive: true })
  await mkdir(join(dest, 'lib'), { recursive: true })
  await writeFile(join(dest, 'lib/client.js'), oldClient)
  await writeFile(join(dest, 'lib/stale.js'), 'obsolete generated file')
  await writeFile(join(dest, 'entry.js'), 'old entry')
  await writeFile(join(stage, 'entry.js'), 'new entry')
  await writeFile(join(stage, 'index.js'), 'new index')
  await writeFile(join(stage, 'lib/helper.js'), 'new helper')
  await writeFile(join(stage, 'lib/client.js'), newClient)
  try { await fn({ stage, dest, root }) }
  finally { await rm(root, { force: true, recursive: true }) }
}

test('verified artifacts atomically publish client.js last and remove stale runtime siblings', async () => {
  await fixture(async ({ stage, dest }) => {
    const writes = []
    await publishVerifiedArtifacts(stage, dest, {
      async afterWrite(path) {
        writes.push(path)
        if (path !== join('lib', 'client.js')) {
          assert.equal(await readFile(join(dest, 'lib/client.js'), 'utf8'), oldClient)
        }
      },
    })
    assert.equal(writes.at(-1), join('lib', 'client.js'))
    assert.equal(await readFile(join(dest, 'lib/client.js'), 'utf8'), newClient)
    assert.equal(await readFile(join(dest, 'lib/helper.js'), 'utf8'), 'new helper')
    assert.equal(await readFile(join(dest, 'entry.js'), 'utf8'), 'new entry')
    assert.deepEqual((await readdir(join(dest, 'lib'))).sort(), ['client.js', 'helper.js'])
  })
})

test('bad stage fails before mutating live Client or other artifacts', async () => {
  await fixture(async ({ stage, dest }) => {
    await writeFile(join(stage, 'lib/client.js'), 'broken Client')
    await assert.rejects(publishVerifiedArtifacts(stage, dest), /factory is invalid/)
    assert.equal(await readFile(join(dest, 'lib/client.js'), 'utf8'), oldClient)
    assert.equal(await readFile(join(dest, 'entry.js'), 'utf8'), 'old entry')
    assert.equal(await readFile(join(dest, 'lib/stale.js'), 'utf8'), 'obsolete generated file')
  })
})

test('failed compilation or staged verification never publishes any live artifacts', async () => {
  await fixture(async ({ dest, root }) => {
    // `root` is also the live-output root for this code path.
    await writeFile(join(root, 'entry.js'), 'old root entry')
    await mkdir(join(root, 'lib'), {recursive:true})
    await writeFile(join(root, 'lib/client.js'), oldClient)
    for (const message of ['compilation failed', 'staged artifact map failed']) {
      const steps = []
      await assert.rejects(stagedBuild(root, async (script, args) => {
        steps.push(script)
        if (script.includes('build-source') && message.includes('compilation')) throw Error(message)
        if (script.includes('verify-source')) throw Error(message)
      }),new RegExp(message))
      assert.equal(await readFile(join(root, 'lib/client.js'), 'utf8'), oldClient)
      assert.equal(await readFile(join(root, 'entry.js'), 'utf8'), 'old root entry')
      const orphans = (await readdir(root)).filter(x => x.startsWith('.dvr-hmr-stage-'))
      assert.deepEqual(orphans, [])
      assert.ok(steps.length > 0)
    }
  })
})
