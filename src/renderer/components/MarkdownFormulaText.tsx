import { useEffect, useMemo, useState } from 'react';
import type { ImageUrlResult } from '../../shared/types';
import { FormulaText } from './FormulaText';

type MarkdownSegment =
  | { type: 'text'; value: string; key: string }
  | { type: 'image'; alt: string; src: string; key: string };

const imagePattern = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function parseMarkdown(text: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  imagePattern.lastIndex = 0;

  while ((match = imagePattern.exec(text))) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, match.index), key: `text-${lastIndex}` });
    }
    segments.push({
      type: 'image',
      alt: match[1] || match[2],
      src: match[2],
      key: `image-${match.index}-${match[2]}`
    });
    lastIndex = imagePattern.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex), key: `text-${lastIndex}` });
  }
  return segments.length ? segments : [{ type: 'text', value: text, key: 'text-0' }];
}

export function stripMarkdownImages(text?: string | null) {
  return (text || '').replace(imagePattern, '').trim();
}

export function hasMarkdownImage(text?: string | null) {
  imagePattern.lastIndex = 0;
  return imagePattern.test(text || '');
}

export function countMarkdownImages(text?: string | null) {
  imagePattern.lastIndex = 0;
  return Array.from((text || '').matchAll(imagePattern)).length;
}

function firstImageSource(text?: string | null) {
  imagePattern.lastIndex = 0;
  return imagePattern.exec(text || '')?.[2] || '';
}

function twoLineSummary(text?: string | null) {
  return stripMarkdownImages(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join('\n');
}

function MissingImageWithLabel({ src, label }: { src: string; label: string }) {
  return <div className="markdown-image-missing">{label}未找到：{src.split(/[\\/]/).pop() || src}</div>;
}

function MarkdownImage({
  questionId,
  src,
  alt,
  compact = false,
  missingLabel = '题目图片'
}: {
  questionId: number;
  src: string;
  alt: string;
  compact?: boolean;
  missingLabel?: string;
}) {
  const [info, setInfo] = useState<ImageUrlResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setFailed(false);
    window.api.getExternalQuestionAssetUrl(questionId, src)
      .then((next) => {
        if (!cancelled) {
          setInfo(next);
          if (!next.exists) console.warn('[QuestionBank] 题目图片未找到', { src, resolvedPath: next.resolvedPath });
        }
      })
      .catch((error) => {
        console.warn('[QuestionBank] 题目图片解析失败', { src, error });
        if (!cancelled) setInfo({ originalPath: src, resolvedPath: '', url: '', exists: false });
      });
    return () => {
      cancelled = true;
    };
  }, [questionId, src]);

  if (!info) return <div className="markdown-image-loading">正在加载图片...</div>;
  if (!info.exists || !info.url || failed) return <MissingImageWithLabel src={src} label={missingLabel} />;
  return (
    <img
      className={compact ? 'markdown-image compact' : 'markdown-image'}
      src={info.url}
      alt={alt || src}
      onError={() => {
        console.warn('[QuestionBank] 题目图片加载失败', { src, resolvedPath: info.resolvedPath });
        setFailed(true);
      }}
    />
  );
}

export function MarkdownFormulaText({
  questionId,
  text,
  missingImageLabel = '题目图片',
  emptyText = '暂无内容'
}: {
  questionId: number;
  text?: string | null;
  missingImageLabel?: string;
  emptyText?: string;
}) {
  const source = (text || '').trim();
  const segments = useMemo(() => parseMarkdown(source), [source]);
  if (!source) return <FormulaText text={emptyText} />;

  return (
    <div className="markdown-formula-text">
      {segments.map((segment) => {
        if (segment.type === 'image') {
          return <MarkdownImage key={segment.key} questionId={questionId} src={segment.src} alt={segment.alt} missingLabel={missingImageLabel} />;
        }
        return segment.value.trim() ? <FormulaText key={segment.key} text={segment.value.trim()} /> : null;
      })}
    </div>
  );
}

export function MarkdownFormulaPreview({ questionId, text }: { questionId: number; text?: string | null }) {
  const summary = twoLineSummary(text);
  const imageSrc = firstImageSource(text);
  if (summary) return <FormulaText text={summary} compact />;
  if (imageSrc) return <MarkdownImage questionId={questionId} src={imageSrc} alt="题目图片" compact />;
  return <FormulaText text="暂无题干" compact />;
}
