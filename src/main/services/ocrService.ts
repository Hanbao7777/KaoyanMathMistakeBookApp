import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';
import type { OcrResult } from '../../shared/types';

let pythonPath = 'python';

export function getPythonPath(): string {
  return pythonPath;
}

export function setPythonPath(p: string): void {
  pythonPath = p || 'python';
}

function getScriptPath(): string {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), 'scripts', 'ocr_once.py');
  }
  return path.join(process.resourcesPath, 'scripts', 'ocr_once.py');
}

export async function runOcr(imagePaths: string[]): Promise<OcrResult[]> {
  const scriptPath = getScriptPath();

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`OCR 脚本未找到: ${scriptPath}`);
  }

  const results: OcrResult[] = [];

  for (const imagePath of imagePaths) {
    const startTime = Date.now();
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          pythonPath,
          ['-u', scriptPath, imagePath],
          {
            timeout: 180000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
            env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', GLOG_minloglevel: '3' }
          },
          (error, stdout, stderr) => {
            if (error) {
              const stderrMsg = stderr ? stderr.trim().slice(-300) : '';
              reject(new Error(`OCR 失败: ${error.message}${stderrMsg ? ' — ' + stderrMsg : ''}`));
              return;
            }
            resolve(stdout.trim());
          }
        );
      });

      const parsed = JSON.parse(output);
      results.push({
        text: parsed.ok ? parsed.text : '',
        confidence: parsed.ok ? parsed.confidence : 0,
        processingTimeMs: Date.now() - startTime
      });
    } catch (error) {
      results.push({ text: '', confidence: 0, processingTimeMs: Date.now() - startTime });
    }
  }

  if (results.length > 0 && results.every((r) => !r.text)) {
    throw new Error('OCR 未能识别到文字');
  }

  return results;
}

// Stub — process-based approach no longer needs these
export function killOcrProcess(): void {}
