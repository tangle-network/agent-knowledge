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
import { basename, dirname, isAbsolute, resolve } from 'node:path'

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
