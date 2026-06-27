import { Calendar, Hash, List, Plus } from 'lucide-react';
import { useState, useRef } from 'react';
import { parseTaskInput } from '../../utils/nlpDateParser';
import type { TickTickList } from '../../../shared/types';
import { useToast } from '../../components/Toast';

interface QuickAddBarProps {
  defaultListId?: string;
  lists: TickTickList[];
  onTaskCreated: () => void;
}

export function QuickAddBar({ defaultListId, lists, onTaskCreated }: QuickAddBarProps) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit() {
    if (!text.trim()) return;
    if (!lists.length) {
      toast('请先创建一个清单，再添加任务', 'warning');
      return;
    }
    const parsed = parseTaskInput(text.trim());

    let listId = defaultListId || lists[0].id;
    if (parsed.list_name) {
      const found = lists.find(l => l.name === parsed.list_name);
      if (found) listId = found.id;
      else {
        toast(`未找到清单「${parsed.list_name}」，将添加到默认清单`, 'warning');
      }
    }

    try {
      await window.api.createTickTickTask({
        list_id: listId,
        title: parsed.title,
        due_date: parsed.due_date,
        due_time: parsed.due_time,
        priority: parsed.priority,
        tags: parsed.tags,
        recurrence_rule: parsed.recurrence_rule,
        estimated_minutes: parsed.estimated_minutes,
      });
      setText('');
      onTaskCreated();
    } catch (e: any) {
      toast(e.message || '创建任务失败', 'error');
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="tt-quick-add">
      <div className="tt-quick-add-inner">
        <span className="plus">+</span>
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={lists.length ? '添加任务，支持自然语言：明天下午3点复习高数 #考研 @数学 !!高' : '请先创建清单，再添加任务'}
          aria-label="快速添加任务"
          disabled={!lists.length}
        />
        <button className="icon-btn" type="button" title="日期" onClick={() => inputRef.current?.focus()} disabled={!lists.length}><Calendar size={14} /></button>
        <button className="icon-btn" type="button" title="标签" onClick={() => inputRef.current?.focus()} disabled={!lists.length}><Hash size={14} /></button>
        <button className="icon-btn" type="button" title="清单" onClick={() => inputRef.current?.focus()} disabled={!lists.length}><List size={14} /></button>
      </div>
      <div className="tt-quick-add-hint">
        {lists.length ? '明天→日期 · #标签 · @清单 · !!高→优先级 · 每天→重复 · 预计30分钟→时长' : '当前没有清单，请先在左侧创建清单'}
      </div>
    </div>
  );
}
