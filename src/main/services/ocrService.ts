import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { OcrResult } from '../../shared/types';

let ocrProcess: ChildProcess | null = null;
let pendingRequests = new Map<number, { resolve: (value: OcrResult) => void; reject: (error: Error) => void }>();
let nextId = 1;
let readyPromise: Promise<void> | null = null;
let pythonPath = 'python';
let lastError = '';

export function getPythonPath(): string {
  return pythonPath;
}

export function setPythonPath(p: string): void {
  pythonPath = p || 'python';
}

export function getLastOcrError(): string {
  return lastError;
}

function getScriptPath(): string {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'scripts', 'ocr_server.py');
  }
  return path.join(process.resourcesPath, 'scripts', 'ocr_server.py');
}

function log(msg: string) {
  console.log(`[OCR] ${msg}`);
}

function startOcrProcess(): Promise<void> {
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    const scriptPath = getScriptPath();
    lastError = '';

    if (!fs.existsSync(scriptPath)) {
      log(`Script not found: ${scriptPath}`);
      reject(new Error(`OCR 脚本未找到: ${scriptPath}`));
      return;
    }

    log(`Starting Python: ${pythonPath} ${scriptPath}`);

    ocrProcess = spawn(pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
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
            log('Process ready');
            resolve();
          } else if (msg.type === 'init_error' || msg.type === 'fatal') {
            lastError = msg.message;
            log(`Init error: ${msg.message}`);
            readyPromise = null;
            reject(new Error(`PaddleOCR: ${msg.message}`));
          } else if (typeof msg.id === 'number' && pendingRequests.has(msg.id)) {
            const req = pendingRequests.get(msg.id)!;
            pendingRequests.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(msg.error));
            } else {
              req.resolve({
                text: msg.text || '',
                confidence: (msg.confidence || 0) * 100,
                processingTimeMs: 0
              });
            }
          }
        } catch {
          // PaddleOCR debug/ANSI lines go here — log them
          if (line.length < 200) {
            log(`stdout: ${line.replace(/\x1b\[[0-9;]*m/g, '')}`);
          }
        }
      }
    });

    ocrProcess.stderr!.on('data', (data: Buffer) => {
      const txt = data.toString('utf8').trim();
      if (txt) log(`stderr: ${txt.replace(/\x1b\[[0-9;]*m/g, '')}`);
    });

    ocrProcess.on('error', (err) => {
      lastError = err.message;
      log(`Spawn error: ${err.message}`);
      readyPromise = null;
      reject(new Error(`无法启动 Python (${pythonPath}): ${err.message}。请确认已安装 Python 3.9+ 并添加到 PATH`));
    });

    ocrProcess.on('exit', (code) => {
      log(`Process exited with code ${code}`);
      if (code !== 0 && code !== null) {
        lastError = `Python 进程异常退出 (exit code ${code})`;
      }
      ocrProcess = null;
      readyPromise = null;
      for (const [, req] of pendingRequests) {
        req.reject(new Error(lastError || 'OCR 进程意外退出'));
      }
      pendingRequests.clear();
    });

    setTimeout(() => {
      if (readyPromise !== null) {
        lastError = 'PaddleOCR 启动超时（60秒）';
        reject(new Error(lastError));
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

    if (!ocrProcess || !ocrProcess.stdin || ocrProcess.killed) {
      pendingRequests.delete(id);
      reject(new Error('OCR 进程未运行，请重试'));
      return;
    }

    const jsonLine = JSON.stringify({ id, image_path: imagePath }) + '\n';
    log(`Sending request ${id} for: ${imagePath}`);

    try {
      ocrProcess.stdin.write(jsonLine);
    } catch (err) {
      pendingRequests.delete(id);
      reject(new Error('无法与 OCR 进程通信'));
    }
  });
}

export async function runOcr(imagePaths: string[]): Promise<OcrResult[]> {
  await startOcrProcess();

  const results: OcrResult[] = [];
  for (const i of imagePaths.keys()) {
    const imagePath = imagePaths[i];
    try {
      const result = await sendRequest(imagePath);
      log(`Image ${i + 1}: ${result.text.length} chars, confidence ${result.confidence}%`);
      results.push(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`Image ${i + 1} failed: ${msg}`);
      results.push({ text: '', confidence: 0, processingTimeMs: 0 });
    }
  }

  if (results.length > 0 && results.every((r) => !r.text)) {
    if (lastError) throw new Error(lastError);
    throw new Error('OCR 未能识别到任何文字');
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
