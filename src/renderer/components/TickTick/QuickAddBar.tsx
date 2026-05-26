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
    const parsed = parseTaskInput(text.trim());

    // Find list by name or use default
    let listId = defaultListId || (lists.length > 0 ? lists[0].id : '');
    if (parsed.list_name) {
      const found = lists.find(l => l.name === parsed.list_name);
      if (found) listId = found.id;
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
          placeholder="添加任务，支持自然语言：明天下午3点复习高数 #考研 @数学 !!高"
          aria-label="快速添加任务"
        />
        <button className="icon-btn" type="button" title="日期" onClick={() => inputRef.current?.focus()}><Calendar size={14} /></button>
        <button className="icon-btn" type="button" title="标签" onClick={() => inputRef.current?.focus()}><Hash size={14} /></button>
        <button className="icon-btn" type="button" title="清单" onClick={() => inputRef.current?.focus()}><List size={14} /></button>
      </div>
      <div className="tt-quick-add-hint">
        明天→日期 · #标签 · @清单 · !!高→优先级 · 每天→重复 · 预计30分钟→时长
      </div>
    </div>
  );
}
