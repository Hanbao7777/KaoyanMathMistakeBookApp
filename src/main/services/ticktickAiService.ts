import { getDeepSeekSettings } from './deepseekService';
import { getDatabase } from './databaseService';
import { getTickTickSettings } from './ticktickService';
import type {
  TickTickAiDecompositionInput, TickTickAiDecompositionResult,
  TickTickAiDailyPlanResult, TickTickAiReviewResult,
} from '../../shared/types';

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function callDeepSeek(systemPrompt: string, userMessage: string, maxTokens = 4096): Promise<string> {
  const settings = await getDeepSeekSettings();
  if (!settings.apiKey) throw new Error('请先在设置中配置 DeepSeek API Key');

  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek API 错误 ${response.status}: ${text}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

function extractJson(text: string): any {
  try { return JSON.parse(text); } catch {}

  const fenceMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }

  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { start = -1; }
      }
    }
  }
  throw new Error('无法从 AI 响应中提取 JSON');
}

// ── Task Decomposition ──

export async function aiDecomposeTask(input: TickTickAiDecompositionInput): Promise<TickTickAiDecompositionResult> {
  const db = await getDatabase();
  const today = todayStr();

  const weakResult = db.exec(
    `SELECT kp.title, kp.category, COUNT(q.id) as question_count
     FROM knowledge_points kp
     LEFT JOIN question_knowledge_points qkp ON kp.node_id = qkp.knowledge_node_id
     LEFT JOIN questions q ON qkp.question_id = q.id
     WHERE q.mastery_level IN ('未掌握', '较弱')
     GROUP BY kp.node_id
     ORDER BY question_count DESC LIMIT 10`
  );

  let weakContext = '';
  if (weakResult.length && weakResult[0].values.length) {
    weakContext = weakResult[0].values.map((r: any[]) => `- ${r[0]} (${r[1]}, ${r[2]}道错题)`).join('\n');
  }

  const systemPrompt = `你是一个考研数学学习规划助手。根据用户的学习目标，拆解为具体的每日任务。
输出格式（严格 JSON）：
{
  "subtasks": [
    { "title": "具体任务描述", "estimated_days": 2, "tags": ["刷题", "复习"], "knowledge_points": ["知识点名称"] }
  ],
  "total_days": 15
}`;

  const userMessage = `学习目标：${input.goal}${input.context?.availableDays ? `\n可用天数：${input.context.availableDays} 天` : ''}
当前薄弱知识点：
${weakContext || '无数据'}
${input.context?.weakKnowledgePoints?.length ? `\n用户指定的薄弱点：${input.context.weakKnowledgePoints.join('、')}` : ''}
请拆解为具体可行的每日任务。每个任务要具体、可执行，标签用中文。`;

  const raw = await callDeepSeek(systemPrompt, userMessage, 2048);
  const json = extractJson(raw);

  return {
    subtasks: json.subtasks || [],
    total_days: json.total_days || 0,
  };
}

// ── Daily Plan Generation ──

export async function aiGenerateDailyPlan(): Promise<TickTickAiDailyPlanResult> {
  const db = await getDatabase();
  const today = todayStr();
  const settings = await getTickTickSettings();

  const reviewResult = db.exec(
    `SELECT q.id, q.title, q.subject, q.mastery_level, kp.title as kp_title
     FROM questions q LEFT JOIN question_knowledge_points qkp ON q.id = qkp.question_id
     LEFT JOIN knowledge_points kp ON qkp.knowledge_node_id = kp.node_id
     WHERE q.next_review_at IS NOT NULL AND date(q.next_review_at) <= ?
     ORDER BY q.mastery_level ASC LIMIT 15`, [today]
  );

  let reviewContext = '';
  if (reviewResult.length && reviewResult[0].values.length) {
    reviewContext = reviewResult[0].values.map((r: any[]) =>
      `- ${r[1]} (掌握度:${r[3]}, 知识点:${r[4] || '未知'})`).join('\n');
  }

  const overdueResult = db.exec(
    "SELECT title FROM ticktick_tasks WHERE due_date < ? AND is_completed = 0 AND parent_id IS NULL LIMIT 10", [today]
  );

  let overdueContext = '';
  if (overdueResult.length && overdueResult[0].values.length) {
    overdueContext = overdueResult[0].values.map((r: any[]) => `- ${r[0]}`).join('\n');
  }

  const studyResult = db.exec("SELECT daily_target_minutes FROM study_settings LIMIT 1");
  const dailyTarget = studyResult.length && studyResult[0].values.length ? studyResult[0].values[0][0] : 120;

  const systemPrompt = `你是一个考研学习日程规划助手。根据用户的学习数据，生成今日建议任务列表。
输出格式（严格 JSON）：
{
  "suggested_tasks": [
    { "title": "任务描述", "time_block": "上午/下午/晚上", "priority": "高/中/低", "estimated_minutes": 45, "reason": "推荐理由" }
  ],
  "summary": "今日总体建议"
}`;

  const userMessage = `今日日期：${today}
每日学习目标：${dailyTarget} 分钟
番茄钟设置：专注${settings.pomodoro.focusMinutes}分钟/休息${settings.pomodoro.shortBreakMinutes}分钟

到期复习错题：
${reviewContext || '无到期复习'}

过期未完成任务：
${overdueContext || '无过期任务'}

请生成今日学习计划建议。优先安排薄弱知识点的复习，合理分配时间块。`;

  const raw = await callDeepSeek(systemPrompt, userMessage, 2048);
  const json = extractJson(raw);

  return {
    suggested_tasks: (json.suggested_tasks || []).map((t: any) => ({
      ...t,
      linked_type: null,
      linked_id: null,
    })),
    summary: json.summary || '今日建议已生成',
  };
}

// ── AI Review ──

export async function aiGenerateReview(type: 'daily' | 'weekly'): Promise<TickTickAiReviewResult> {
  const db = await getDatabase();
  const today = todayStr();

  const taskResult = db.exec(
    `SELECT COUNT(*) as total, SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as done
     FROM ticktick_tasks WHERE parent_id IS NULL AND due_date = ?`, [today]
  );
  const total = taskResult.length ? taskResult[0].values[0][0] as number : 0;
  const done = taskResult.length ? taskResult[0].values[0][1] as number : 0;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const focusResult = db.exec(
    `SELECT COALESCE(SUM(duration_minutes), 0) FROM ticktick_focus_sessions
     WHERE date(start_time) = ? AND session_type = 'focus'`, [today]
  );
  const focusMinutes = focusResult.length ? focusResult[0].values[0][0] as number : 0;

  const reviewResult2 = db.exec(
    `SELECT COUNT(*) as total, SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) as correct
     FROM review_logs WHERE review_date = ?`, [today]
  );
  const reviewTotal = reviewResult2.length ? reviewResult2[0].values[0][0] as number : 0;
  const reviewCorrect = reviewResult2.length ? reviewResult2[0].values[0][1] as number : 0;
  const correctRate = reviewTotal > 0 ? Math.round((reviewCorrect / reviewTotal) * 100) : null;

  const systemPrompt = `你是一个考研学习复盘助手。根据用户的学习数据，给出简短建议。
输出格式（严格 JSON）：
{ "completion_rate": 80, "total_focus_minutes": 120, "correct_rate": 70, "weak_points": ["薄弱点"], "suggestion": "建议内容" }`;

  const userMessage = `${type === 'daily' ? '今日' : '本周'}复盘数据：
- 任务完成率：${completionRate}%（${done}/${total}）
- 专注时长：${focusMinutes} 分钟
- 错题复习正确率：${correctRate !== null ? correctRate + '%' : '无数据'}
${type === 'weekly' ? '\n请根据本周整体趋势给出下周学习建议。' : '\n请给出明天简短建议（50字以内）。'}`;

  const raw = await callDeepSeek(systemPrompt, userMessage, 1024);
  const json = extractJson(raw);

  return {
    completion_rate: json.completion_rate ?? completionRate,
    total_focus_minutes: json.total_focus_minutes ?? focusMinutes,
    correct_rate: json.correct_rate ?? correctRate ?? 0,
    weak_points: json.weak_points || [],
    suggestion: json.suggestion || '继续加油！',
  };
}
