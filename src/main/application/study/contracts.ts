import { validateStudyCommand, validateStudyQuery } from '../../../shared/agent/v1/schemas';
import type { StudyCommand, StudyCommandValues, StudyQuery, StudyQueryValues } from '../../../shared/agent/v1/contracts';
export type { StudyCommand, StudyCommandValues, StudyQuery, StudyQueryValues };
export const studyCommandTypes = Object.freeze(['study.create_plan_draft', 'study.apply_plan_adjustment', 'study.record_manual_progress'] as const);
export const studyQueryTypes = Object.freeze(['study.get_today', 'study.get_week_summary'] as const);
export { validateStudyCommand, validateStudyQuery };
