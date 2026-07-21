export interface TrustedRendererContext {
  readonly webContentsId: number;
  readonly navigationGeneration: number;
}

export interface RendererInvokeEventLike {
  readonly senderFrame: { readonly url: string } | null;
  readonly sender: { readonly id: number; readonly mainFrame: { readonly url: string } };
}

const generations = new Map<number, number>();

export function registerRendererSession(webContentsId: number): void {
  if (!Number.isSafeInteger(webContentsId) || webContentsId < 1) throw new Error('Invalid renderer identity');
  generations.set(webContentsId, 0);
}

export function advanceRendererSession(webContentsId: number): void {
  if (!generations.has(webContentsId)) throw new Error('Unknown renderer identity');
  generations.set(webContentsId, generations.get(webContentsId)! + 1);
}

export function removeRendererSession(webContentsId: number): void {
  generations.delete(webContentsId);
}

function sameRendererDocument(actual: string, expected: string, packaged: boolean): boolean {
  try {
    const value = new URL(actual);
    const allowed = new URL(expected);
    if (!packaged) return value.origin === allowed.origin;
    return value.protocol === 'file:' && value.protocol === allowed.protocol && value.host === allowed.host && value.pathname === allowed.pathname && value.search === '';
  } catch {
    return false;
  }
}

export function deriveTrustedRendererContext(event: RendererInvokeEventLike, options: { readonly packaged: boolean; readonly packagedUrl: string; readonly developmentOrigin: string }): TrustedRendererContext {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) throw new Error('Untrusted renderer frame');
  const expected = options.packaged ? options.packagedUrl : options.developmentOrigin;
  if (!sameRendererDocument(frame.url, expected, options.packaged)) throw new Error('Untrusted renderer origin');
  const generation = generations.get(event.sender.id);
  if (generation === undefined) throw new Error('Unknown renderer identity');
  return Object.freeze({ webContentsId: event.sender.id, navigationGeneration: generation });
}
