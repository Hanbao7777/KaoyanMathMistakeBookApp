export interface ParsedTaskInput {
  title: string;
  due_date: string | null;
  due_time: string | null;
  priority: 'none' | '低' | '中' | '高';
  tags: string[];
  list_name: string | null;
  recurrence_rule: string | null;
  estimated_minutes: number;
}

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAY_MAP: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0
};

function parseDateWord(word: string): string | null {
  switch (word) {
    case '今天': return todayDate();
    case '明天': return addDays(1);
    case '后天': return addDays(2);
    case '大后天': return addDays(3);
    default: return null;
  }
}

function parseRelativeDay(text: string): string | null {
  const match = text.match(/^(\d+)天后$/);
  if (match) return addDays(parseInt(match[1], 10));
  return null;
}

function parseWeekday(text: string): string | null {
  const m1 = text.match(/^下?周([一二三四五六日天])$/);
  if (m1) {
    const target = WEEKDAY_MAP[m1[1]];
    const now = new Date();
    const currentDay = now.getDay();
    let diff = target - currentDay;
    if (text.startsWith('下')) diff += 7;
    else if (diff <= 0) diff += 7;
    return addDays(diff);
  }
  return null;
}

function parseAbsoluteDate(text: string): string | null {
  const m1 = text.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (m1) {
    const year = new Date().getFullYear();
    const month = parseInt(m1[1], 10);
    const day = parseInt(m1[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const m2 = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m2) {
    return `${m2[1]}-${String(parseInt(m2[2], 10)).padStart(2, '0')}-${String(parseInt(m2[3], 10)).padStart(2, '0')}`;
  }
  const m3 = text.match(/^下个月(\d{1,2})[日号]?$/);
  if (m3) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 2;
    const day = parseInt(m3[1], 10);
    if (month > 12) return `${year + 1}-${String(month - 12).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function parseTimeWord(word: string): string | null {
  const timeMap: Record<string, string> = {
    '早上': '08:00', '上午': '09:00', '中午': '12:00',
    '下午': '14:00', '傍晚': '17:00', '晚上': '20:00', '今晚': '20:00'
  };
  if (timeMap[word]) return timeMap[word];

  const m1 = word.match(/^(\d{1,2})点(半|(\d{1,2})分?)?$/);
  if (m1) {
    const hour = parseInt(m1[1], 10);
    const minute = m1[2] === '半' ? 30 : (m1[2] ? parseInt(m1[2], 10) : 0);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const m2 = word.match(/^(\d{1,2}):(\d{2})$/);
  if (m2) {
    return `${String(parseInt(m2[1], 10)).padStart(2, '0')}:${m2[2]}`;
  }
  const m3 = word.match(/^(早上|上午|中午|下午|傍晚|晚上|今晚)(\d{1,2})点(半|(\d{1,2})分?)?$/);
  if (m3) {
    const base = timeMap[m3[1]] || '12:00';
    const hour = parseInt(m3[2], 10);
    const minute = m3[3] === '半' ? 30 : (m3[3] ? parseInt(m3[3], 10) : 0);
    const adjustedHour = (m3[1] === '下午' || m3[1] === '傍晚' || m3[1] === '晚上' || m3[1] === '今晚')
      ? (hour === 12 ? 12 : hour + 12)
      : hour;
    return `${String(adjustedHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  return null;
}

function parseRecurrence(text: string): string | null {
  if (/^每[天天日]$/.test(text)) return 'daily';
  const m1 = text.match(/^每周([一二三四五六日天])$/);
  if (m1) return `weekly:${WEEKDAY_MAP[m1[1]]}`;
  const m2 = text.match(/^每个?月(\d{1,2})[日号]$/);
  if (m2) return `monthly:${parseInt(m2[1], 10)}`;
  if (/^每个?工作日$/.test(text)) return 'weekly:1,2,3,4,5';
  if (/^每个?周末$/.test(text)) return 'weekly:6,0';
  return null;
}

export function parseTaskInput(raw: string): ParsedTaskInput {
  const result: ParsedTaskInput = {
    title: raw.trim(),
    due_date: null,
    due_time: null,
    priority: 'none',
    tags: [],
    list_name: null,
    recurrence_rule: null,
    estimated_minutes: 0,
  };

  if (!result.title) return result;

  // Extract estimated minutes
  const estMatch = result.title.match(/预计(\d+)(分钟|分)/);
  if (estMatch) {
    result.estimated_minutes = parseInt(estMatch[1], 10);
    result.title = result.title.replace(estMatch[0], '').trim();
  }

  // Extract priority !!高 !!中 !!低
  const priorityMatch = result.title.match(/!!(高|中|低)/);
  if (priorityMatch) {
    result.priority = priorityMatch[1] as '高' | '中' | '低';
    result.title = result.title.replace(priorityMatch[0], '').trim();
  }

  // Extract tags #tag
  const tagMatches = result.title.match(/#(\S+)/g);
  if (tagMatches) {
    result.tags = tagMatches.map(t => t.slice(1));
    for (const m of tagMatches) { result.title = result.title.replace(m, '').trim(); }
  }

  // Extract list @list
  const listMatch = result.title.match(/@(\S+)/);
  if (listMatch) {
    result.list_name = listMatch[1];
    result.title = result.title.replace(listMatch[0], '').trim();
  }

  // Extract recurrence at end
  const recPatterns = [/每天$/, /每日$/, /每周[一二三四五六日天]$/, /每[个]?月\d{1,2}[日号]$/, /每[个]?工作日$/, /每[个]?周末$/];
  for (const pattern of recPatterns) {
    const m = result.title.match(pattern);
    if (m) {
      result.recurrence_rule = parseRecurrence(m[0]);
      if (result.recurrence_rule) {
        result.title = result.title.replace(m[0], '').trim();
        break;
      }
    }
  }

  // Extract compound date+time: "明天下午3点"
  const dateTimeMatch = result.title.match(/(今天|明天|后天|大后天|\d+天后|下?周[一二三四五六日天]|\d{1,2}月\d{1,2}[日号]?)(早上|上午|中午|下午|傍晚|晚上|今晚)?(\d{1,2})?(点(半|(\d{1,2})分?)?)?/);
  if (dateTimeMatch) {
    const datePart = dateTimeMatch[1];
    const timePrefix = dateTimeMatch[2] || '';
    const hourPart = dateTimeMatch[3] || '';
    const minuteSuffix = dateTimeMatch[4] || '';

    const parsedDate = parseDateWord(datePart) || parseRelativeDay(datePart) || parseWeekday(datePart) || parseAbsoluteDate(datePart);
    if (parsedDate) result.due_date = parsedDate;

    if (hourPart) {
      const timeStr = timePrefix + hourPart + minuteSuffix;
      result.due_time = parseTimeWord(timeStr) || parseTimeWord(hourPart + minuteSuffix);
    }

    result.title = result.title.replace(dateTimeMatch[0], '').trim();
  }

  // Try standalone time HH:MM
  if (!result.due_time) {
    const timeMatch = result.title.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      result.due_time = timeMatch[0];
      result.title = result.title.replace(timeMatch[0], '').trim();
    }
  }

  // Clean up
  result.title = result.title.replace(/\s{2,}/g, ' ').trim();

  return result;
}
