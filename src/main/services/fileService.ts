import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import { getPaths } from './pathService';
import type { ImageType } from '../../shared/types';

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function sanitizeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_');
}

export function assertSupportedImagePath(sourcePath: string) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error('仅支持 jpg、jpeg、png、webp 图片格式');
  }
  return ext;
}

export function createManagedImagePath(questionId: number, imageType: ImageType, sourcePath: string, nonce: string) {
  assertSupportedImagePath(sourcePath);
  const original = sanitizeFileName(path.basename(sourcePath));
  const safeNonce = nonce.replace(/[^A-Za-z0-9_-]/g, '');
  if (!safeNonce) throw new Error('图片操作标识无效');
  const fileName = `${imageType}_${questionId}_${safeNonce}_${original}`;
  return {
    absolutePath: path.normalize(path.join(getPaths().images, fileName)),
    storedPath: path.posix.join('images', fileName)
  };
}

export function resolveManagedImagePath(filePath: string) {
  const normalized = filePath.replace(/\//g, path.sep);
  return path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.normalize(path.join(getPaths().root, normalized.toLowerCase().startsWith(`images${path.sep}`) ? normalized : path.join('images', normalized)));
}

export function copyImageToStore(questionId: number, imageType: ImageType, sourcePath: string) {
  assertSupportedImagePath(sourcePath);

  const original = sanitizeFileName(path.basename(sourcePath));
  const fileName = `${imageType}_${questionId}_${Date.now()}_${original}`;
  const target = path.join(getPaths().images, fileName);
  fs.copyFileSync(sourcePath, target);
  return path.posix.join('images', fileName);
}

export function deleteFiles(filePaths: string[]) {
  for (const filePath of filePaths) {
    try {
      const target = resolveManagedImagePath(filePath);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // 删除图片失败不应阻断错题删除，调用方仍可继续。
    }
  }
}

export async function chooseImages() {
  const result = await dialog.showOpenDialog({
    title: '选择图片',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  });
  return result.canceled ? [] : result.filePaths;
}

export async function chooseJsonFile() {
  const result = await dialog.showOpenDialog({
    title: '选择 JSON 数据文件',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  return result.canceled ? null : result.filePaths[0];
}

export async function chooseDataRoot() {
  const result = await dialog.showOpenDialog({
    title: '选择新的数据保存位置',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
}
