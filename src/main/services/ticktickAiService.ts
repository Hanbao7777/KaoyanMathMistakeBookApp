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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
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
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DeepSeek API 错误 ${response.status}: ${text}`);
    }

    const data = await response.json() as any;
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractJson(text: string): any {
  try { return JSON.parse(text); } catch {}

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }

  // Try balanced-brace extraction for objects
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

  // Try balanced-bracket extraction for arrays
  depth = 0;
  start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === ']') {
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

  // Detect if the goal is math-related
  const mathKeywords = ['数学', '高数', '线代', '概率', '错题', '复习', '极限', '导数', '积分', '微分', '级数', '考研'];
  const isMathGoal = mathKeywords.some(kw => input.goal.includes(kw));

  let extraContext = '';
  if (isMathGoal) {
    const weakResult = db.exec(
      `SELECT kp.title, kp.category, COUNT(q.id) as question_count
       FROM knowledge_points kp
       LEFT JOIN question_knowledge_points qkp ON kp.node_id = qkp.knowledge_node_id
       LEFT JOIN questions q ON qkp.question_id = q.id
       WHERE q.mastery_level IN ('未掌握', '较弱')
       GROUP BY kp.node_id
       ORDER BY question_count DESC LIMIT 5`
    );
    if (weakResult.length && weakResult[0].values.length) {
      extraContext = '\n相关薄弱知识点（仅供参考，仅当与目标相关时纳入）：\n' +
        weakResult[0].values.map((r: any[]) => `- ${r[0]} (${r[1]}, ${r[2]}道错题)`).join('\n');
    }
  }

  const systemPrompt = `你是一个智能任务拆解助手。用户给你一个目标，你将其拆解为具体可执行的子任务。

规则：
1. 严格按照用户输入的目标来拆解，不要添加不相关的任务
2. 如果用户提到了时间约束（如"70分钟"），合理分配总时长
3. 如果用户提到了优先级，每个子任务的priority字段体现（高/中/低）
4. 每个子任务要具体、可量化、可直接执行
5. 标签用中文，描述任务类型

输出格式（严格 JSON）：
{
  "subtasks": [
    {
      "title": "具体任务描述",
      "estimated_minutes": 30,
      "priority": "高/中/低",
      "deadline_days": 0,
      "tags": ["标签1", "标签2"],
      "knowledge_points": []
    }
  ],
  "total_minutes": 120
}

deadline_days: 0=今天, 1=明天, 以此类推。根据任务紧急程度和总时长合理分配。`;

  const userMessage = `目标：${input.goal}${extraContext}
${input.context?.availableDays ? `用户预计可用天数：${input.context.availableDays}` : ''}
${input.context?.weakKnowledgePoints?.length ? `用户提到的薄弱点：${input.context.weakKnowledgePoints.join('、')}` : ''}

请拆解为具体可行的子任务。每个子任务要有清晰的标题、合理的预计时长和优先级。`;

  const raw = await callDeepSeek(systemPrompt, userMessage, 2048);
  const json = extractJson(raw);

  return {
    subtasks: (json.subtasks || []).map((t: any) => ({
      title: t.title || '',
      estimated_minutes: t.estimated_minutes || 30,
      estimated_days: Math.max(1, Math.ceil((t.estimated_minutes || 30) / 60)),
      priority: t.priority || 'none',
      deadline_days: t.deadline_days ?? Math.ceil((json.total_minutes || 60) / 60),
      tags: t.tags || [],
      knowledge_points: t.knowledge_points || [],
    })),
    total_minutes: json.total_minutes || 60,
    total_days: Math.max(1, Math.ceil((json.total_minutes || 60) / 60)),
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
     GROUP BY q.id
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

  const hasMathData = reviewContext || overdueContext;

  const systemPrompt = `你是一个智能日程规划助手。根据用户提供的数据，生成今日建议任务列表。

规则：
1. 如果有待复习内容，优先安排
2. 如果有过期任务，提醒用户处理
3. 合理分配时间到上午、下午、晚上三个时间块
4. 任务要具体、可执行

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
${hasMathData ? `
到期复习错题：
${reviewContext || '无到期复习'}

过期未完成任务：
${overdueContext || '无过期任务'}
` : ''}
请生成今日计划建议。${hasMathData ? '优先安排薄弱知识点的复习，' : ''}合理分配时间块。`;

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

  // For weekly, use last 7 days; for daily, use today only
  const rangeStart = type === 'weekly' ? (() => {
    const d = new Date();
    d.setDate(d.getDate() - 6);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })() : today;
  const rangeEnd = today;

  const taskResult = db.exec(
    `SELECT COUNT(*) as total, SUM(CASE WHEN is_completed = 1 THEN 1 ELSE 0 END) as done
     FROM ticktick_tasks WHERE parent_id IS NULL AND due_date >= ? AND due_date <= ?`, [rangeStart, rangeEnd]
  );
  const total = taskResult.length ? taskResult[0].values[0][0] as number : 0;
  const done = taskResult.length ? taskResult[0].values[0][1] as number : 0;
  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;

  const focusResult = db.exec(
    `SELECT COALESCE(SUM(duration_minutes), 0) FROM ticktick_focus_sessions
     WHERE date(start_time) >= ? AND date(start_time) <= ? AND session_type = 'focus'`, [rangeStart, rangeEnd]
  );
  const focusMinutes = focusResult.length ? focusResult[0].values[0][0] as number : 0;

  const reviewResult2 = db.exec(
    `SELECT COUNT(*) as total, SUM(CASE WHEN result = 'correct' THEN 1 ELSE 0 END) as correct
     FROM review_logs WHERE review_date >= ? AND review_date <= ?`, [rangeStart, rangeEnd]
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
