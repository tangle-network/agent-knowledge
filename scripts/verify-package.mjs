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
const requiredRootExports = ['createFileSystemSearchProvider']
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
      sourceTarball,
    ],
    appDir,
  )

  const installedPackageDir = join(appDir, 'node_modules', '@tangle-network', 'agent-knowledge')
  const installedPackage = JSON.parse(
    readFileSync(join(installedPackageDir, 'package.json'), 'utf8'),
  )
  const installedSkill = readFileSync(
    join(installedPackageDir, 'skills', 'build-with-agent-knowledge', 'SKILL.md'),
    'utf8',
  )
  if (!installedSkill.includes('name: build-with-agent-knowledge')) {
    throw new Error('published package is missing the build-with-agent-knowledge skill')
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
        `for (const specifier of ${JSON.stringify(publicImports.slice(1))}) await import(specifier)`,
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
