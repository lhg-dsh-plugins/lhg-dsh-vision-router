// Loads the generated activation entry in a child process where the optional peers
// are unresolvable (see block-optional-peers.mjs). Prints LOADED or exits non-zero.
import { register } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

register('./block-optional-peers.mjs', import.meta.url)
const target = process.argv[2]
if (!target) throw new Error('usage: activation-load-probe.mjs <absolute module path>')
const namespace = await import(pathToFileURL(path.resolve(target)).href)
console.log('LOADED ' + Object.keys(namespace).length + ' exports')
