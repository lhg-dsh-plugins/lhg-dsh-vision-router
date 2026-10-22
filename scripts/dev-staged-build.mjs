/**
 * Developer-only safe publication of DVR artifacts for upstream Web HMR.
 * The production `pnpm build` pipeline is deliberately unchanged.
 *
 * Invariant: failed compilation or verification never touches live
 * entry.js/index.js/lib/, and the HMR-observed lib/client.js is published last.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLIENT = join('lib', 'client.js')

async function filesUnder(root, folder = root) {
  const files = []
  async function walk(dir) {
    for (const row of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, row.name)
      if (row.isDirectory()) await walk(file)
      else if (row.isFile()) files.push(relative(folder, file))
      else throw new Error(`Unsafe staged artifact type: ${row.name}`)
    }
  }
  await walk(root)
  return files.sort()
}

async function atomicCopy(from, to) {
  await mkdir(dirname(to), { recursive: true })
  const temporary = `${to}.dvr-hmr-${process.pid}-${randomUUID()}`
  try {
    await copyFile(from, temporary)
    await rename(temporary, to)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Publish a previously verified artifact tree; do not use for unchecked input. */
export async function publishVerifiedArtifacts(stage, dest, { afterWrite } = {}) {
  const files = await filesUnder(stage)
  if (!files.includes(CLIENT) || !files.includes('entry.js') || !files.includes('index.js')) {
    throw new Error('Staged package entrypoints are missing; live artifacts unchanged')
  }
  const content = await readFile(join(stage, CLIENT), 'utf8')
  if (!content.includes('window.__ModuleLoader__.load(') ||
      !content.includes("id: 'dsh-vision-router'")) {
    throw new Error('Staged Client factory is invalid; live artifacts unchanged')
  }
  // The verified entry stays unchanged while every sibling is published.
  // DSH's HMR stat watcher is keyed to lib/client.js, so publish it LAST.
  for (const path of files.filter(f => f !== CLIENT)) {
    await atomicCopy(join(stage, path), join(dest, path))
    await afterWrite?.(path)
  }
  // Drop stale generated siblings before publishing the new Client revision.
  const liveFiles = [
    'entry.js', 'index.js',
    ...(await filesUnder(join(dest, 'lib')).then(x=>x.map(f=>join('lib',f))).catch(err=> {
      if (err.code === 'ENOENT') return []
      throw err
    })),
  ]
  const current = new Set(files)
  for (const file of liveFiles) {
    if (!current.has(file)) await rm(join(dest, file), { force: true })
  }
  await atomicCopy(join(stage, CLIENT), join(dest, CLIENT))
  await afterWrite?.(CLIENT)
}

export function runNode(script, args = [], cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${script} failed: ${signal ?? code}`)))
  })
}

export async function stagedBuild(root = ROOT, run = runNode) {
  // On the same filesystem as the destination, allowing atomic file renames
  // on Windows as well as macOS/Linux. This folder is not watched by dev:web.
  const stage = await mkdtemp(join(root, '.dvr-hmr-stage-'))
  try {
    await run('scripts/build-source-artifacts.mjs', ['--out-dir', stage], root)
    await run('scripts/verify-source-artifact-map.mjs', ['--artifact-root', stage], root)
    await publishVerifiedArtifacts(stage, root)
  } finally {
    await rm(stage, { force: true, recursive: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stagedBuild()
}
