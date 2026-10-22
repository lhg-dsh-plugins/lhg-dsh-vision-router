import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshRoot = resolve(process.env.DSH_SOURCE_ROOT || '')
const dvrRoot = resolve(process.env.DVR_SOURCE_ROOT || '')
if (!process.env.DSH_SOURCE_ROOT) throw new Error('DSH_SOURCE_ROOT is required')
if (!process.env.DVR_SOURCE_ROOT) throw new Error('DVR_SOURCE_ROOT is required')

const manifest = JSON.parse(await readFile(join(dvrRoot, 'package.json'), 'utf8'))
const compatibilityModule = pathToFileURL(join(
  dshRoot,
  'packages/boot/app-boot/src/plugin-compatibility.ts',
)).href
const { evaluatePluginCompatibility } = await import(compatibilityModule)

const declaredDshPeers = Object.keys(manifest.peerDependencies ?? {})
  .filter((name) => name.startsWith('@deepseek-ai/dsh-'))
  .sort()

assert.ok(
  declaredDshPeers.length > 0,
  'DVR manifest must declare at least one DSH Host peer for train admission',
)

const declaredDshRanges = new Set(declaredDshPeers.map((name) => manifest.peerDependencies[name]))
assert.equal(declaredDshRanges.size, 1, 'DSH peers must agree on one support window')
const declaredDshRange = [...declaredDshRanges][0]
assert.equal(
  manifest.engines?.dsh,
  declaredDshRange,
  'engines.dsh and legacy DSH peers must preserve the same public support window',
)

const admitted = [
  // DVR 2.3 supports the 0.1.x line continuously from the first 0.1.5
  // release candidate; later 0.1.x releases are not enumerated exceptions.
  '0.1.5-rc.1',
  '0.1.5-rc.3',
  '0.1.6-alpha.1',
  '0.1.7-rc.2',
  '0.1.99',
  // The 0.2.x train is admitted from the exact rc.2 boundary that DVR
  // validates across source, browser, and Desktop contracts.
  '0.2.0-rc.2',
  '0.2.0',
  '0.2.1-alpha.1',
  '0.2.1-alpha.4',
  '0.2.1-alpha.5',
  '0.2.1-rc.1',
  '0.2.1',
  '0.2.99-rc.1',
  '0.2.99',
]
for (const runtimeVersion of admitted) {
  assert.equal(
    evaluatePluginCompatibility(manifest, {}, runtimeVersion),
    undefined,
    `DVR manifest must be admitted by DSH ${runtimeVersion}`,
  )
}

const rejected = [
  '0.1.4',
  '0.1.5-beta.1',
  '0.2.0-beta.1',
  '0.2.0-rc.0',
  '0.2.0-rc.1',
  '0.3.0-alpha.1',
  '0.3.0-beta.1',
  '0.3.0-rc.1',
  '0.3.0',
  '1.0.0',
]
for (const runtimeVersion of rejected) {
  const issue = evaluatePluginCompatibility(manifest, {}, runtimeVersion)
  assert.ok(issue, `DVR manifest must not pre-admit DSH ${runtimeVersion}`)
  // DSH alpha.4 uses engines.dsh as the sole canonical admission requirement.
  // Older supported Hosts still report individual DSH peer mismatches.
  // Test the real evaluator's refusal shape instead of coupling to one generation.
  const engineRequirements = issue.requirements
  if (engineRequirements !== undefined) {
    assert.deepEqual(
      engineRequirements,
      { 'engines.dsh': declaredDshRange },
      `DSH ${runtimeVersion} must reject only the declared engines.dsh window`,
    )
  } else {
    assert.deepEqual(
      Object.keys(issue.peers).sort(),
      declaredDshPeers,
      `DSH ${runtimeVersion} refusal must be caused only by DVR's declared DSH peers`,
    )
  }
}


// Explicitly characterize the 0.2.1-alpha.5 admission precedence instead of
// only testing manifests whose engines and peer ranges happen to agree. Older
// supported Hosts still consult peers; newer Hosts consult engines.dsh alone.
const firstDshPeer = declaredDshPeers[0]
const conflictingPeers = {
  ...manifest,
  peerDependencies: { ...manifest.peerDependencies, [firstDshPeer]: '<0.1.0' },
}
const alpha5Precedence = evaluatePluginCompatibility(conflictingPeers, {}, '0.2.1-alpha.5')
const rejectedWithEngine = evaluatePluginCompatibility({
  ...conflictingPeers,
  engines: { ...manifest.engines, dsh: '<0.1.0' },
}, {}, '0.2.1-alpha.5')
if (Object.hasOwn(evaluatePluginCompatibility(manifest, {}, '0.3.0') ?? {}, 'requirements')) {
  assert.equal(alpha5Precedence, undefined, 'new Host must prefer a valid engines.dsh over mismatched peers')
  assert.deepEqual(rejectedWithEngine?.requirements, { 'engines.dsh': '<0.1.0' },
    'new Host must report the canonical engine requirement when both declarations conflict')
} else {
  assert.equal(alpha5Precedence?.peers?.[firstDshPeer], '<0.1.0',
    'legacy Host must keep enforcing its declared DSH peers')
  assert.equal(rejectedWithEngine?.peers?.[firstDshPeer], '<0.1.0',
    'legacy Host must not silently switch admission authority to engines.dsh')
}

console.log(JSON.stringify({
  ok: true,
  admitted,
  rejected,
  declaredDshPeers,
}))
