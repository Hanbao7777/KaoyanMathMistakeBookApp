import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { shell } from 'electron';
import { getPaths } from './pathService';
import type { ImageUrlResult } from '../../shared/types';

export function resolveImagePath(imagePath: string) {
  const raw = imagePath.trim();
  const paths = getPaths();
  if (!raw) return '';

  const normalizedRaw = raw.replace(/[\\/]+/g, path.sep);
  const basename = path.basename(normalizedRaw);
  const candidates: string[] = [];

  if (path.isAbsolute(normalizedRaw)) {
    candidates.push(path.normalize(normalizedRaw));
  } else if (normalizedRaw.toLowerCase().startsWith(`images${path.sep}`)) {
    candidates.push(path.join(paths.root, normalizedRaw));
  } else {
    candidates.push(path.join(paths.images, normalizedRaw));
  }

  if (basename) candidates.push(path.join(paths.images, basename));

  const uniqueCandidates = Array.from(new Set(candidates.map((candidate) => path.normalize(candidate))));
  const found = uniqueCandidates.find((candidate) => fs.existsSync(candidate));
  return found || uniqueCandidates[0] || '';
}

export const resolveStoredImagePath = resolveImagePath;

export function getImageUrl(imagePath: string): ImageUrlResult {
  const resolvedPath = resolveImagePath(imagePath);
  const exists = Boolean(resolvedPath && fs.existsSync(resolvedPath));
  return {
    originalPath: imagePath,
    resolvedPath,
    url: exists ? pathToFileURL(resolvedPath).href : '',
    exists
  };
}

export function checkImageExists(imagePath: string) {
  return getImageUrl(imagePath).exists;
}

export async function openImage(imagePath: string) {
  const image = getImageUrl(imagePath);
  if (!image.exists) throw new Error('图片文件不存在，请检查导入路径');
  return shell.openPath(image.resolvedPath);
}

export function revealImageInFolder(imagePath: string) {
  const image = getImageUrl(imagePath);
  if (!image.exists) throw new Error('图片文件不存在，请检查导入路径');
  shell.showItemInFolder(image.resolvedPath);
  return true;
}
