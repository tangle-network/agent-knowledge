import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const CREATE_FILE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
const READ_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW

export interface RegularFileSnapshot {
  bytes: Buffer
  mode: number
}

export async function writeFileDurable(
  path: string,
  data: string | Buffer,
  options: { encoding?: BufferEncoding; mode?: number } = {},
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  await withDirectoryHandle(directory, async (handle, anchoredDirectory) => {
    const target = resolve(anchoredDirectory, basename(path))
    const existingMode = await regularFileModeOrUndefined(target)
    const requestedMode = options.mode ?? existingMode
    const temporary = resolve(anchoredDirectory, `.${basename(path)}.${randomUUID()}.tmp`)
    let temporaryHandle: FileHandle | undefined
    try {
      temporaryHandle = await open(temporary, CREATE_FILE_FLAGS, requestedMode ?? 0o666)
      await temporaryHandle.writeFile(
        data,
        options.encoding === undefined ? undefined : { encoding: options.encoding },
      )
      if (requestedMode !== undefined) await temporaryHandle.chmod(requestedMode)
      await temporaryHandle.sync()
      await temporaryHandle.close()
      temporaryHandle = undefined
      await rename(temporary, target)
      await syncDirectoryHandle(handle)
    } finally {
      await temporaryHandle?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  })
}

export async function writeJsonDurable(path: string, value: unknown): Promise<void> {
  await writeFileDurable(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' })
}

export async function writeFileDurableWithinRoot(
  root: string,
  relativePath: string,
  data: string | Buffer,
  options: { encoding?: BufferEncoding; mode?: number } = {},
): Promise<void> {
  await withSafeDescendant(root, relativePath, (path) => writeFileDurable(path, data, options))
}

export async function writeJsonDurableWithinRoot(
  root: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  await writeFileDurableWithinRoot(root, relativePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
  })
}

export async function renameDurable(source: string, target: string): Promise<void> {
  const sourceDir = dirname(source)
  const targetDir = dirname(target)
  await withDirectoryHandle(sourceDir, async (sourceHandle, anchoredSourceDir) => {
    await withDirectoryHandle(targetDir, async (targetHandle, anchoredTargetDir) => {
      await rename(
        resolve(anchoredSourceDir, basename(source)),
        resolve(anchoredTargetDir, basename(target)),
      )
      await syncDirectoryHandle(sourceHandle)
      if (targetDir !== sourceDir) await syncDirectoryHandle(targetHandle)
    })
  })
}

export async function removeDurable(path: string): Promise<void> {
  await withDirectoryHandle(dirname(path), async (handle, anchoredDirectory) => {
    await rm(resolve(anchoredDirectory, basename(path)), { force: true })
    await syncDirectoryHandle(handle)
  })
}

export async function syncDirectory(path: string): Promise<void> {
  await withDirectoryHandle(path, syncDirectoryHandle)
}

/**
 * Keeps the target's parent directory open while the operation runs. On Linux,
 * `/proc/self/fd` anchors every lookup to that directory even if an ancestor is
 * renamed concurrently.
 */
export async function withSafeDescendant<T>(
  root: string,
  relativePath: string,
  use: (path: string) => Promise<T> | T,
): Promise<T> {
  const normalized = normalizeRelativePath(relativePath)
  const parts = normalized.split('/')
  const filename = parts.pop()!
  const directory = await openSafeDirectoryTree(root, parts.join('/'), true)
  try {
    const target = resolve(anchoredDirectoryPath(directory.handle, directory.path), filename)
    await regularFileModeOrUndefined(target)
    return await use(target)
  } finally {
    await directory.handle.close()
  }
}

export async function withSafeDirectory<T>(
  root: string,
  relativePath: string,
  create: boolean,
  use: (path: string) => Promise<T> | T,
): Promise<T> {
  const directory = await openSafeDirectoryTree(root, relativePath, create)
  try {
    return await use(anchoredDirectoryPath(directory.handle, directory.path))
  } finally {
    await directory.handle.close()
  }
}

export async function readRegularFileNoFollow(path: string): Promise<RegularFileSnapshot> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, READ_FILE_FLAGS)
    const entry = await handle.stat()
    if (!entry.isFile()) throw new Error(`knowledge path is not a regular file: ${path}`)
    return { bytes: await handle.readFile(), mode: entry.mode & 0o777 }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      throw new Error(`knowledge path is not a regular file: ${path}`, { cause: error })
    }
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function readRegularFileWithinRoot(
  root: string,
  relativePath: string,
): Promise<RegularFileSnapshot> {
  const normalized = normalizeRelativePath(relativePath)
  const parts = normalized.split('/')
  const filename = parts.pop()!
  const directory = await openSafeDirectoryTree(root, parts.join('/'), false)
  try {
    return await readRegularFileNoFollow(
      resolve(anchoredDirectoryPath(directory.handle, directory.path), filename),
    )
  } finally {
    await directory.handle.close()
  }
}

export async function listRegularFilesWithinRoot(
  root: string,
  relativeDirectory: string,
): Promise<Array<RegularFileSnapshot & { path: string }>> {
  const normalized = normalizeRelativePath(relativeDirectory)
  return withSafeDirectory(root, normalized, false, (directory) =>
    listRegularFilesFromOpenDirectory(directory, normalized),
  )
}

export function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function withDirectoryHandle<T>(
  path: string,
  use: (handle: FileHandle, anchoredPath: string) => Promise<T> | T,
): Promise<T> {
  const handle = await openDirectory(path)
  try {
    return await use(handle, anchoredDirectoryPath(handle, path))
  } finally {
    await handle.close()
  }
}

async function listRegularFilesFromOpenDirectory(
  directory: string,
  relativeDirectory: string,
): Promise<Array<RegularFileSnapshot & { path: string }>> {
  const out: Array<RegularFileSnapshot & { path: string }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(
        ...(await withSafeDirectory(directory, entry.name, false, (child) =>
          listRegularFilesFromOpenDirectory(child, relativePath),
        )),
      )
    } else if (entry.isFile()) {
      out.push({
        path: relativePath,
        ...(await readRegularFileNoFollow(resolve(directory, entry.name))),
      })
    } else {
      throw new Error(`knowledge tree contains an unsupported filesystem entry: ${relativePath}`)
    }
  }
  return out
}

async function openSafeDirectoryTree(
  root: string,
  relativePath: string,
  create: boolean,
): Promise<{ handle: FileHandle; path: string }> {
  if (create) await mkdir(root, { recursive: true })
  const resolvedRoot = isKernelAnchoredPath(root) ? root : await realpath(root)
  const normalized = relativePath === '' ? '' : normalizeRelativePath(relativePath)
  let currentPath = resolvedRoot
  let currentHandle = await openDirectory(resolvedRoot)
  try {
    for (const part of normalized.split('/').filter(Boolean)) {
      const anchoredParent = anchoredDirectoryPath(currentHandle, currentPath)
      const childPath = resolve(anchoredParent, part)
      let childHandle: FileHandle
      try {
        childHandle = await openDirectory(childPath)
      } catch (error) {
        if (!create || !isMissingFile(error)) throw unsafeDirectoryError(childPath, error)
        let created = false
        try {
          await mkdir(childPath)
          created = true
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw mkdirError
        }
        childHandle = await openDirectory(childPath).catch((openError: unknown) => {
          throw unsafeDirectoryError(childPath, openError)
        })
        if (created) await syncDirectoryHandle(currentHandle)
      }
      await currentHandle.close()
      currentHandle = childHandle
      currentPath = resolve(currentPath, part)
    }
    return { handle: currentHandle, path: currentPath }
  } catch (error) {
    await currentHandle.close().catch(() => undefined)
    throw error
  }
}

async function openDirectory(path: string): Promise<FileHandle> {
  const isKernelDescriptor = /^\/proc\/self\/fd\/\d+$/.test(path)
  if (!isKernelDescriptor) {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`knowledge path has an unsafe directory: ${path}`)
    }
  }
  const flags = isKernelDescriptor ? constants.O_RDONLY | constants.O_DIRECTORY : DIRECTORY_FLAGS
  const handle = await open(path, flags)
  const entry = await handle.stat()
  if (!entry.isDirectory()) {
    await handle.close()
    throw new Error(`knowledge path has an unsafe directory: ${path}`)
  }
  return handle
}

export function isKernelAnchoredPath(path: string): boolean {
  return process.platform === 'linux' && /^\/proc\/self\/fd\/\d+(?:\/|$)/.test(path)
}

/**
 * The path from `root` down to `candidate`, or undefined when `candidate` is not
 * strictly inside `root`.
 *
 * The comparison is lexical, so both arguments must already share one
 * canonicalization basis. Use `canonicalRelativeWithinRoot` when either side can
 * carry a different basis.
 *
 * An empty result means the two paths are equal. A root is not inside itself,
 * and a caller that treats it as a descendant would hand its own root to
 * machinery that may remove the directory it is given.
 */
export function relativeWithinRoot(root: string, candidate: string): string | undefined {
  const value = relative(resolve(root), resolve(candidate)).replace(/\\/g, '/')
  if (value === '' || value === '..' || value.startsWith('../') || isAbsolute(value)) {
    return undefined
  }
  return value
}

/**
 * The path from `root` down to `candidate`, with both sides canonicalized before
 * they are compared.
 *
 * `resolve` is lexical: it cannot read a symbolic link, so a path that has been
 * through `realpath` and one that has not describe the same directory with
 * different strings, and comparing the two rejects a directory that genuinely
 * sits inside the root. `openSafeDirectoryTree` canonicalizes the root it opens,
 * so any path that reaches a caller through `withSafeDirectory` carries the
 * canonical form while a path the caller built itself does not.
 *
 * Canonicalizing both sides also tightens the boundary: a candidate that leaves
 * the root through a symbolic link is rejected here, where a lexical comparison
 * admits it.
 *
 * Neither path has to exist. The deepest existing ancestor of each is
 * canonicalized and the remaining segments are appended, so a directory that is
 * about to be created is measured against the same root as one that already is.
 */
export async function canonicalRelativeWithinRoot(
  root: string,
  candidate: string,
): Promise<string | undefined> {
  const canonicalRoot = isKernelAnchoredPath(root) ? root : await canonicalizeThroughMissing(root)
  const canonicalCandidate = isKernelAnchoredPath(candidate)
    ? candidate
    : await canonicalizeThroughMissing(candidate)
  return relativeWithinRoot(canonicalRoot, canonicalCandidate)
}

/**
 * Whether two paths name the same location, with both sides canonicalized first.
 *
 * A path stored by one caller and a path supplied by another reach this
 * comparison through different routes, so the same location can arrive under two
 * spellings. Comparing the resolved strings reports a mismatch that does not
 * exist.
 */
export async function canonicalPathsEqual(left: string, right: string): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    isKernelAnchoredPath(left) ? left : canonicalizeThroughMissing(left),
    isKernelAnchoredPath(right) ? right : canonicalizeThroughMissing(right),
  ])
  return canonicalLeft === canonicalRight
}

/** The canonical form of a path whose trailing segments may not exist yet. */
async function canonicalizeThroughMissing(path: string): Promise<string> {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      const existing = await realpath(current)
      return missing.length === 0 ? existing : join(existing, ...missing.reverse())
    } catch (error) {
      if (!isMissingFile(error)) throw error
      const parent = dirname(current)
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

function anchoredDirectoryPath(handle: FileHandle, fallback: string): string {
  return process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : fallback
}

async function regularFileModeOrUndefined(path: string): Promise<number | undefined> {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`knowledge path is not a regular file: ${path}`)
    }
    return entry.mode & 0o777
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

async function syncDirectoryHandle(handle: FileHandle): Promise<void> {
  if (process.platform === 'win32') return
  await handle.sync()
}

function unsafeDirectoryError(path: string, cause: unknown): Error {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  if (code === 'ELOOP' || code === 'ENOTDIR') {
    return new Error(`knowledge path has an unsafe directory: ${path}`, { cause })
  }
  return cause instanceof Error ? cause : new Error(`could not open knowledge directory: ${path}`)
}

function normalizeRelativePath(path: string): string {
  if (path.length === 0 || isAbsolute(path)) {
    throw new Error(`knowledge path must be a non-empty relative path: ${path}`)
  }
  const normalized = path.replace(/\\/g, '/')
  if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`knowledge path contains an unsafe segment: ${path}`)
  }
  return normalized
}
