import fs from 'node:fs';

export type DurabilityOutcome =
  | { status: 'flushed' }
  | { status: 'unsupported'; code?: string }
  | { status: 'failed'; error: unknown; code?: string };

export interface DurabilityHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface DirectoryDurabilityDependencies {
  openDirectory(path: string): Promise<DurabilityHandle>;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

// Windows can open a directory handle but reject fsync with EPERM. That is a
// platform capability result, not evidence that the file publication failed.
const unsupportedDirectoryCodes = new Set(['EINVAL', 'EISDIR', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM']);

export async function flushFile(handle: Pick<DurabilityHandle, 'sync'>): Promise<DurabilityOutcome> {
  try {
    await handle.sync();
    return { status: 'flushed' };
  } catch (error) {
    return { status: 'failed', error, code: errorCode(error) };
  }
}

export async function flushDirectory(
  directoryPath: string,
  dependencies: DirectoryDurabilityDependencies = defaultDirectoryDurabilityDependencies
): Promise<DurabilityOutcome> {
  let handle: DurabilityHandle;
  try {
    handle = await dependencies.openDirectory(directoryPath);
  } catch (error) {
    const code = errorCode(error);
    return unsupportedDirectoryCodes.has(code ?? '')
      ? { status: 'unsupported', ...(code ? { code } : {}) }
      : { status: 'failed', error, ...(code ? { code } : {}) };
  }

  let outcome: DurabilityOutcome;
  try {
    await handle.sync();
    outcome = { status: 'flushed' };
  } catch (error) {
    const code = errorCode(error);
    outcome = unsupportedDirectoryCodes.has(code ?? '')
      ? { status: 'unsupported', ...(code ? { code } : {}) }
      : { status: 'failed', error, ...(code ? { code } : {}) };
  }
  try {
    await handle.close();
  } catch (error) {
    const code = errorCode(error);
    if (outcome.status === 'flushed') return { status: 'failed', error, ...(code ? { code } : {}) };
  }
  return outcome;
}

export const defaultDirectoryDurabilityDependencies: DirectoryDurabilityDependencies = {
  async openDirectory(directoryPath) {
    return fs.promises.open(directoryPath, 'r');
  }
};
