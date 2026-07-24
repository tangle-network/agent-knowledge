import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
]
const forbiddenRootExports = [
  'boundedRetrievalConfigMethod',
  'buildBoundedRetrievalConfigs',
  'buildRetrievalParameterCandidates',
  'retrievalParameterSweepProposer',
]
const requiredMemoryExports = ['runAgentMemoryImprovement']
const requiredAgentEvalExports = ['gepaOptimizationMethod', 'skillOptOptimizationMethod']
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const agentEvalVersion = sourcePackage.dependencies?.['@tangle-network/agent-eval']
if (!/^\d+\.\d+\.\d+$/.test(agentEvalVersion)) {
  throw new Error('@tangle-network/agent-eval must be pinned to one exact version')
}
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
    ],
    appDir,
  )

  const installedPackageDir = join(appDir, 'node_modules', '@tangle-network', 'agent-knowledge')
  const installedPackage = JSON.parse(
    readFileSync(join(installedPackageDir, 'package.json'), 'utf8'),
  )
  const installedAgentEval = JSON.parse(
    readFileSync(
      join(appDir, 'node_modules', '@tangle-network', 'agent-eval', 'package.json'),
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
    `Verified ${packageName}@${installedPackage.version}: clean install, ${publicImports.length} imports, skill, CLI version, and re-pack.\n`,
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
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
