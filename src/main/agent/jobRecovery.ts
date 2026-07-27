import { AgentError, type SerializedAgentError } from '../../shared/agent/errors';
import type { CommandResult } from '../../shared/agent/v1/contracts';
import type { ExecutionReceipt, JsonObject } from '../../shared/agent/v1/gatewayContracts';
import { JobStore, type JobRecoveryCandidate } from './jobStore';

export interface VerifiedJobReceiptEvidence {
  readonly receipt: ExecutionReceipt;
  readonly outcome?: CommandResult | SerializedAgentError;
}

export interface VerifiedJobJournalEvidence {
  readonly operationId: string;
  readonly requestId: string;
  readonly state: 'completed' | 'compensated' | 'needs_recovery';
}

export interface JobRecoveryDependencies {
  readonly store: JobStore;
  readonly selectedCandidateEvidence: true;
  readonly auditVerified: true;
  readonly receipt: (candidate: JobRecoveryCandidate) => Promise<VerifiedJobReceiptEvidence | undefined>;
  readonly journal: (candidate: JobRecoveryCandidate) => Promise<VerifiedJobJournalEvidence | undefined>;
}

export interface JobRecoveryResult {
  readonly completed: number;
  readonly failed: number;
  readonly interrupted: number;
}

export class JobRecovery {
  constructor(private readonly dependencies: JobRecoveryDependencies) {}

  async recover(): Promise<JobRecoveryResult> {
    if (this.dependencies.selectedCandidateEvidence !== true || this.dependencies.auditVerified !== true) throw new AgentError('RECOVERY_FENCE');
    await this.dependencies.store.reconcileOrphanResults();
    await this.dependencies.store.reconcileWaitingWorkflows();
    let completed = 0;
    let failed = 0;
    let interrupted = 0;
    for (const candidate of await this.dependencies.store.recoveryCandidates()) {
      const receipt = await this.dependencies.receipt(candidate);
      const journal = await this.dependencies.journal(candidate);
      if (journal && journal.requestId !== candidate.job.gatewayRequestId) throw new AgentError('RECOVERY_FENCE');
      if (candidate.job.operationJournalId && candidate.job.operationJournalId !== journal?.operationId) throw new AgentError('RECOVERY_FENCE');
      if (receipt && (receipt.receipt.clientId !== candidate.job.ownerClientId || receipt.receipt.requestId !== candidate.job.gatewayRequestId || receipt.receipt.operation !== candidate.job.operation)) {
        throw new AgentError('RECOVERY_FENCE');
      }
      if (candidate.target.kind === 'query' && candidate.resultRef && await this.dependencies.store.verifyBoundResult(candidate)) {
        await this.dependencies.store.recoverTerminal(candidate, 'completed', undefined, undefined, undefined, journal?.operationId);
        completed += 1;
        continue;
      }
      if (receipt?.receipt.status === 'completed' && receipt.outcome && (!journal || journal.state === 'completed')) {
        const outcome = Object.freeze({ kind: 'completed' as const, result: receipt.outcome as CommandResult }) as unknown as JsonObject;
        await this.dependencies.store.recoverTerminal(candidate, 'completed', outcome, undefined, receipt.receipt.receiptId, journal?.operationId);
        completed += 1;
        continue;
      }
      if (receipt && ['failed', 'interrupted_precommit'].includes(receipt.receipt.status) && receipt.outcome) {
        const error = receipt.outcome as SerializedAgentError;
        const outcome = Object.freeze({ kind: 'rejected' as const, error }) as unknown as JsonObject;
        await this.dependencies.store.recoverTerminal(candidate, 'failed', outcome, new AgentError(error.code), receipt.receipt.receiptId, journal?.operationId);
        failed += 1;
        continue;
      }
      await this.dependencies.store.recoverTerminal(candidate, 'interrupted', undefined, new AgentError('PERSISTENCE_INDETERMINATE'), receipt?.receipt.receiptId, journal?.operationId);
      interrupted += 1;
    }
    return Object.freeze({ completed, failed, interrupted });
  }
}
