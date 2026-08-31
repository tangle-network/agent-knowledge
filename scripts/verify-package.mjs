import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { caretAdmits, expectedPeerRange } from './lib/peer-range.mjs'

const packageName = '@tangle-network/agent-knowledge'
const publicImports = [
  packageName,
  `${packageName}/viz`,
  `${packageName}/memory`,
  `${packageName}/sources`,
  `${packageName}/benchmarks`,
]
const requiredRootExports = [
  'createFileSystemSearchProvider',
  'optimizeKnowledgeBasePolicy',
  'runRagOptimization',
  'runRetrievalImprovementLoop',
  'runSerializedKnowledgeOptimization',
  'runVerifiedResearchLoop',
]
const forbiddenRootExports = [
  'boundedRetrievalConfigMethod',
  'buildBoundedRetrievalConfigs',
  'buildRetrievalParameterCandidates',
  'retrievalParameterSweepProposer',
  'runTwoAgentResearchLoop',
  'TwoAgentResearchLoopOptions',
  'TwoAgentResearchLoopResult',
  'TwoAgentResearchRound',
]
const forbiddenDeclarationNames = [
  'runTwoAgentResearchLoop',
  'TwoAgentResearchLoopOptions',
  'TwoAgentResearchLoopResult',
  'TwoAgentResearchRound',
]
// Packages that patch a Node builtin at MODULE scope. `graceful-fs` assigns
// `fs.close` / `fs.closeSync`; workerd exposes those as getter-only accessors,
// so the assignment throws while Cloudflare validates an uploaded Worker —
// `Cannot set property close of #<Object> which has only a getter [code:
// 10021]` — rejecting the entire Worker with no request frame and no way for
// the app to catch it. A STATIC import of any of these anywhere in the shipped
// bundle poisons every downstream Cloudflare consumer, whether or not it ever
// takes a lock; a dynamic `import()` does not, because the module scope only
// runs when the lock is actually needed. `wrangler deploy --dry-run` bundles
// without executing, so it is structurally blind to this class — this check is
// what stands in for it.
const edgeUnsafeStaticImports = ['proper-lockfile', 'graceful-fs']
const requiredMemoryExports = ['runAgentMemoryImprovement']
const requiredAgentEvalExports = ['gepaOptimizationMethod', 'skillOptOptimizationMethod']
const agentEvalPackage = '@tangle-network/agent-eval'
const agentCorePackage = '@tangle-network/agent-core'
const agentInterfacePackage = '@tangle-network/agent-interface'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const agentEvalVersion = exactDevelopmentPin(sourcePackage, agentEvalPackage)
const agentEvalPeerRange = expectedPeerRange(agentEvalVersion)
const agentInterfaceVersion = exactDevelopmentPin(sourcePackage, agentInterfacePackage)
const agentInterfacePeerRange = expectedPeerRange(agentInterfaceVersion)
const zodVersion = exactVersion(sourcePackage.dependencies?.zod, 'zod runtime dependency')
assertRequiredPeer(sourcePackage, agentEvalPackage, agentEvalPeerRange)
assertRequiredPeer(sourcePackage, agentInterfacePackage, agentInterfacePeerRange)
assertNoAgentStackOverrides(sourcePackage)
assertEdgeUnsafeStaticImportMatcher()
const tempRoot = mkdtempSync(join(tmpdir(), 'agent-knowledge-package-'))

try {
  const packDir = join(tempRoot, 'pack')
  const appDir = join(tempRoot, 'app')
  const repackDir = join(tempRoot, 'repack')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(appDir, { recursive: true })
  mkdirSync(repackDir, { recursive: true })
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'agent-knowledge-package-verification',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  )

  run('npm', ['pack', '--ignore-scripts=false', '--pack-destination', packDir], repoRoot)
  const sourceTarball = onlyTarball(packDir)

  run(
    'npm',
    [
      'install',
      '--ignore-scripts=false',
      '--no-package-lock',
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(tempRoot, 'npm-cache'),
      '--prefer-online',
      sourceTarball,
      `@tangle-network/agent-eval@${agentEvalVersion}`,
      `@tangle-network/agent-interface@${agentInterfaceVersion}`,
    ],
    appDir,
  )

  const installedPackageDir = join(appDir, 'node_modules', '@tangle-network', 'agent-knowledge')
  const installedPackage = JSON.parse(
    readFileSync(join(installedPackageDir, 'package.json'), 'utf8'),
  )
  if (existsSync(join(installedPackageDir, 'dist', 'two-agent-research-loop.d.ts'))) {
    throw new Error('published package includes the removed two-agent research module')
  }
  const installedDeclaration = readFileSync(
    join(installedPackageDir, 'dist', 'index.d.ts'),
    'utf8',
  )
  assertPortableDeclarations(join(installedPackageDir, 'dist'))
  for (const name of forbiddenDeclarationNames) {
    if (installedDeclaration.includes(name)) {
      throw new Error(`published declarations include obsolete export: ${name}`)
    }
  }
  assertNoEdgeUnsafeStaticImports(join(installedPackageDir, 'dist'))
  const installedAgentEval = JSON.parse(
    readFileSync(
      join(appDir, 'node_modules', '@tangle-network', 'agent-eval', 'package.json'),
      'utf8',
    ),
  )
  const installedAgentCore = JSON.parse(
    readFileSync(
      join(appDir, 'node_modules', '@tangle-network', 'agent-core', 'package.json'),
      'utf8',
    ),
  )
  const installedAgentInterface = JSON.parse(
    readFileSync(
      join(appDir, 'node_modules', '@tangle-network', 'agent-interface', 'package.json'),
      'utf8',
    ),
  )
  const installedZod = JSON.parse(
    readFileSync(join(appDir, 'node_modules', 'zod', 'package.json'), 'utf8'),
  )
  if (installedAgentEval.version !== agentEvalVersion) {
    throw new Error(
      `agent-eval version mismatch: installed=${installedAgentEval.version} expected=${agentEvalVersion}`,
    )
  }
  if (installedAgentInterface.version !== agentInterfaceVersion) {
    throw new Error(
      `agent-interface version mismatch: installed=${installedAgentInterface.version} expected=${agentInterfaceVersion}`,
    )
  }
  if (installedZod.version !== zodVersion) {
    throw new Error(`zod version mismatch: installed=${installedZod.version} expected=${zodVersion}`)
  }
  assertPublishedRequiredPeer(installedPackage, agentEvalPackage, agentEvalPeerRange)
  assertPublishedRequiredPeer(installedPackage, agentInterfacePackage, agentInterfacePeerRange)
  // The cohort is proven by the single installed copy, not by the specifier's
  // shape: a range that admits the installed version keeps one copy, while an
  // exact pin duplicates the package for a consumer already holding a later patch.
  assertCaretAdmits(
    installedAgentEval.dependencies?.[agentCorePackage],
    installedAgentCore.version,
    'agent-eval dependency on agent-core',
  )
  assertCaretAdmits(
    installedAgentEval.dependencies?.[agentInterfacePackage],
    agentInterfaceVersion,
    'agent-eval dependency on agent-interface',
  )
  assertCaretAdmits(
    installedAgentCore.dependencies?.[agentInterfacePackage],
    agentInterfaceVersion,
    'agent-core dependency on agent-interface',
  )
  assertSingleInstalledAgentStack(appDir, {
    [agentEvalPackage]: agentEvalVersion,
    [agentCorePackage]: installedAgentCore.version,
    [agentInterfacePackage]: agentInterfaceVersion,
    zod: zodVersion,
  })
  const installedSkill = readFileSync(
    join(installedPackageDir, 'skills', 'build-with-agent-knowledge', 'SKILL.md'),
    'utf8',
  )
  const installedFrontmatter = installedSkill
    .replace(/\r\n?/g, '\n')
    .match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1]
  const installedSkillName = installedFrontmatter
    ?.match(/^name:\s*["']?([^"'\n]+)["']?$/m)?.[1]
    ?.trim()
  if (installedSkillName !== 'build-with-agent-knowledge') {
    throw new Error(
      `published package has an invalid skill name: ${JSON.stringify(installedSkillName)}`,
    )
  }

  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        `const root = await import(${JSON.stringify(packageName)})`,
        `for (const name of ${JSON.stringify(requiredRootExports)}) {`,
        `  if (typeof root[name] !== 'function') throw new Error('missing root export: ' + name)`,
        `}`,
        `for (const name of ${JSON.stringify(forbiddenRootExports)}) {`,
        `  if (name in root) throw new Error('obsolete root export: ' + name)`,
        `}`,
        `const memory = await import(${JSON.stringify(`${packageName}/memory`)})`,
        `for (const name of ${JSON.stringify(requiredMemoryExports)}) {`,
        `  if (typeof memory[name] !== 'function') throw new Error('missing memory export: ' + name)`,
        `}`,
        `const campaign = await import('@tangle-network/agent-eval/campaign')`,
        `for (const name of ${JSON.stringify(requiredAgentEvalExports)}) {`,
        `  if (typeof campaign[name] !== 'function') throw new Error('missing agent-eval optimizer: ' + name)`,
        `}`,
        `for (const specifier of ${JSON.stringify(publicImports.slice(1).filter((specifier) => !specifier.endsWith('/memory')))}) await import(specifier)`,
      ].join(';'),
    ],
    appDir,
  )

  const cliName = process.platform === 'win32' ? 'agent-knowledge.cmd' : 'agent-knowledge'
  const cliVersion = run(join(appDir, 'node_modules', '.bin', cliName), ['version'], appDir).trim()
  if (cliVersion !== installedPackage.version) {
    throw new Error(
      `CLI version mismatch: expected ${installedPackage.version}, received ${JSON.stringify(cliVersion)}`,
    )
  }

  run(
    'npm',
    ['pack', '--ignore-scripts=false', '--pack-destination', repackDir],
    installedPackageDir,
  )
  onlyTarball(repackDir)

  process.stdout.write(
    `Verified ${packageName}@${installedPackage.version} with one installed copy each of agent-eval ${installedAgentEval.version}, agent-core ${installedAgentCore.version}, agent-interface ${installedAgentInterface.version}, and zod ${installedZod.version}: clean install, portable declarations, ${publicImports.length} imports, skill, CLI version, and re-pack.\n`,
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function assertNoAgentStackOverrides(packageManifest) {
  const stackPackages = [agentEvalPackage, agentCorePackage, agentInterfacePackage]
  const overrideEntries = Object.entries(packageManifest.pnpm?.overrides ?? {})
  const stackOverride = overrideEntries.find(([selector, replacement]) =>
    stackPackages.some(
      (packageName) =>
        selector.includes(packageName) || String(replacement).includes(packageName),
    ),
  )
  if (stackOverride) {
    throw new Error(
      `agent stack dependencies must align without pnpm overrides: ${stackOverride[0]}=${String(stackOverride[1])}`,
    )
  }
}

function exactDevelopmentPin(packageManifest, packageName) {
  const version = packageManifest.devDependencies?.[packageName]
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${packageName} must have one exact development pin`)
  }
  return version
}

function exactVersion(version, description) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${description} must be one exact version`)
  }
  return version
}

function assertPortableDeclarations(distDir) {
  const offenders = []
  for (const file of declarationFiles(distDir)) {
    const source = readFileSync(file, 'utf8')
    if (
      /(?:\.pnpm[/\\]|node_modules[/\\]\.pnpm[/\\])/.test(source) ||
      /(?:from|import)\s*["'](?:\/|[A-Za-z]:[/\\])/.test(source)
    ) {
      offenders.push(file.slice(distDir.length + 1))
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      [
        'published declarations contain a package-manager or absolute filesystem reference.',
        'Every public type must resolve through package names or relative declaration files.',
        ...offenders.map((offender) => `  - ${offender}`),
      ].join('\n'),
    )
  }
}

// A cohort package declares a caret range, not the resolved version, so the two
// are compared by admission under npm's caret rule.
function assertCaretAdmits(declaredRange, version, description) {
  if (!/^\^(\d+)\.(\d+)\.(\d+)$/.test(declaredRange)) {
    throw new Error(`${description} must declare a caret range, received ${declaredRange}`)
  }
  if (!caretAdmits(declaredRange, version)) {
    throw new Error(
      `${description} declares ${declaredRange}, which does not admit installed ${version}`,
    )
  }
}

function assertRequiredPeer(packageManifest, packageName, expectedRange) {
  if (packageManifest.peerDependencies?.[packageName] !== expectedRange) {
    throw new Error(`${packageName} must be a required peer at ${expectedRange}`)
  }
  if (packageManifest.dependencies?.[packageName] !== undefined) {
    throw new Error(`${packageName} must not be a runtime dependency`)
  }
}

function assertPublishedRequiredPeer(packageManifest, packageName, expectedRange) {
  if (packageManifest.peerDependencies?.[packageName] !== expectedRange) {
    throw new Error(
      `published ${packageName} peer mismatch: ${packageManifest.peerDependencies?.[packageName]} expected=${expectedRange}`,
    )
  }
  if (packageManifest.dependencies?.[packageName] !== undefined) {
    throw new Error(`published ${packageName} must not be a runtime dependency`)
  }
}

function assertSingleInstalledAgentStack(appDir, expectedVersions) {
  const installedPaths = run(
    'npm',
    ['ls', '--all', '--parseable', ...Object.keys(expectedVersions)],
    appDir,
  )
    .split(/\r?\n/)
    .filter(Boolean)
  const installedByPackage = new Map(
    Object.keys(expectedVersions).map((packageName) => [packageName, new Map()]),
  )
  for (const installedPath of installedPaths) {
    const packagePath = realpathSync(installedPath)
    const packageManifest = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'))
    installedByPackage.get(packageManifest.name)?.set(packagePath, packageManifest.version)
  }
  for (const [packageName, expectedVersion] of Object.entries(expectedVersions)) {
    const copies = installedByPackage.get(packageName)
    if (copies?.size !== 1 || [...copies.values()][0] !== expectedVersion) {
      throw new Error(
        `${packageName} must have one installed copy at ${expectedVersion}: ${JSON.stringify(Object.fromEntries(copies ?? []))}`,
      )
    }
  }
}

function assertNoEdgeUnsafeStaticImports(distDir) {
  const offenders = []
  for (const file of javascriptFiles(distDir)) {
    const source = readFileSync(file, 'utf8')
    for (const specifier of edgeUnsafeStaticImports) {
      if (hasStaticImport(source, specifier)) {
        offenders.push(`${file.slice(distDir.length + 1)} -> ${specifier}`)
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      [
        'published bundle statically imports a package that patches a Node builtin at module scope.',
        'Cloudflare rejects the whole Worker on upload with code 10021, and a dry run cannot see it.',
        'Load it with a dynamic import() inside the function that needs it.',
        ...offenders.map((offender) => `  - ${offender}`),
      ].join('\n'),
    )
  }
}

function hasStaticImport(source, specifier) {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quoted = `["']${escaped}["']`
  // Bound imports, bare side-effect imports, re-exports, and CommonJS require.
  // Dynamic import() is deliberately excluded because it defers module scope.
  return new RegExp(
    `(?:\\bfrom\\s*${quoted}|\\bimport\\s*${quoted}|\\brequire\\(\\s*${quoted}\\s*\\))`,
  ).test(source)
}

function assertEdgeUnsafeStaticImportMatcher() {
  const specifier = 'proper-lockfile'
  const cases = [
    ['bound ESM import', `import value from '${specifier}'`, true],
    ['bare side-effect ESM import', `import '${specifier}'`, true],
    ['ESM re-export', `export { value } from '${specifier}'`, true],
    ['CommonJS require', `require('${specifier}')`, true],
    ['dynamic import', `await import('${specifier}')`, false],
  ]
  for (const [label, source, expected] of cases) {
    const actual = hasStaticImport(source, specifier)
    if (actual !== expected) {
      throw new Error(`edge-unsafe static import matcher failed: ${label}`)
    }
  }
}

function filesInTree(directory, predicate) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...filesInTree(path, predicate))
    else if (predicate(entry)) files.push(path)
  }
  return files
}

function javascriptFiles(directory) {
  return filesInTree(directory, (entry) => /\.(?:js|mjs|cjs)$/.test(entry))
}

function declarationFiles(directory) {
  return filesInTree(directory, (entry) => /\.d\.ts$/.test(entry))
}

function onlyTarball(directory) {
  const tarballs = readdirSync(directory).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one tarball in ${directory}, found ${tarballs.length}`)
  }
  return join(directory, tarballs[0])
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      INIT_CWD: cwd,
      npm_config_ignore_scripts: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `command failed: ${command} ${args.join(' ')}`,
        result.error?.message,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  return result.stdout
}
