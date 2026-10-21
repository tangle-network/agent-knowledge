/**
 * The range shape a dependency earns from its own versioning, and npm's rule
 * for which versions that shape admits.
 *
 * From 1.0.0 a package states that a minor is additive, a patch is a fix, and
 * only a major removes or narrows, so a caret range holds one installed copy
 * across every later minor. A pre-1.0 package states no such promise: npm locks
 * a 0.x caret to its minor and a 0.0.z caret to its patch, so the range for a
 * pre-1.0 dependency stops at the next minor instead.
 */

import { readFileSync } from 'node:fs'

function readVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (match === null) {
    throw new Error(`cannot read version ${version}`)
  }
  return match.slice(1, 4).map(Number)
}

function compareVersion(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}

function exactMinorPeerRange(version) {
  const [major, minor] = readVersion(version)
  return `>=${version} <${major}.${minor + 1}.0`
}

export function expectedPeerRange(version) {
  return readVersion(version)[0] >= 1 ? `^${version}` : exactMinorPeerRange(version)
}

/** The exclusive upper bound of a caret floor, under npm's rule. */
function caretUpperBound([major, minor, patch]) {
  if (major > 0) return [major + 1, 0, 0]
  if (minor > 0) return [0, minor + 1, 0]
  return [0, 0, patch + 1]
}

/**
 * A caret range admits an installed version.
 *
 * The version is compared by its release part, so a prerelease of an admitted
 * version counts as admitted: the guards that call this assert one physical
 * copy of a contract package, and a prerelease build of that copy speaks the
 * same surface.
 */
export function caretAdmits(range, version) {
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  if (caret === null) return false
  let installed
  try {
    installed = readVersion(version)
  } catch {
    return false
  }
  const floor = caret.slice(1).map(Number)
  return (
    compareVersion(installed, floor) >= 0 &&
    compareVersion(installed, caretUpperBound(floor)) < 0
  )
}

const evalPackage = '@tangle-network/agent-eval'
const sourcePackage = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

/**
 * The Eval peer range in package.json owns the supported cohort, so a stack
 * adoption that pins a new Eval minor and widens the range to include it
 * changes the cohort with no second edit here. The floor stays where a person
 * set it; each minor from the floor through the development pin is exercised
 * by the packed-consumer and optimizer checks, the newest at the pin itself.
 */
function readEvalCohort(range, developmentVersion) {
  const match = /^>=(0\.(\d+)\.\d+) <0\.(\d+)\.0$/.exec(range ?? '')
  if (match === null) {
    throw new Error(`${evalPackage} peer range must read >=0.a.b <0.c.0: ${range}`)
  }
  const [, floor, floorMinor, upperMinor] = match
  const development = readVersion(developmentVersion ?? '')
  const [devMajor, devMinor] = development
  if (devMajor !== 0 || devMinor !== Number(upperMinor) - 1 || compareVersion(development, readVersion(floor)) < 0) {
    throw new Error(`unverified Eval development version ${developmentVersion} for peer range ${range}`)
  }
  const versions = []
  for (let minor = Number(floorMinor); minor < devMinor; minor += 1) {
    versions.push(versions.length === 0 ? floor : `0.${minor}.0`)
  }
  versions.push(developmentVersion)
  return versions
}

const evalPeerRange = sourcePackage.peerDependencies?.[evalPackage]

/** Supported Eval minors are exercised by the packed-consumer and optimizer checks. */
export const evalCompatibilityVersions = Object.freeze(
  readEvalCohort(evalPeerRange, sourcePackage.devDependencies?.[evalPackage]),
)

export function evalCompatibility(developmentVersion, requestedVersion = developmentVersion) {
  const versions = evalCompatibilityVersions
  if (developmentVersion !== versions.at(-1)) {
    throw new Error(`unverified Eval development version: ${developmentVersion}`)
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(requestedVersion) ||
    !versions.some((version) => caretAdmits(`^${readVersion(version).slice(0, 2).join('.')}.0`, requestedVersion))
  ) {
    throw new Error(`unsupported Eval compatibility test version: ${requestedVersion}`)
  }
  return { version: requestedVersion, peerRange: evalPeerRange }
}
