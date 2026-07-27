import { AsyncLocalStorage } from 'node:async_hooks';
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
  readonly onTerminalized?: (lease: JobLease, status: 'completed' | 'failed' | 'interrupted') => Promise<void>;
  readonly onError?: (error: unknown, lease?: JobLease) => void;
  readonly isMaintenanceActive?: () => boolean;
  readonly pendingWrites?: () => number;
  readonly writeActivityVersion?: () => number;
  readonly waitForTransientFence?: () => Promise<void>;
}

/** Owns FIFO admission only; all durable writes remain on JobStore's coordinator control path. */
export class JobExecutor {
  private running = false;
  private stopped = false;
  private kickRequested = false;
  private readonly idleWaiters = new Set<() => void>();
  private readonly executionContext = new AsyncLocalStorage<JobLease>();
  private readonly runInExecutionContext = this.executionContext.run.bind(this.executionContext);

  constructor(private readonly dependencies: JobExecutorDependencies) {}

  start(): void {
    if (this.running && this.stopped) throw new Error('Cannot start JobExecutor until its active drain is idle');
    this.stopped = false;
    this.kick();
  }

  stop(): void { this.stopped = true; }

  async resume(): Promise<void> {
    if (this.running) {
      if (this.stopped) throw new Error('Cannot resume JobExecutor until its active drain is idle');
      return;
    }
    this.stopped = false;
    this.running = true;
    this.kickRequested = false;
    let restart = false;
    try {
      const queued = await this.dependencies.store.hasQueued().catch((error) => {
        this.dependencies.onError?.(error);
        return false;
      });
      restart = queued || this.kickRequested;
    } finally {
      this.running = false;
      this.kickRequested = false;
      if (restart && !this.stopped) this.kick();
      if (!this.running) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    }
  }

  stopAndDrain(): Promise<void> {
    if (this.executionContext.getStore()) {
      return Promise.reject(new Error('JobExecutor cannot drain from within its active job execution'));
    }
    this.stop();
    return this.whenIdle();
  }

  isIdle(): boolean { return !this.running; }

  isStopped(): boolean { return this.stopped; }

  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.kickRequested = true;
      return;
    }
    this.running = true;
    this.kickRequested = false;
    queueMicrotask(() => void this.drain());
  }

  private async drain(): Promise<void> {
    let shouldContinue = false;
    try {
      while (!this.stopped) {
        const lease = await this.dependencies.store.leaseNext();
        if (!lease) { shouldContinue = true; return; }
        const outcome = await this.runInExecutionContext(lease, () => this.execute(lease));
        if (outcome === 'suspended') return;
        if (outcome === 'transient_fence') {
          if (this.dependencies.isMaintenanceActive?.() ?? true) return;
          if (!this.dependencies.waitForTransientFence) return;
          try {
            await this.dependencies.waitForTransientFence();
          } catch (error) {
            this.dependencies.onError?.(error, lease);
            return;
          }
          if (this.dependencies.isMaintenanceActive?.()) return;
        }
      }
      shouldContinue = true;
    } catch (error) {
      this.dependencies.onError?.(error);
      shouldContinue = !(error instanceof AgentError && error.code === 'RECOVERY_FENCE');
    } finally {
      let restart = false;
      try {
        if (shouldContinue && !this.stopped) {
          const queued = await this.dependencies.store.hasQueued().catch((error) => {
            this.dependencies.onError?.(error);
            return false;
          });
          restart = this.kickRequested || queued;
        }
      } finally {
        this.running = false;
        this.kickRequested = false;
        if (restart && !this.stopped) this.kick();
        if (!this.running) {
          for (const resolve of this.idleWaiters) resolve();
          this.idleWaiters.clear();
        }
      }
    }
  }

  private async execute(lease: JobLease): Promise<'continue' | 'suspended' | 'transient_fence'> {
    let finishStatus: 'completed' | 'failed' | 'suspended' | 'transient_fence' | undefined;
    try {
      const principal = await this.dependencies.resolvePrincipal(lease);
      if (!await this.dependencies.store.beginDispatch(lease.job.jobId, lease.leaseToken)) return 'continue';
      const target = lease.target;
      const pendingWritesAtDispatchStart = this.dependencies.pendingWrites?.() ?? 0;
      const writeActivityVersion = this.dependencies.writeActivityVersion?.();
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
      const transientMaintenanceFence = outcome.kind === 'rejected' && outcome.error.code === 'MAINTENANCE_FENCE' &&
        (pendingWritesAtDispatchStart > 0 ||
          (writeActivityVersion !== undefined && this.dependencies.writeActivityVersion?.() !== writeActivityVersion));
      const evidence = await this.dependencies.resolveEvidence?.(lease);
      await this.dependencies.store.bindEvidence(lease.job.jobId, lease.leaseToken, evidence?.receiptId, evidence?.operationJournalId);
      finishStatus = await this.finish(lease, outcome, transientMaintenanceFence);
    } catch (error) {
      this.dependencies.onError?.(error, lease);
      try { await this.dependencies.store.terminalize(lease.job.jobId, lease.leaseToken, 'failed', undefined, error); await this.dependencies.onTerminalized?.(lease, 'failed'); }
      catch (terminalError) { this.dependencies.onError?.(terminalError, lease); }
      return 'continue';
    }
    if (finishStatus === 'suspended' || finishStatus === 'transient_fence') return finishStatus;
    if (finishStatus) {
      try { await this.dependencies.onTerminalized?.(lease, finishStatus); }
      catch (error) { this.dependencies.onError?.(error, lease); }
    }
    return 'continue';
  }

  private async finish(
    lease: JobLease,
    outcome: AgentExecuteOutcome | AgentQueryOutcome,
    transientMaintenanceFence: boolean
  ): Promise<'completed' | 'failed' | 'suspended' | 'transient_fence' | undefined> {
    if (outcome.kind === 'pending_approval' || outcome.kind === 'pending_changeset') {
      await this.dependencies.store.waitForApproval(lease.job.jobId, lease.leaseToken, outcome);
      return;
    }
    if (outcome.kind === 'rejected') {
      if (outcome.error.code === 'MAINTENANCE_FENCE') {
        await this.dependencies.store.requeueAtSafeCheckpoint(lease.job.jobId, lease.leaseToken);
        return transientMaintenanceFence ? 'transient_fence' : 'suspended';
      }
      await this.dependencies.store.terminalize(lease.job.jobId, lease.leaseToken, 'failed', outcome, new AgentError(outcome.error.code));
      return 'failed';
    }
    await this.dependencies.store.terminalize(lease.job.jobId, lease.leaseToken, 'completed', outcome);
    return 'completed';
  }
}
