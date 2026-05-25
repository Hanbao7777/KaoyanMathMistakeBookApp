import { Brain, Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { AiDiagnosisResult } from '../../shared/types';
import { useToast } from './Toast';

interface AiDiagnosisPanelProps {
  questionId: number;
}

export function AiDiagnosisPanel({ questionId }: AiDiagnosisPanelProps) {
  const { toast } = useToast();
  const [result, setResult] = useState<AiDiagnosisResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function diagnose() {
    setLoading(true);
    setResult(null);
    try {
      const r = await window.api.diagnoseError(questionId);
      setResult(r);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="section-card ai-diagnosis-panel">
      <div className="section-header">
        <h2><Brain size={18} /> AI 错因诊断</h2>
        {!result ? (
          <button
            className={`primary-button ${loading ? 'button-loading' : ''}`}
            type="button"
            onClick={diagnose}
            disabled={loading}
          >
            <Brain size={16} />
            {loading ? '分析中...' : '开始诊断'}
          </button>
        ) : null}
      </div>

      {result ? (
        <div className="ai-diagnosis-result">
          <div className="ai-diagnosis-section">
            <strong>知识盲点</strong>
            <p>{result.knowledgeBlindSpot}</p>
          </div>
          {result.suggestedKnowledgePoints.length > 0 ? (
            <div className="ai-diagnosis-section">
              <strong>建议回顾知识点</strong>
              <div className="tag-row">
                {result.suggestedKnowledgePoints.map((kp, i) => (
                  <span key={i} className="tag tag-warning">{kp}</span>
                ))}
              </div>
            </div>
          ) : null}
          {result.suggestedReviewDirection ? (
            <div className="ai-diagnosis-section">
              <strong>复习建议</strong>
              <p>{result.suggestedReviewDirection}</p>
            </div>
          ) : null}
          <button className="secondary-button compact-button" type="button" onClick={() => setResult(null)}>
            重新诊断
          </button>
        </div>
      ) : !loading ? (
        <p className="muted-text">让 AI 分析这道错题的知识盲点和复习方向。</p>
      ) : null}
    </section>
  );
}
