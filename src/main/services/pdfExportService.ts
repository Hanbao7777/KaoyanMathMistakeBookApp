import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, shell } from 'electron';
import * as katex from 'katex';
import { getQuestionsByIds, listQuestions } from './databaseService';
import { getKnowledgeReviewQuestions } from './knowledgeMapService';
import { resolveImagePath } from './imageService';
import { getPaths } from './pathService';
import type { PdfExportOptions, PdfExportResult, Question } from '../../shared/types';

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function timestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function sanitizeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, '_').slice(0, 48);
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(value: string) {
  return escapeHtml(value).replace(/\n/g, '<br />');
}


function loadKatexCss() {
  try {
    const cssPath = require.resolve('katex/dist/katex.min.css');
    return fs.readFileSync(cssPath, 'utf8');
  } catch {
    return '';
  }
}

const KATEX_CSS = loadKatexCss();
const latexCommandPattern = /\\(frac|sqrt|lim|sum|int|alpha|beta|gamma|theta|pi|infty|to|arctan|sin|cos|tan|ln|log|left|right|cdot|leq|geq|neq|sim)\b/;

function normalizeLatex(value: string) {
  return value
    .replace(/\\\\(?=(frac|sqrt|lim|sum|int|alpha|beta|gamma|theta|pi|infty|to|arctan|sin|cos|tan|ln|log|left|right|cdot|leq|geq|neq|sim)\b)/g, '\\')
    .replace(/\\lim_([a-zA-Z])\\to\\infty/g, (_match, variable) => `\\lim_{${variable}\\to\\infty}`)
    .replace(/\\frac([0-9a-zA-Z])\\([a-zA-Z]+)/g, (_match, numerator, denominator) => `\\frac{${numerator}}{\\${denominator}}`);
}

function renderMath(expr: string, displayMode: boolean) {
  try {
    return katex.renderToString(expr, { throwOnError: false, strict: false, displayMode });
  } catch {
    return `<span class="formula-fallback">${escapeHtml(expr)}</span>`;
  }
}

function looksLikePureFormula(value: string) {
  const compact = value.trim();
  if (!compact || /[\u4e00-\u9fa5]/.test(compact)) return false;
  return latexCommandPattern.test(compact) || /[{}_^]/.test(compact);
}

function renderRichText(value: string) {
  const normalized = normalizeLatex(value);
  const pattern = /\\\[((?:.|\n)*?)\\\]|\\\(((?:.|\n)*?)\\\)|\$\$((?:.|\n)*?)\$\$|\$([^$\n]+?)\$/g;
  let html = '';
  let lastIndex = 0;
  let matched = false;

  normalized.replace(pattern, (match, bracketBlock, parenInline, dollarBlock, dollarInline, offset) => {
    html += nl2br(normalized.slice(lastIndex, offset));
    const expression = bracketBlock ?? parenInline ?? dollarBlock ?? dollarInline ?? '';
    const displayMode = Boolean(bracketBlock || dollarBlock);
    html += renderMath(expression, displayMode);
    lastIndex = offset + match.length;
    matched = true;
    return match;
  });

  html += nl2br(normalized.slice(lastIndex));
  if (!matched && looksLikePureFormula(normalized)) return renderMath(normalized, false);
  return html;
}
function modeLabel(mode: PdfExportOptions['mode']) {
  return mode === 'practice' ? '练习版' : '完整版';
}

function scopeLabel(options: PdfExportOptions, count: number) {
  if (options.scope === 'all') return '全部错题';
  if (options.scope === 'knowledgePoint') return options.title ? `知识点：${options.title}` : '知识点错题';
  return `当前筛选结果（${count} 道）`;
}

async function resolveQuestions(options: PdfExportOptions): Promise<Question[]> {
  if (options.scope === 'all') return listQuestions({ sortBy: 'created_at', sortOrder: 'desc' });
  if (options.scope === 'knowledgePoint') {
    if (!options.knowledgeNodeId) throw new Error('缺少知识点 ID');
    const result = await getKnowledgeReviewQuestions(options.knowledgeNodeId, 'all', options.includeChildren ?? true);
    return result.questions;
  }
  const ids = Array.from(new Set((options.questionIds ?? []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  return getQuestionsByIds(ids);
}

function imageHtml(question: Question) {
  const images = question.question_images || [];
  if (!images.length) return '<div class="image-empty">暂无错题原图</div>';
  return `<div class="image-grid">${images.map((image) => {
    const resolved = resolveImagePath(image.file_path);
    if (!resolved || !fs.existsSync(resolved)) return '<div class="image-missing">错题原图缺失</div>';
    return `<img src="${pathToFileURL(resolved).href}" alt="错题原图" />`;
  }).join('')}</div>`;
}

function metaHtml(question: Question) {
  const knowledge = question.knowledge_points?.map((point) => point.title).filter(Boolean).join('；') || '暂无';
  const tags = question.tags?.join('；') || '暂无';
  const items = [
    ['分类', question.category],
    ['题型', question.question_type],
    ['错因', question.error_reason],
    ['难度', question.difficulty],
    ['掌握程度', question.mastery_level],
    ['知识点', knowledge],
    ['来源', question.source || '未填写'],
    ['标签', tags]
  ];
  return `<div class="meta-grid">${items.map(([label, value]) => `<span><b>${escapeHtml(label)}</b>${escapeHtml(value || '未填写')}</span>`).join('')}</div>`;
}

function reviewStatusHtml(question: Question) {
  return `<div class="review-status">
    <span>复习次数：${question.review_count ?? 0}</span>
    <span>做对：${question.correct_count ?? 0}</span>
    <span>做错：${question.wrong_count ?? 0}</span>
    <span>没思路：${question.no_idea_count ?? 0}</span>
    <span>上次复习：${escapeHtml(question.last_reviewed_at || '暂无')}</span>
    <span>下次复习：${escapeHtml(question.next_review_at || '暂无')}</span>
  </div>`;
}

function textBlock(title: string, value?: string) {
  return `<section class="text-block"><h3>${escapeHtml(title)}</h3><div>${renderRichText(value?.trim() || '未填写')}</div></section>`;
}

function buildHtml(questions: Question[], options: PdfExportOptions) {
  const exportedAt = new Date().toLocaleString('zh-CN');
  const full = options.mode === 'full';
  const title = options.title || '考研高数错题集';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 16mm 13mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #111827; background: #fff; font-family: "Microsoft YaHei", "SimSun", Arial, sans-serif; font-size: 13px; line-height: 1.68; }
  .cover { min-height: 92vh; display: grid; align-content: center; gap: 18px; page-break-after: always; }
  .cover h1 { margin: 0; font-size: 34px; color: #102a43; }
  .cover p { margin: 0; color: #4b5563; font-size: 15px; }
  .cover-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; max-width: 560px; }
  .cover-grid span, .meta-grid span, .review-status span { border: 1px solid #d7dee8; border-radius: 8px; padding: 8px 10px; background: #f8fafc; }
  .question { page-break-before: always; padding-top: 2mm; }
  .question h2 { margin: 0 0 10px; color: #102a43; font-size: 20px; border-bottom: 2px solid #d7dee8; padding-bottom: 8px; }
  .meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin: 10px 0 12px; }
  .meta-grid b { display: inline-block; min-width: 70px; color: #4b5563; }
  .text-block { margin: 12px 0; page-break-inside: avoid; }
  .text-block h3 { margin: 0 0 6px; font-size: 15px; color: #1f4d7a; }
  .text-block div { white-space: normal; word-break: break-word; }
  .image-grid { display: grid; gap: 10px; margin: 12px 0; }
  .image-grid img { max-width: 100%; height: auto; border: 1px solid #d7dee8; border-radius: 8px; page-break-inside: avoid; }
  .image-empty, .image-missing { margin: 10px 0; padding: 14px; border: 1px dashed #cbd5e1; border-radius: 8px; color: #64748b; background: #f8fafc; }
  .review-status { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-top: 12px; font-size: 12px; }
  .katex { font-size: 1.04em; }
  .katex-display { overflow-x: auto; overflow-y: hidden; }
  .formula-fallback { color: #334155; }
  .footer-note { margin-top: 16px; color: #94a3b8; font-size: 11px; text-align: right; }
</style>
</head>
<body>
  <section class="cover">
    <h1>考研高数错题集</h1>
    <p>导出时间：${escapeHtml(exportedAt)}</p>
    <div class="cover-grid">
      <span>导出范围：${escapeHtml(scopeLabel(options, questions.length))}</span>
      <span>错题数量：${questions.length} 道</span>
      <span>版本类型：${modeLabel(options.mode)}</span>
      <span>图片：错题原图</span>
    </div>
  </section>
  ${questions.map((question, index) => `<article class="question">
    <h2>第 ${index + 1} 题：${escapeHtml(question.title || '未命名错题')}</h2>
    ${metaHtml(question)}
    ${textBlock('题目内容', question.content)}
    <section class="text-block"><h3>错题原图</h3>${imageHtml(question)}</section>
    ${full ? textBlock('我的错误思考', question.wrong_thinking || question.wrong_solution) : ''}
    ${full ? textBlock('正确解析', question.correct_solution) : ''}
    ${full ? textBlock('答案', question.answer) : ''}
    ${full ? `<section class="text-block"><h3>复习状态</h3>${reviewStatusHtml(question)}</section>` : ''}
    <div class="footer-note">考研高数错题本 · ${index + 1} / ${questions.length}</div>
  </article>`).join('')}
</body>
</html>`;
}

async function waitForReady(win: BrowserWindow) {
  await win.webContents.executeJavaScript(`Promise.all(Array.from(document.images).map(img => img.complete ? true : new Promise(resolve => { img.onload = resolve; img.onerror = resolve; }))).then(() => document.fonts ? document.fonts.ready : true)`);
}

export async function exportQuestionsToPdf(options: PdfExportOptions): Promise<PdfExportResult> {
  const paths = getPaths();
  const safeTitle = options.scope === 'knowledgePoint' && options.title ? `_${sanitizeFileName(options.title)}` : '';
  return exportQuestionsToPdfAt(options, path.join(paths.exports, `mistakes${safeTitle}_export_${timestamp()}.pdf`));
}

/** Internal C13 seam: materialization owns its App-managed staging path. */
export async function exportQuestionsToPdfAt(options: PdfExportOptions, filePath: string): Promise<PdfExportResult> {
  const questions = await resolveQuestions(options);
  if (!questions.length) throw new Error('当前没有可导出的错题');
  const normalized = path.normalize(filePath);
  fs.mkdirSync(path.dirname(normalized), { recursive: true });
  const html = buildHtml(questions, options);
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await waitForReady(win);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.55, bottom: 0.55, left: 0.45, right: 0.45 }
    });
    fs.writeFileSync(normalized, pdf);
    return { fileName: path.basename(normalized), filePath: normalized, count: questions.length, mode: options.mode, scope: options.scope };
  } finally {
    win.destroy();
  }
}

export async function openExportedPdf(filePath: string) {
  if (!filePath || !fs.existsSync(filePath)) throw new Error('PDF 文件不存在');
  const result = await shell.openPath(filePath);
  if (result) throw new Error(result);
  return true;
}

export async function openExportsFolder() {
  const paths = getPaths();
  fs.mkdirSync(paths.exports, { recursive: true });
  const result = await shell.openPath(paths.exports);
  if (result) throw new Error(result);
  return true;
}


