import { ImagePlus, Save, X } from 'lucide-react';
import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useModal } from './Modal';
import { useToast } from './Toast';
import {
  CATEGORIES,
  DIFFICULTIES,
  ERROR_REASONS,
  MATH_SUBJECTS,
  MASTERY_LEVELS,
  QUESTION_TYPES,
  SOURCES
} from '../../shared/options';
import type { Difficulty, MasteryLevel, MathSubject, Question, QuestionImage, QuestionInput } from '../../shared/types';

interface QuestionFormProps {
  initial?: Question | null;
  onCancel: () => void;
  onSaved: (question: Question) => void;
}

const defaultForm: QuestionInput = {
  title: '',
  content: '',
  wrong_thinking: '',
  wrong_solution: '',
  correct_solution: '',
  answer: '',
  subject: '高等数学',
  category: CATEGORIES[0],
  question_type: QUESTION_TYPES[0],
  error_reason: ERROR_REASONS[0],
  source: SOURCES[0],
  difficulty: DIFFICULTIES[1] as Difficulty,
  mastery_level: MASTERY_LEVELS[0] as MasteryLevel,
  note: '',
  tags: [],
  questionImageSources: [],
  solutionImageSources: []
};

function tagsToText(tags: string[]) {
  return tags.join('，');
}

function textToTags(text: string) {
  return text
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function ExistingImages({ images, onRemove }: { images: QuestionImage[]; onRemove: (image: QuestionImage) => void }) {
  const [urls, setUrls] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all(images.map(async (image) => [image.id, await window.api.getImageUrl(image.file_path)] as const)).then((items) => {
      if (cancelled) return;
      setUrls(Object.fromEntries(items.filter(([, info]) => info.exists).map(([id, info]) => [id, info.url])));
    });
    return () => {
      cancelled = true;
    };
  }, [images]);

  if (!images.length) return null;
  return (
    <div className="image-grid">
      {images.map((image) => (
        <figure className="image-thumb" key={image.id}>
          {urls[image.id] ? <img src={urls[image.id]} alt="已上传错题原图" /> : <div className="image-missing">图片文件不存在</div>}
          <button type="button" className="thumb-remove" title="移除图片" onClick={() => onRemove(image)}>
            <X size={14} />
          </button>
        </figure>
      ))}
    </div>
  );
}

export function QuestionForm({ initial, onCancel, onSaved }: QuestionFormProps) {
  const [form, setForm] = useState<QuestionInput>(defaultForm);
  const [tagText, setTagText] = useState('');
  const [questionImages, setQuestionImages] = useState<QuestionImage[]>([]);
  const { toast } = useToast();
  const modal = useModal();
  const [saving, setSaving] = useState(false);
  const isEditing = !!(initial?.id && initial.id > 0);

  useEffect(() => {
    if (!initial) {
      setForm(defaultForm);
      setTagText('');
      setQuestionImages([]);
      return;
    }
    setForm({
      title: initial.title,
      content: initial.content,
      wrong_thinking: initial.wrong_thinking || initial.wrong_solution,
      wrong_solution: initial.wrong_solution,
      correct_solution: initial.correct_solution,
      answer: initial.answer,
      subject: initial.subject || '高等数学',
      category: initial.category,
      question_type: initial.question_type,
      error_reason: initial.error_reason,
      source: initial.source,
      difficulty: initial.difficulty,
      mastery_level: initial.mastery_level,
      note: initial.note,
      tags: initial.tags,
      questionImageSources: [],
      solutionImageSources: []
    });
    setTagText(tagsToText(initial.tags));
    setQuestionImages(initial.question_images);
  }, [initial]);

  const newQuestionImageNames = useMemo(() => form.questionImageSources.map((item) => item.split(/[\\/]/).pop()), [form.questionImageSources]);

  function update<K extends keyof QuestionInput>(key: K, value: QuestionInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function pickImages() {
    const files = await window.api.chooseImages();
    update('questionImageSources', [...form.questionImageSources, ...files]);
  }

  async function removeExisting(image: QuestionImage) {
    const confirmed = await modal.confirm({ title: '移除图片', message: '确定移除这张错题原图吗？', confirmLabel: '移除' });
    if (!confirmed) return;
    const deleteFile = await modal.confirm({ title: '删除文件', message: '是否同时删除本地图片文件？', confirmLabel: '一并删除', danger: true });
    await window.api.removeImage(image.id, deleteFile);
    setQuestionImages((current) => current.filter((item) => item.id !== image.id));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.title.trim()) {
      toast('请填写题目标题', 'warning');
      return;
    }
    setSaving(true);
    try {
      const payload = { ...form, title: form.title.trim(), tags: textToTags(tagText), solutionImageSources: [] };
      const saved = isEditing && initial ? await window.api.updateQuestion(initial.id, payload) : await window.api.createQuestion(payload);
      onSaved(saved);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="question-form" onSubmit={submit}>
      <section className="form-section">
        <h2>基础信息</h2>
        <label>
          题目标题
          <input value={form.title} onChange={(event) => update('title', event.target.value)} placeholder="例如：二重积分换元范围判断错误" />
        </label>
        <label>
          题目内容
          <textarea value={form.content} onChange={(event) => update('content', event.target.value)} rows={5} />
        </label>
        <div className="form-grid">
          <label>
            学科
            <select value={form.subject || '高等数学'} onChange={(event) => update('subject', event.target.value as MathSubject)}>
              {MATH_SUBJECTS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            章节分类
            <select value={form.category} onChange={(event) => update('category', event.target.value)}>
              {CATEGORIES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            题型分类
            <select value={form.question_type} onChange={(event) => update('question_type', event.target.value)}>
              {QUESTION_TYPES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            错误原因
            <select value={form.error_reason} onChange={(event) => update('error_reason', event.target.value)}>
              {ERROR_REASONS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            题目来源
            <select value={form.source} onChange={(event) => update('source', event.target.value)}>
              {SOURCES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            难度
            <select value={form.difficulty} onChange={(event) => update('difficulty', event.target.value as Difficulty)}>
              {DIFFICULTIES.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            掌握程度
            <select value={form.mastery_level} onChange={(event) => update('mastery_level', event.target.value as MasteryLevel)}>
              {MASTERY_LEVELS.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="form-section">
        <h2>解题与解析</h2>
        <label>
          我的错误思考
          <textarea
            value={form.wrong_thinking}
            onChange={(event) => {
              update('wrong_thinking', event.target.value);
              update('wrong_solution', event.target.value);
            }}
            rows={5}
          />
        </label>
        <label>
          正确解析
          <textarea value={form.correct_solution} onChange={(event) => update('correct_solution', event.target.value)} rows={6} />
        </label>
        <label>
          正确答案
          <input value={form.answer} onChange={(event) => update('answer', event.target.value)} />
        </label>
      </section>

      <section className="form-section">
        <h2>错题原图</h2>
        <div className="upload-row">
          <button type="button" className="secondary-button" onClick={pickImages}>
            <ImagePlus size={16} />
            上传错题原图
          </button>
        </div>
        <ExistingImages images={questionImages} onRemove={removeExisting} />
        {newQuestionImageNames.length ? <p className="file-list">新增错题原图：{newQuestionImageNames.join('、')}</p> : null}
      </section>

      <section className="form-section">
        <h2>标签与备注</h2>
        <label>
          标签
          <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="用逗号分隔，例如：换元，易错，真题" />
        </label>
        <label>
          备注
          <textarea value={form.note} onChange={(event) => update('note', event.target.value)} rows={4} />
        </label>
      </section>

      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="primary-button" disabled={saving}>
          <Save size={16} />
          {saving ? '保存中...' : isEditing ? '保存修改' : '保存错题'}
        </button>
      </div>
    </form>
  );
}
