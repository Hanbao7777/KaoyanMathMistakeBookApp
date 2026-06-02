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
  const stmt = db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");
  try {
    stmt.bind(['deepseek', jsonValue]);
    stmt.step();
  } finally {
    stmt.free();
  }
  return settings;
}

async function callDeepSeek(systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
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
      max_tokens: maxTokens
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`DeepSeek API 错误 (${response.status}): ${errorText}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || '';
}

const STRUCTURE_SYSTEM_PROMPT = `你是考研数学辅导专家，从 OCR 文本中还原并整理错题。

OCR 文本可能有识别错误（导数上标丢失、符号混淆、括号错位等），请根据数学知识主动修正还原。
所有数学公式必须用 $$ 包裹，确保 LaTeX 可直接渲染。

字段要求：
- title: "考点 + 动作 + 对象"，如"高阶导数判定极值"、"二重积分换序求值"，≤15字
- content: 完整还原题目原文，保留所有条件和问题，公式修正后放入 $$
- wrong_thinking: 推测学生可能的错误思考（≥1句具体描述），不要写"计算错误"这种泛泛的词
- correct_solution: 完整解析过程。不限步骤数，大题可包含推导链、分类讨论、多种解法。每步写明原理和计算，公式用 $$。即使 OCR 遗漏了步骤也要根据数学知识补全
- answer: 最终答案的完整数学表达式或数值。如果是证明题写结论，如果是大题写最终结果。不要说"详见上"、"正确"这类占位词
- subject: 高等数学/线性代数/概率论/其他
- category: 必须从以下章节中选择一个：函数、极限、连续/一元函数微分学/一元函数积分学/多元函数微积分学/常微分方程/无穷级数/行列式与矩阵/线性方程组与向量/特征值与二次型/概率论/其他
- question_type: 选择题/填空题/解答题/证明题
- error_reason: 计算错误/概念不清/方法选择错误/审题不清/公式记错/逻辑漏洞/其他
- difficulty: 简单/中等/困难/压轴
- tags: 3-5个关键词
- knowledge_points: 2-4个关联考点，优先从以下考点中选择：
  高等数学：数列敛散性的判定、函数极限的计算、无穷小量、确定极限中的参数、函数的连续性和间断点的类型、曲率与曲率半径、导数和微分的概念、导数和微分的计算、导数的应用、函数的单调性极值和最值、曲线的凹凸性拐点及渐近线、方程根的存在性和个数、不等式的证明、微分中值定理、泰勒公式、不定积分的计算、定积分的概念和性质、定积分的计算、变限积分、反常积分的计算和敛散性、定积分的应用、一元函数积分学综合题、偏导数的概念和计算、全微分的概念和计算、多元函数的极值问题、二重积分的概念和性质、二次积分和变换积分次序、二重积分的计算、二重积分的应用、可分离变量的微分方程、一阶线性微分方程、常系数齐次线性微分方程、微分方程的解和线性微分方程的解的结构、其他方程、二阶常系数非齐次线性微分方程、微分方程的应用
  线性代数：矩阵的运算和变换、伴随矩阵和可逆矩阵、矩阵的秩、向量组的线性相关性、向量组之间的线性表示、特征值和特征向量、矩阵的相似和相似对角化
- raw_ocr_text: 原始 OCR 文本（原样保留）

只返回 JSON，不要其他文字。`;

function buildQuestion(parsed: Record<string, unknown>, rawOcr: string): AiStructuredQuestion {
  return {
    title: (parsed.title as string) || '',
    content: (parsed.content as string) || '',
    wrong_thinking: (parsed.wrong_thinking as string) || '',
    correct_solution: (parsed.correct_solution as string) || '',
    answer: (parsed.answer as string) || '',
    subject: (parsed.subject as string) || '高等数学',
    category: (parsed.category as string) || '其他',
    question_type: (parsed.question_type as string) || '解答题',
    error_reason: (parsed.error_reason as string) || '其他',
    difficulty: (parsed.difficulty as string) || '中等',
    tags: Array.isArray(parsed.tags) ? parsed.tags as string[] : [],
    knowledge_points: Array.isArray(parsed.knowledge_points) ? parsed.knowledge_points as string[] : [],
    raw_ocr_text: rawOcr
  };
}

function extractJson(text: string): Record<string, unknown> {
  // 1) Try raw response directly (most common case)
  try { return JSON.parse(text.trim()); } catch { /* fall through */ }

  // 2) Extract from ```json ... ``` wrapper
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
    return extractJson(fenceMatch[1].trim()); // Recurse without fence
  }

  // 3) Balanced-brace extraction: find first { and track depth
  const start = text.indexOf('{');
  if (start === -1) throw new Error('AI 返回格式异常，未找到 JSON 对象');

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const extracted = text.slice(start, i + 1);
        return JSON.parse(extracted);
      }
    }
  }

  throw new Error('AI 输出被截断（可能 token 不足），请重试');
}

export async function structureQuestion(ocrTexts: string[]): Promise<AiStructuredQuestion> {
  const combined = ocrTexts.map((t, i) => `[图片 ${i + 1} OCR 文本]\n${t}`).join('\n\n---\n\n');
  const result = await callDeepSeek(STRUCTURE_SYSTEM_PROMPT, combined, 16384);
  try {
    const parsed = extractJson(result);
    return buildQuestion(parsed, combined);
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
  try {
    const parsed = extractJson(result);
    return {
      knowledgeBlindSpot: (parsed.knowledgeBlindSpot as string) || result.slice(0, 200),
      suggestedKnowledgePoints: Array.isArray(parsed.suggestedKnowledgePoints) ? parsed.suggestedKnowledgePoints as string[] : [],
      suggestedReviewDirection: (parsed.suggestedReviewDirection as string) || '',
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
