import type { AiDiagnosisResult, AiStructuredQuestion, DeepSeekSettings } from '../../shared/types';
import { getDatabase } from './databaseService';

const DEFAULT_SETTINGS: DeepSeekSettings = {
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com/v1'
};

export async function getDeepSeekSettings(): Promise<DeepSeekSettings> {
  const db = await getDatabase();
  try {
    const row = db.exec("SELECT value FROM app_settings WHERE key = 'deepseek'");
    if (row.length && row[0].values.length) {
      const parsed = JSON.parse(row[0].values[0][0] as string);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch { /* not yet configured */ }
  return DEFAULT_SETTINGS;
}

export async function saveDeepSeekSettings(settings: DeepSeekSettings): Promise<DeepSeekSettings> {
  const db = await getDatabase();
  db.run("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const jsonValue = JSON.stringify(settings);
  const escaped = jsonValue.replace(/'/g, "''");
  db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('deepseek', '${escaped}')`);
  return settings;
}

async function callDeepSeek(systemPrompt: string, userMessage: string): Promise<string> {
  const settings = await getDeepSeekSettings();
  if (!settings.apiKey) throw new Error('请先在设置中配置 DeepSeek API Key');

  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || '';
}

const STRUCTURE_SYSTEM_PROMPT = `你是考研数学错题整理专家。从 OCR 识别的文本中提取错题信息，返回严格 JSON。

字段说明：
- title: 简短的题目标题（15字以内）
- content: 题目完整内容（保留数学符号，用 $$ 包裹 LaTeX 公式）
- wrong_thinking: 如果文本包含"我的错误思考"内容则提取，否则根据常见错误推测
- correct_solution: 正确解析过程（用 $$ 包裹 LaTeX）
- answer: 最终答案
- subject: 学科（高等数学/线性代数/概率论/其他）
- category: 章节（如：一元函数微分学/多元函数积分学/矩阵理论...）
- question_type: 题型（选择题/填空题/解答题）
- error_reason: 错因（计算错误/概念不清/方法选择错误/审题不清/公式记错/其他）
- difficulty: 难度（简单/中等/困难/压轴）
- tags: 标签数组
- knowledge_points: 相关知识点数组
- raw_ocr_text: 原始 OCR 文本（原样保留）

只返回 JSON，不要其他文字。`;

export async function structureQuestion(ocrTexts: string[]): Promise<AiStructuredQuestion> {
  const combined = ocrTexts.map((t, i) => `[图片 ${i + 1} OCR 文本]\n${t}`).join('\n\n---\n\n');
  const result = await callDeepSeek(STRUCTURE_SYSTEM_PROMPT, combined);
  // 提取 JSON（DeepSeek 可能包裹在 ```json 中）
  const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/) || result.match(/(\{[\s\S]*\})/);
  const jsonText = jsonMatch ? jsonMatch[1].trim() : result.trim();
  try {
    const parsed = JSON.parse(jsonText);
    return {
      title: parsed.title || '',
      content: parsed.content || '',
      wrong_thinking: parsed.wrong_thinking || '',
      correct_solution: parsed.correct_solution || '',
      answer: parsed.answer || '',
      subject: parsed.subject || '高等数学',
      category: parsed.category || '其他',
      question_type: parsed.question_type || '解答题',
      error_reason: parsed.error_reason || '其他',
      difficulty: parsed.difficulty || '中等',
      tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      knowledge_points: Array.isArray(parsed.knowledge_points) ? parsed.knowledge_points : [],
      raw_ocr_text: combined
    };
  } catch {
    throw new Error(`AI 返回格式异常，无法解析为 JSON。原始响应：${result.slice(0, 500)}`);
  }
}

const DIAGNOSIS_SYSTEM_PROMPT = `你是考研数学辅导专家。分析错题的错误思考，诊断知识盲点。

返回严格 JSON：
{
  "knowledgeBlindSpot": "知识盲点分析（1-2句话）",
  "suggestedKnowledgePoints": ["知识点1", "知识点2"],
  "suggestedReviewDirection": "复习建议（1-2句话）"
}

只返回 JSON，不要其他文字。`;

export async function diagnoseError(questionContent: string, questionAnswer: string, wrongThinking: string, correctSolution: string): Promise<AiDiagnosisResult> {
  const userMessage = [
    '## 题目内容',
    questionContent || '（无）',
    '## 正确答案',
    questionAnswer || '（无）',
    '## 我的错误思考',
    wrongThinking || '（无）',
    '## 正确解析',
    correctSolution || '（无）'
  ].join('\n\n');

  const result = await callDeepSeek(DIAGNOSIS_SYSTEM_PROMPT, userMessage);
  const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/) || result.match(/(\{[\s\S]*\})/);
  const jsonText = jsonMatch ? jsonMatch[1].trim() : result.trim();
  try {
    const parsed = JSON.parse(jsonText);
    return {
      knowledgeBlindSpot: parsed.knowledgeBlindSpot || '',
      suggestedKnowledgePoints: Array.isArray(parsed.suggestedKnowledgePoints) ? parsed.suggestedKnowledgePoints : [],
      suggestedReviewDirection: parsed.suggestedReviewDirection || '',
      rawResponse: result
    };
  } catch {
    return {
      knowledgeBlindSpot: result.slice(0, 200),
      suggestedKnowledgePoints: [],
      suggestedReviewDirection: '',
      rawResponse: result
    };
  }
}
