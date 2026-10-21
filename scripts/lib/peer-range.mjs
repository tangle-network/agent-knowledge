import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * npm's caret rule for which versions a range admits, and the Eval
 * compatibility that package.json owns.
 *
 * From 1.0.0 a package states that a minor is additive, a patch is a fix, and
 * only a major removes or narrows, so a caret range holds one installed copy
 * across every later minor. A pre-1.0 package states no such promise: npm locks
 * a 0.x caret to its minor and a 0.0.z caret to its patch, so a pre-1.0
 * dependency such as Eval declares a bounded `>=A <B` range instead.
 */

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
const rootPackagePath = fileURLToPath(new URL('../../package.json', import.meta.url))

/** A `>=A <B` range admits a release version: A <= version < B. */
function boundedRange(range) {
  const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range ?? '')
  if (match === null) {
    throw new Error(`${evalPackage} peer range must read >=A <B: ${range}`)
  }
  return { floor: readVersion(match[1]), ceiling: readVersion(match[2]) }
}

function rangeAdmits({ floor, ceiling }, version) {
  const release = readVersion(version)
  return compareVersion(release, floor) >= 0 && compareVersion(release, ceiling) < 0
}

/**
 * package.json owns Eval compatibility: the peer range and the exact
 * development pin. The supported minors run from the range's floor through the
 * pin's minor, each at x.y.0, with the pin itself as the last.
 */
function readEvalCompatibility(packagePath) {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  const peerRange = manifest.peerDependencies?.[evalPackage]
  const developmentPin = manifest.devDependencies?.[evalPackage]
  const range = boundedRange(peerRange)
  if (!/^\d+\.\d+\.\d+$/.test(developmentPin ?? '')) {
    throw new Error(`${evalPackage} must have one exact development pin: ${developmentPin}`)
  }
  if (!rangeAdmits(range, developmentPin)) {
    throw new Error(`${evalPackage} development pin ${developmentPin} is outside peer range ${peerRange}`)
  }
  const [major, floorMinor] = range.floor
  const [pinMajor, pinMinor] = readVersion(developmentPin)
  if (pinMajor !== major) {
    throw new Error(`${evalPackage} peer range ${peerRange} spans majors; list its minors by major`)
  }
  const versions = []
  for (let minor = floorMinor; minor < pinMinor; minor += 1) {
    versions.push(`${major}.${minor}.0`)
  }
  versions.push(developmentPin)
  return { peerRange, range, versions }
}

/** Supported Eval minors, exercised by the packed-consumer and optimizer checks. */
export function evalCompatibilityVersions(packagePath = rootPackagePath) {
  return Object.freeze(readEvalCompatibility(packagePath).versions)
}

export function evalCompatibility(
  developmentVersion,
  requestedVersion = developmentVersion,
  packagePath = rootPackagePath,
) {
  const { peerRange, range, versions } = readEvalCompatibility(packagePath)
  if (!rangeAdmits(range, developmentVersion) || developmentVersion !== versions.at(-1)) {
    throw new Error(`unverified Eval development version: ${developmentVersion} (peer range ${peerRange})`)
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(requestedVersion) ||
    !versions.some((version) => caretAdmits(`^${readVersion(version).slice(0, 2).join('.')}.0`, requestedVersion))
  ) {
    throw new Error(`unsupported Eval compatibility test version: ${requestedVersion}`)
  }
  return { version: requestedVersion, peerRange }
}
