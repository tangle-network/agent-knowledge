import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * npm's caret rule for which versions a range admits, and the Eval
 * compatibility that package.json owns.
 *
 * From 1.0.0 a package states that a minor is additive, a patch is a fix, and
 * only a major removes or narrows, so a caret range holds one installed copy
 * across every later minor. npm locks a 0.x caret to its minor and a 0.0.z
 * caret to its patch.
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

/**
 * package.json owns Eval compatibility: a caret peer range from 1.0.0 and the
 * exact development pin it admits. Eval states that a minor is additive, so the
 * packed-consumer and optimizer checks run at the range's floor and at the pin.
 */
function readEvalCompatibility(packagePath) {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  const peerRange = manifest.peerDependencies?.[evalPackage]
  const developmentPin = manifest.devDependencies?.[evalPackage]
  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(peerRange ?? '')
  if (caret === null || readVersion(caret[1])[0] < 1) {
    throw new Error(`${evalPackage} peer range must be a caret from 1.0.0: ${peerRange}`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(developmentPin ?? '')) {
    throw new Error(`${evalPackage} must have one exact development pin: ${developmentPin}`)
  }
  if (!caretAdmits(peerRange, developmentPin)) {
    throw new Error(`${evalPackage} development pin ${developmentPin} is outside peer range ${peerRange}`)
  }
  return { peerRange, versions: [...new Set([caret[1], developmentPin])] }
}

/** Supported Eval versions, exercised by the packed-consumer and optimizer checks. */
export function evalCompatibilityVersions(packagePath = rootPackagePath) {
  return Object.freeze(readEvalCompatibility(packagePath).versions)
}

export function evalCompatibility(
  developmentVersion,
  requestedVersion = developmentVersion,
  packagePath = rootPackagePath,
) {
  const { peerRange, versions } = readEvalCompatibility(packagePath)
  if (developmentVersion !== versions.at(-1)) {
    throw new Error(`unverified Eval development version: ${developmentVersion} (peer range ${peerRange})`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(requestedVersion) || !caretAdmits(peerRange, requestedVersion)) {
    throw new Error(`unsupported Eval compatibility test version: ${requestedVersion}`)
  }
  return { version: requestedVersion, peerRange }
}
