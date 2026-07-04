// Minimal shared helpers for page-level load error state.
// Used by TickTick pages to turn an async initial load into a
// success/error outcome so failures render a visible error + retry
// instead of a blank page, stale data, or a silent console.error.

const DEFAULT_LOAD_ERROR = '加载失败，请重试';

/**
 * Convert an unknown thrown value into a user-readable message.
 * Falls back to a generic (or caller-supplied) message when the
 * error is empty, non-Error, or has no usable message.
 */
export function toReadableError(err: unknown, fallback: string = DEFAULT_LOAD_ERROR): string {
  if (typeof err === 'string' && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}

export type LoadOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Run an async loader and capture the result as an outcome.
 * Never throws: a rejection becomes { ok: false, message } and is
 * logged via console.error, preserving existing diagnostics while
 * giving the caller an explicit error state to render.
 */
export async function runLoad<T>(
  loader: () => Promise<T>,
  fallback: string = DEFAULT_LOAD_ERROR
): Promise<LoadOutcome<T>> {
  try {
    const value = await loader();
    return { ok: true, value };
  } catch (err) {
    console.error(err);
    return { ok: false, message: toReadableError(err, fallback) };
  }
}

const DEFAULT_COMMAND_ERROR = '操作失败，请重试';

/**
 * Run an async user command and capture the result as an outcome.
 * Mirrors runLoad but is intended for command-style operations
 * (start/pause/reset/toggle/etc.) where the caller wants a readable
 * error message to show as toast/feedback instead of silently swallowing.
 */
export async function runCommand<T>(
  fn: () => Promise<T>,
  fallback: string = DEFAULT_COMMAND_ERROR
): Promise<LoadOutcome<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    console.error(err);
    return { ok: false, message: toReadableError(err, fallback) };
  }
}
