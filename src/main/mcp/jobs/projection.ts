import type { AgentJob, JobStatus } from '../../../shared/agent/v1/jobs';

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export function projectJobStatus(status: JobStatus): McpTaskStatus {
  if (status === 'queued' || status === 'running') return 'working';
  if (status === 'waiting_approval') return 'input_required';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

export function projectJobTask(job: AgentJob): Readonly<Record<string, unknown>> {
  return Object.freeze({
    taskId: job.jobId,
    status: projectJobStatus(job.status),
    ...(job.error ? { statusMessage: job.error.message } : {}),
    createdAt: job.createdAt,
    lastUpdatedAt: job.updatedAt,
    ttl: Math.max(0, Date.parse(job.retainUntil) - Date.parse(job.createdAt)),
    pollInterval: 1_000
  });
}
