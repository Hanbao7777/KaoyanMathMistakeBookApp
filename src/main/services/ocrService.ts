import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import type { OcrResult } from '../../shared/types';

let ocrProcess: ChildProcess | null = null;
let pendingRequests = new Map<number, { resolve: (value: OcrResult) => void; reject: (error: Error) => void }>();
let nextId = 1;
let readyPromise: Promise<void> | null = null;
let pythonPath = 'python';

function getScriptPath(): string {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'scripts', 'ocr_server.py');
  }
  return path.join(process.resourcesPath, 'scripts', 'ocr_server.py');
}

export function getPythonPath(): string {
  return pythonPath;
}

export function setPythonPath(p: string): void {
  pythonPath = p;
}

function startOcrProcess(): Promise<void> {
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    const scriptPath = getScriptPath();

    ocrProcess = spawn(pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let buffer = '';

    ocrProcess.stdout!.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            resolve();
          } else if (msg.type === 'init_error' || msg.type === 'fatal') {
            const err = new Error(`PaddleOCR: ${msg.message}`);
            readyPromise = null;
            reject(err);
          } else if (typeof msg.id === 'number' && pendingRequests.has(msg.id)) {
            const req = pendingRequests.get(msg.id)!;
            pendingRequests.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(msg.error));
            } else {
              req.resolve({
                text: msg.text || '',
                confidence: msg.confidence || 0,
                processingTimeMs: 0
              });
            }
          }
        } catch {
          // Skip non-JSON lines (PaddleOCR debug output)
        }
      }
    });

    ocrProcess.stderr!.on('data', (data: Buffer) => {
      // Log stderr but don't treat it as fatal — PaddleOCR logs to stderr
      console.log('[OCR]', data.toString('utf8').trim());
    });

    ocrProcess.on('error', (err) => {
      readyPromise = null;
      reject(new Error(`无法启动 Python (${pythonPath}): ${err.message}。请确认已安装 Python 3.9+`));
    });

    ocrProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.log(`[OCR] Process exited with code ${code}`);
      }
      ocrProcess = null;
      readyPromise = null;
      for (const [, req] of pendingRequests) {
        req.reject(new Error('OCR 进程已退出'));
      }
      pendingRequests.clear();
    });

    // Timeout after 60 seconds for model loading
    setTimeout(() => {
      if (readyPromise !== null) {
        reject(new Error('PaddleOCR 启动超时（60秒）。请确认: pip install paddlepaddle paddleocr'));
        killOcrProcess();
      }
    }, 60000);
  });

  return readyPromise;
}

function sendRequest(imagePath: string): Promise<OcrResult> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pendingRequests.set(id, { resolve, reject });
    try {
      ocrProcess!.stdin!.write(JSON.stringify({ id, image_path: imagePath }) + '\n');
    } catch (err) {
      pendingRequests.delete(id);
      reject(new Error('无法与 OCR 进程通信'));
    }
  });
}

export async function runOcr(imagePaths: string[]): Promise<OcrResult[]> {
  await startOcrProcess();

  const results: OcrResult[] = [];
  for (const imagePath of imagePaths) {
    try {
      const result = await sendRequest(imagePath);
      results.push(result);
    } catch (error) {
      results.push({
        text: '',
        confidence: 0,
        processingTimeMs: 0
      });
    }
  }

  return results;
}

export function killOcrProcess(): void {
  if (ocrProcess) {
    try {
      ocrProcess.stdin!.write(JSON.stringify({ action: 'shutdown' }) + '\n');
      ocrProcess.stdin!.end();
    } catch { /* ignore */ }
    setTimeout(() => {
      if (ocrProcess && !ocrProcess.killed) {
        ocrProcess.kill();
      }
    }, 3000);
    ocrProcess = null;
    readyPromise = null;
  }
}
