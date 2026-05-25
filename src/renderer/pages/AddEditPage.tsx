import { useEffect, useState } from 'react';
import type { Question } from '../../shared/types';
import { QuestionForm } from '../components/QuestionForm';
import { useToast } from '../components/Toast';

interface AddEditPageProps {
  editingId: number | null;
  onSaved: (id: number) => void;
  onCancel: () => void;
}

export function AddEditPage({ editingId, onSaved, onCancel }: AddEditPageProps) {
  const { toast } = useToast();
  const [question, setQuestion] = useState<Question | null>(null);

  useEffect(() => {
    if (!editingId) {
      setQuestion(null);
      return;
    }
    window.api.getQuestion(editingId).then(setQuestion).catch((error) => toast(error.message, 'error'));
  }, [editingId]);

  if (editingId && !question) return <div className="page">加载中...</div>;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{editingId ? '编辑错题' : '添加错题'}</h1>
          <p>把错因、解析和标签写清楚，后续复盘会省很多力气。</p>
        </div>
      </header>
      <QuestionForm initial={question} onCancel={onCancel} onSaved={(saved) => onSaved(saved.id)} />
    </div>
  );
}
