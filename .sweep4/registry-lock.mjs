import {readFileSync, writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import YAML from 'yaml'

const name = '@tangle-network/tcloud'
const expected = 'sha512-mu/PLUh/2+Cezg8lthrGDenzSnKIhN6crGNGZX+JSUIr74x7vH1M63rFNW6NH0yKpgVzv/lgnZTCBXQbZhX0PA=='
const bytes = readFileSync(process.env.TCLOUD_CANDIDATE)
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
assert.equal(integrity, expected, 'SDK candidate differs from the recorded build artifact')
const raw = readFileSync('pnpm-lock.yaml', 'utf8')
const lock = YAML.parse(raw)
const old = Object.keys(lock.packages).find(k => k.startsWith(name + '@file:'))
assert.ok(old, 'missing installed SDK candidate')
assert.equal(lock.packages[old].resolution.integrity, integrity)
const oldVersion = old.slice(name.length + 1)
const rewrite = value => {
  if (typeof value === 'string') return value.replaceAll(oldVersion, '0.6.0')
  if (Array.isArray(value)) return value.map(rewrite)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k.replaceAll(oldVersion, '0.6.0'), rewrite(v)]))
  return value
}
const next = rewrite(lock)
next.importers['.'].dependencies[name].specifier = '>=0.6.0 <0.7.0'
const tarball = 'https://registry.npmjs.org/@tangle-network/tcloud/-/tcloud-0.6.0.tgz'
next.packages[name + '@0.6.0'].resolution = { integrity, tarball }
// Preserve pnpm's generated formatting. Validate the small text edit against the
// complete parsed transformation so no other importer or snapshot can drift.
let output = raw.replaceAll(oldVersion, '0.6.0')
output = output.replace(/(      '@tangle-network\/tcloud':\n        specifier: )[^\n]+/, "$1'>=0.6.0 <0.7.0'")
output = output.replace(/(  '@tangle-network\/tcloud@0\.6\.0':\n)    resolution: [^\n]+/, `$1    resolution: {integrity: ${integrity}, tarball: ${tarball}}`)
assert.deepEqual(YAML.parse(output), next, 'registry lock text transformation changed unrelated data')
assert.ok(!output.includes(oldVersion))
writeFileSync('pnpm-lock.yaml', output)
const manifest = JSON.parse(readFileSync('package.json','utf8'))
manifest.dependencies[name] = '>=0.6.0 <0.7.0'
writeFileSync('package.json', JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({sdk: name, version:'0.6.0', integrity, sdkSource:'1ed385a057291be2f2d11679409c0a9d094524bf', published:false, registryActivation:'publish the exact reviewed candidate first'}))
