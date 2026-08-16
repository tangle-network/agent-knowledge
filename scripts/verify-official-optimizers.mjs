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
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const agentEvalVersion = sourcePackage.devDependencies?.['@tangle-network/agent-eval']
if (!/^\d+\.\d+\.\d+$/.test(agentEvalVersion)) {
  throw new Error('@tangle-network/agent-eval must have one exact development pin')
}
const [agentEvalMajor, agentEvalMinor] = agentEvalVersion.split('.').map(Number)
const expectedEvalPeerRange = `>=${agentEvalVersion} <${agentEvalMajor}.${agentEvalMinor + 1}.0`
if (sourcePackage.peerDependencies?.['@tangle-network/agent-eval'] !== expectedEvalPeerRange) {
  throw new Error(
    `@tangle-network/agent-eval peer range must be ${expectedEvalPeerRange} to match the development pin`,
  )
}
const agentInterfaceVersion = sourcePackage.devDependencies?.['@tangle-network/agent-interface']
if (!/^\d+\.\d+\.\d+$/.test(agentInterfaceVersion)) {
  throw new Error('@tangle-network/agent-interface must have one exact development pin')
}
// agent-interface states that a minor is additive and only a major removes or
// narrows, so the peer is a caret range on the lowest version this package uses.
const expectedInterfacePeerRange = `^${agentInterfaceVersion}`
if (sourcePackage.peerDependencies?.['@tangle-network/agent-interface'] !== expectedInterfacePeerRange) {
  throw new Error(
    `@tangle-network/agent-interface peer range must be ${expectedInterfacePeerRange} to match the development pin`,
  )
}
const tempRoot = mkdtempSync(join(tmpdir(), 'agent-knowledge-official-'))

try {
  const python =
    process.env.AGENT_EVAL_TEST_PYTHON ?? installOfficialOptimizers(tempRoot, agentEvalVersion)
  const pythonRpcVersion = run(
    python,
    ['-c', "from importlib.metadata import version; print(version('agent-eval-rpc'))"],
    repoRoot,
  ).trim()
  if (pythonRpcVersion !== agentEvalVersion) {
    throw new Error(
      `official optimizer Python bridge ${pythonRpcVersion} does not match agent-eval ${agentEvalVersion}`,
    )
  }

  const packDir = join(tempRoot, 'pack')
  const appDir = join(tempRoot, 'app')
  mkdirSync(packDir, { recursive: true })
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    join(appDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'agent-knowledge-official-optimizer-verification',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  )

  run('pnpm', ['build'], repoRoot)
  run('npm', ['pack', '--ignore-scripts=false', '--pack-destination', packDir], repoRoot)
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`expected one package tarball, found ${tarballs.length}`)
  }
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
      join(packDir, tarballs[0]),
      `@tangle-network/agent-eval@${agentEvalVersion}`,
      `@tangle-network/agent-interface@${agentInterfaceVersion}`,
    ],
    appDir,
  )

  const installed = join(appDir, 'node_modules')
  run(
    'pnpm',
    [
      'exec',
      'vitest',
      'run',
      'tests/official-optimization.integration.test.ts',
      '--maxWorkers=1',
    ],
    repoRoot,
    {
      AGENT_EVAL_TEST_PYTHON: python,
      AGENT_KNOWLEDGE_PACKAGE_URL: pathToFileURL(
        join(installed, '@tangle-network', 'agent-knowledge', 'dist', 'index.js'),
      ).href,
      AGENT_EVAL_CAMPAIGN_URL: pathToFileURL(
        join(installed, '@tangle-network', 'agent-eval', 'dist', 'campaign', 'index.js'),
      ).href,
    },
  )
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function installOfficialOptimizers(root, rpcVersion) {
  const venvDir = join(root, 'python')
  const basePython = process.env.PYTHON ?? 'python'
  run(basePython, ['-m', 'venv', venvDir], repoRoot, { PYTHONNOUSERSITE: '1' })
  const python =
    process.platform === 'win32'
      ? join(venvDir, 'Scripts', 'python.exe')
      : join(venvDir, 'bin', 'python')
  run(
    python,
    [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--retries=5',
      '--timeout=120',
      '--index-url=https://pypi.org/simple',
      '--no-cache-dir',
      '--only-binary=agent-eval-rpc,gepa',
      `agent-eval-rpc==${rpcVersion}`,
      'gepa[full]==0.1.4',
      'skillopt @ git+https://github.com/microsoft/SkillOpt.git@61735e3922efc2b90c6d6cab561e62e98452ca90',
    ],
    repoRoot,
  )
  return python
}

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
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
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  return result.stdout
}
