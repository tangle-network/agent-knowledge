import {readFileSync, writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import YAML from 'yaml'

const name = '@tangle-network/tcloud'
const expected = 'sha512-ENaiYkwmb4Tl7A6lGB/I2+DB32ryxRL7b02SQSj+Go+TrAl2SXabCUTsVZ2G7ZL73T5bWYY5iszLIhh8A5yg3g=='
const bytes = readFileSync(process.env.TCLOUD_CANDIDATE)
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
assert.equal(integrity, expected, 'SDK candidate differs from the recorded build artifact')
const lock = YAML.parse(readFileSync('pnpm-lock.yaml', 'utf8'))
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
next.packages[name + '@0.6.0'].resolution = {
  integrity,
  tarball: 'https://registry.npmjs.org/@tangle-network/tcloud/-/tcloud-0.6.0.tgz',
}
assert.ok(!JSON.stringify(next).includes(oldVersion))
writeFileSync('pnpm-lock.yaml', YAML.stringify(next, {lineWidth: 0}))
const manifest = JSON.parse(readFileSync('package.json','utf8'))
manifest.dependencies[name] = '>=0.6.0 <0.7.0'
writeFileSync('package.json', JSON.stringify(manifest,null,2)+'\n')
console.log(JSON.stringify({sdk: name, version:'0.6.0', integrity, sdkSource:'150259c31d3bd03a99e18fa51ffc62cd31fa98e7', published:false, registryActivation:'publish the exact reviewed candidate first'}))
