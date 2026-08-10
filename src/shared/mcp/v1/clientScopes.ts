import type { AgentScope } from '../../agent/v1/gatewayContracts';

export interface McpClientScopeGroup {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly scopes: readonly AgentScope[];
}

function scopeGroup(
  id: string,
  label: string,
  description: string,
  scopes: readonly AgentScope[]
): McpClientScopeGroup {
  return Object.freeze({ id, label, description, scopes: Object.freeze([...scopes]) });
}

export const mcpClientScopeGroups: readonly McpClientScopeGroup[] = Object.freeze([
  scopeGroup('questions', '错题与复习', '读取、创建、修改、归档错题并记录复习结果。', [
    'questions.read', 'questions.write', 'questions.archive', 'reviews.read', 'reviews.submit'
  ]),
  scopeGroup('knowledge', '知识与学习', '读取和绑定知识点、教材元数据、薄弱点分析与学习计划。', [
    'knowledge.read', 'knowledge.write', 'textbooks.read', 'analytics.read', 'study.read', 'study.write'
  ]),
  scopeGroup('tasks', '任务与专注', '读取、编辑、执行学习任务并记录专注会话。', [
    'tasks.read', 'tasks.write', 'tasks.execute', 'focus.read', 'focus.control'
  ]),
  scopeGroup('imports', '导入、图片与批处理', '使用结构化导入、读取图片元数据并执行有边界的批处理。', [
    'imports.read', 'imports.write', 'files.images.read', 'operations.batch'
  ]),
  scopeGroup('ticktick', 'TickTick 本地功能', '访问本地 TickTick 风格的清单、习惯、日历与任务桥接。', [
    'ticktick.lists.read', 'ticktick.lists.write', 'ticktick.habits.read', 'ticktick.habits.write',
    'ticktick.calendar.read', 'ticktick.bridges.read', 'ticktick.bridges.write'
  ]),
  scopeGroup('artifacts', '备份与导出', '读取或创建受管理的备份与导出；删除备份仍受高风险策略保护。', [
    'backups.read', 'backups.create', 'backups.delete', 'exports.read', 'exports.create'
  ]),
  scopeGroup('maintenance', '高风险数据维护', '恢复、替换、清空、批次删除和数据根迁移均继续要求 R4 限时授权。', [
    'database.restore', 'database.replace', 'database.clear', 'imports.delete', 'data_root.migrate'
  ]),
  scopeGroup('audit', '审计', '读取该客户端获准查看的本地审计记录。', ['audit.read'])
]);

export const mcpClientAssignableScopes: readonly AgentScope[] = Object.freeze(
  mcpClientScopeGroups.flatMap((group) => group.scopes)
);
