import katex from 'katex';

interface FormulaTextProps {
  text?: string | null;
  compact?: boolean;
}

type Segment =
  | { type: 'text'; value: string }
  | { type: 'formula'; value: string; displayMode: boolean; original: string };

const commandNames = [
  'frac',
  'sqrt',
  'lim',
  'sum',
  'int',
  'alpha',
  'beta',
  'gamma',
  'pi',
  'theta',
  'infty',
  'to',
  'left',
  'right',
  'cdot',
  'times',
  'leq',
  'geq',
  'neq',
  'arctan',
  'ln',
  'sin',
  'cos',
  'tan'
];

const commandSource = commandNames.join('|');
const latexCommandPattern = new RegExp(String.raw`\\(${commandSource})\b`);
const wrappedPattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
const formulaStartPattern = new RegExp(String.raw`\\(${commandSource})\b|[A-Za-z]\s*[\^_]`);
const textStopPattern = /[\u4e00-\u9fff，。；：！？]/;

export function latexNormalize(input: string) {
  return input
    .replace(new RegExp(String.raw`\\\\(?=(${commandSource})\b)`, 'g'), '\\')
    .replace(/\\lim_\s*([A-Za-z0-9]+)\s*\\to\s*\\infty/g, '\\lim_{$1\\to\\infty}')
    .replace(/(?<!\\)\bfrac\s*\{/g, '\\frac{')
    .replace(/\\frac\s*([A-Za-z0-9])\s*(\\[A-Za-z]+|[A-Za-z0-9])/g, '\\frac{$1}{$2}');
}

function renderFormulaHtml(formula: string, displayMode: boolean) {
  try {
    return katex.renderToString(latexNormalize(formula), {
      displayMode,
      throwOnError: true,
      strict: false,
      output: 'html'
    });
  } catch (error) {
    console.warn('[FormulaText] KaTeX render failed:', { formula, error });
    return null;
  }
}

function unwrapFormula(token: string) {
  if (token.startsWith('$$') && token.endsWith('$$')) return { formula: token.slice(2, -2), displayMode: true };
  if (token.startsWith('\\[') && token.endsWith('\\]')) return { formula: token.slice(2, -2), displayMode: true };
  if (token.startsWith('\\(') && token.endsWith('\\)')) return { formula: token.slice(2, -2), displayMode: false };
  if (token.startsWith('$') && token.endsWith('$')) return { formula: token.slice(1, -1), displayMode: false };
  return null;
}

function isPureFormula(text: string) {
  const value = latexNormalize(text.trim());
  if (!value || /[\u4e00-\u9fff]/.test(value)) return false;
  if (value.startsWith('\\')) return true;
  if (latexCommandPattern.test(value)) return true;
  return /^[A-Za-z0-9\s{}()[\]^_+\-*/=.,<>|\\]+$/.test(value) && /[\^_\\{}]/.test(value);
}

function shouldUseDisplayMode(formula: string, compact: boolean) {
  if (compact) return false;
  return formula.length > 44 || /\\(lim|sum|int)\b/.test(formula);
}

function pushTextSegment(segments: Segment[], value: string) {
  if (!value) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === 'text') previous.value += value;
  else segments.push({ type: 'text', value });
}

function splitTrailingPunctuation(value: string) {
  const match = value.match(/^(.*?)([，。；：！？,.;:!?]+)?$/s);
  return { formula: match?.[1] || value, punctuation: match?.[2] || '' };
}

function splitUnwrappedText(text: string, compact: boolean): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const rest = text.slice(cursor);
    const match = formulaStartPattern.exec(rest);
    if (!match || match.index < 0) {
      pushTextSegment(segments, rest);
      break;
    }

    const start = cursor + match.index;
    pushTextSegment(segments, text.slice(cursor, start));

    let end = start;
    while (end < text.length && !textStopPattern.test(text[end])) {
      end += 1;
    }

    const rawCandidate = text.slice(start, end);
    const leadingSpace = rawCandidate.match(/^\s*/)?.[0] || '';
    const trimmedCandidate = rawCandidate.trim();
    const { formula, punctuation } = splitTrailingPunctuation(trimmedCandidate);
    const normalized = latexNormalize(formula.trim());

    if (normalized && (latexCommandPattern.test(normalized) || isPureFormula(normalized))) {
      pushTextSegment(segments, leadingSpace);
      segments.push({
        type: 'formula',
        value: normalized,
        displayMode: false,
        original: formula
      });
      pushTextSegment(segments, punctuation);
    } else {
      pushTextSegment(segments, rawCandidate);
    }

    cursor = end;
  }

  return segments.map((segment) =>
    segment.type === 'formula' && compact ? { ...segment, displayMode: false } : segment
  );
}

function parseSegments(text: string, compact: boolean): Segment[] {
  const normalized = latexNormalize(text);
  if (isPureFormula(normalized)) {
    return [
      {
        type: 'formula',
        value: normalized,
        displayMode: shouldUseDisplayMode(normalized, compact),
        original: text
      }
    ];
  }

  const segments: Segment[] = [];
  let lastIndex = 0;
  for (const match of normalized.matchAll(wrappedPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    segments.push(...splitUnwrappedText(normalized.slice(lastIndex, index), compact));
    const unwrapped = unwrapFormula(token);
    if (unwrapped) {
      segments.push({
        type: 'formula',
        value: latexNormalize(unwrapped.formula),
        displayMode: compact ? false : unwrapped.displayMode,
        original: token
      });
    } else {
      pushTextSegment(segments, token);
    }
    lastIndex = index + token.length;
  }
  segments.push(...splitUnwrappedText(normalized.slice(lastIndex), compact));
  return segments;
}

function renderSegment(segment: Segment, key: string) {
  if (segment.type === 'text') return <span key={key}>{segment.value}</span>;

  const html = renderFormulaHtml(segment.value, segment.displayMode);
  if (!html) {
    return (
      <span key={key} className="formula-error">
        {segment.original}
        <small>公式格式可能有误。</small>
      </span>
    );
  }

  const Tag = segment.displayMode ? 'div' : 'span';
  return <Tag key={key} className={segment.displayMode ? 'formula-block' : 'formula-inline'} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function FormulaText({ text, compact = false }: FormulaTextProps) {
  const value = (text || '').trim();
  if (!value) return <span className="formula-text muted-text">未填写</span>;

  const segments = parseSegments(value, compact);
  return <span className={compact ? 'formula-text compact' : 'formula-text'}>{segments.map((segment, index) => renderSegment(segment, String(index)))}</span>;
}
