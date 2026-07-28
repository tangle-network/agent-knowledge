import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const agentEvalVersion = sourcePackage.dependencies?.['@tangle-network/agent-eval']
if (!/^\d+\.\d+\.\d+$/.test(agentEvalVersion)) {
  throw new Error('@tangle-network/agent-eval must be pinned to one exact version')
}
const agentInterfaceVersion = sourcePackage.dependencies?.['@tangle-network/agent-interface']
if (!/^\d+\.\d+\.\d+$/.test(agentInterfaceVersion)) {
  throw new Error('@tangle-network/agent-interface must be pinned to one exact version')
}
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
  const installedAgentInterface = JSON.parse(
    readFileSync(
      join(appDir, 'node_modules', '@tangle-network', 'agent-interface', 'package.json'),
      'utf8',
    ),
  )
  if (
    installedPackage.dependencies?.['@tangle-network/agent-eval'] !== agentEvalVersion ||
    installedAgentEval.version !== agentEvalVersion
  ) {
    throw new Error(
      `agent-eval version mismatch: dependency=${installedPackage.dependencies?.['@tangle-network/agent-eval']} installed=${installedAgentEval.version} expected=${agentEvalVersion}`,
    )
  }
  if (
    installedPackage.dependencies?.['@tangle-network/agent-interface'] !==
      agentInterfaceVersion ||
    installedAgentInterface.version !== agentInterfaceVersion
  ) {
    throw new Error(
      `agent-interface version mismatch: dependency=${installedPackage.dependencies?.['@tangle-network/agent-interface']} installed=${installedAgentInterface.version} expected=${agentInterfaceVersion}`,
    )
  }
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
    `Verified ${packageName}@${installedPackage.version} with agent-eval ${installedAgentEval.version} and agent-interface ${installedAgentInterface.version}: clean install, ${publicImports.length} imports, skill, CLI version, and re-pack.\n`,
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
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

function javascriptFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) files.push(...javascriptFiles(path))
    else if (/\.(?:js|mjs|cjs)$/.test(entry)) files.push(path)
  }
  return files
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
