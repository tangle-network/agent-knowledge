#!/usr/bin/env node
// The newest published @tangle-network/agent-eval patch of the minor that `x.y.z` names, from the npm registry.
// The publish workflow verifies each supported Eval minor at it, because an x.y.0 can be unpublished.
import { execFileSync } from 'node:child_process'

const [minor] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(minor ?? '')) throw new Error(`usage: newest-eval-patch.mjs <x.y.z>, got ${minor}`)
const [major, min] = minor.split('.')
const listed = JSON.parse(execFileSync('npm', ['view', `@tangle-network/agent-eval@~${major}.${min}.0`, 'version', '--json'], { encoding: 'utf8' }))
const versions = [].concat(listed)
if (versions.length === 0) throw new Error(`no published @tangle-network/agent-eval ${major}.${min}.x`)
const key = (v) => v.split('.').map(Number)
versions.sort((a, b) => { const [x, y] = [key(a), key(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] })
process.stdout.write(`${versions.at(-1)}\n`)
