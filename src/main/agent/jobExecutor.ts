import { AgentError } from '../../shared/agent/errors';
import type { AgentGateway, AgentPrincipal, AgentExecuteOutcome, AgentQueryOutcome } from '../../shared/agent/v1/gatewayContracts';
import { operationCatalogIdentity } from '../../shared/agent/v1/operationCatalog';
import { JobStore, type JobLease } from './jobStore';

export interface JobExecutionEvidence {
  readonly receiptId?: string;
  readonly operationJournalId?: string;
}

export interface JobExecutorDependencies {
  readonly store: JobStore;
  readonly gateway: AgentGateway;
  readonly resolvePrincipal: (lease: JobLease) => Promise<AgentPrincipal>;
  readonly resolveEvidence?: (lease: JobLease) => Promise<JobExecutionEvidence>;
  readonly onError?: (error: unknown, lease?: JobLease) => void;
}

/** Owns FIFO admission only; all durable writes remain on JobStore's coordinator control path. */
export class JobExecutor {
  private running = false;
  private stopped = false;

  constructor(private readonly dependencies: JobExecutorDependencies) {}

  start(): void {
    this.stopped = false;
    this.kick();
  }

  stop(): void { this.stopped = true; }

  kick(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    let shouldContinue = false;
    try {
      while (!this.stopped) {
        const lease = await this.dependencies.store.leaseNext();
        if (!lease) { shouldContinue = true; return; }
        await this.execute(lease);
      }
      shouldContinue = true;
    } catch (error) {
      this.dependencies.onError?.(error);
      shouldContinue = !(error instanceof AgentError && error.code === 'RECOVERY_FENCE');
    } finally {
      this.running = false;
      if (shouldContinue && !this.stopped && await this.dependencies.store.hasQueued().catch((error) => { this.dependencies.onError?.(error); return false; })) this.kick();
    }
  }

  private async execute(lease: JobLease): Promise<void> {
    try {
      const principal = await this.dependencies.resolvePrincipal(lease);
      if (!await this.dependencies.store.beginDispatch(lease.job.jobId, lease.leaseToken)) return;
      const target = lease.target;
      const outcome = target.kind === 'command'
        ? await this.dependencies.gateway.execute(Object.freeze({
            apiVersion: 1 as const, kind: 'agent-command' as const, operation: target.operation, payload: target.payload,
            requestId: lease.job.gatewayRequestId, expectedVersion: target.expectedVersion!, workflow: target.workflow,
            catalog: operationCatalogIdentity
          }), principal)
        : await this.dependencies.gateway.query(Object.freeze({
            apiVersion: 1 as const, kind: 'agent-query' as const, operation: target.operation, payload: target.payload,
            requestId: lease.job.gatewayRequestId, catalog: operationCatalogIdentity
          }), principal);
      const evidence = await this.dependencies.resolveEvidence?.(lease);
      await this.dependencies.store.bindEvidence(lease.job.jobId, lease.leaseToken, evidence?.receiptId, evidence?.operationJournalId);
      await this.finish(lease, outcome);
    } catch (error) {
      this.dependencies.onError?.(error, lease);
      try { await this.dependencies.store.terminalize(lease.job.jobId, lease.leaseToken, 'failed', undefined, error); }
      catch (terminalError) { this.dependencies.onError?.(terminalError, lease); }
    }
  }

  private async finish(lease: JobLease, outcome: AgentExecuteOutcome | AgentQueryOutcome): Promise<void> {
    if (outcome.kind === 'pending_approval' || outcome.kind === 'pending_changeset') {
      await this.dependencies.store.waitForApproval(lease.job.jobId, lease.leaseToken, outcome);
      return;
    }
    if (outcome.kind === 'rejected') {
      if (outcome.error.code === 'MAINTENANCE_FENCE') {
        await this.dependencies.store.requeueAtSafeCheckpoint(lease.job.jobId, lease.leaseToken);
        return;
      }
      await this.dependencies.store.terminalize(lease.job.jobId, lease.leaseToken, 'failed', outcome, new AgentError(outcome.error.code));
      return;
    }
    await this.dependencies.store.terminalize(lease.job.jobId, lease.leaseToken, 'completed', outcome);
  }
}
