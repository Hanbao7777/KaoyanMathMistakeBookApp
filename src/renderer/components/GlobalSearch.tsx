import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { KnowledgePointTreeNode } from '../../shared/types';

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
  onOpenQuestion: (id: number) => void;
  onOpenKnowledgePoint: (nodeId: string) => void;
}

interface SearchResult {
  type: 'question' | 'knowledge';
  id: number | string;
  title: string;
  subtitle: string;
}

export function GlobalSearch({ open, onClose, onOpenQuestion, onOpenKnowledgePoint }: GlobalSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const q = query.toLowerCase();
    Promise.all([
      window.api.listQuestions({ search: query }),
      window.api.listKnowledgeTree()
    ]).then(([questions, tree]) => {
      const items: SearchResult[] = [];
      for (const question of questions.slice(0, 6)) {
        items.push({
          type: 'question',
          id: question.id,
          title: question.title,
          subtitle: `${question.category} · ${question.subject}`
        });
      }

      function walk(nodes: KnowledgePointTreeNode[]) {
        for (const node of nodes) {
          if (node.title.toLowerCase().includes(q) || (node.category || '').toLowerCase().includes(q)) {
            items.push({ type: 'knowledge', id: node.node_id, title: node.title, subtitle: node.category || '' });
            if (items.length >= 12) return;
          }
          walk(node.children);
        }
      }
      walk(tree);

      setResults(items.slice(0, 12));
      setSelectedIndex(0);
    }).catch(() => {});
  }, [query]);

  function handleKey(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === 'Enter' && results[selectedIndex]) {
      event.preventDefault();
      const r = results[selectedIndex];
      if (r.type === 'question') onOpenQuestion(r.id as number);
      else onOpenKnowledgePoint(r.id as string);
      onClose();
    } else if (event.key === 'Escape') {
      onClose();
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="global-search-panel" onClick={(e) => e.stopPropagation()}>
        <div className="global-search-input-wrapper">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
            placeholder="搜索错题和知识点..."
          />
          <kbd>ESC</kbd>
        </div>
        {results.length ? (
          <div className="global-search-results">
            {results.map((r, i) => (
              <button
                key={`${r.type}-${r.id}`}
                className={`global-search-result${i === selectedIndex ? ' selected' : ''}`}
                type="button"
                onClick={() => {
                  if (r.type === 'question') onOpenQuestion(r.id as number);
                  else onOpenKnowledgePoint(r.id as string);
                  onClose();
                }}
              >
                <span className={`badge-${r.type === 'question' ? 'primary' : 'success'}`}>
                  {r.type === 'question' ? '错题' : '知识点'}
                </span>
                <strong>{r.title}</strong>
                <small>{r.subtitle}</small>
              </button>
            ))}
          </div>
        ) : query.trim() ? (
          <p className="global-search-empty">没有找到匹配的结果</p>
        ) : null}
      </div>
    </div>
  );
}
