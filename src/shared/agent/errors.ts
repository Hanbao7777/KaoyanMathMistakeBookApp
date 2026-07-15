import type { DataVersion, EntityRef } from './v1/contracts';

export const agentErrorCodes = [
  'VALIDATION_ERROR',
  'UNSUPPORTED_API_VERSION',
  'DATA_EPOCH_MISMATCH',
  'DATA_REVISION_CONFLICT',
  'REQUEST_CONFLICT',
  'HANDLER_NOT_FOUND',
  'HANDLER_ALREADY_REGISTERED',
  'PERSISTENCE_INDETERMINATE',
  'MAINTENANCE_FENCE',
  'RECOVERY_FENCE',
  'INTERNAL_ERROR'
] as const;

export type AgentErrorCode = (typeof agentErrorCodes)[number];

export interface AgentErrorDetails {
  field?: string;
  currentVersion?: DataVersion;
  conflicts?: EntityRef[];
  safeToReplan?: boolean;
}

export interface SerializedAgentError {
  code: AgentErrorCode;
  message: string;
  retryable: boolean;
  details?: AgentErrorDetails;
}

const errorMessages: Record<AgentErrorCode, string> = {
  VALIDATION_ERROR: 'The request is invalid.',
  UNSUPPORTED_API_VERSION: 'The Agent API version is not supported.',
  DATA_EPOCH_MISMATCH: 'The data epoch no longer matches.',
  DATA_REVISION_CONFLICT: 'The data revision has changed.',
  REQUEST_CONFLICT: 'The request conflicts with an earlier request.',
  HANDLER_NOT_FOUND: 'No handler is registered for this operation.',
  HANDLER_ALREADY_REGISTERED: 'A handler is already registered for this operation.',
  PERSISTENCE_INDETERMINATE: 'The persistence outcome is indeterminate.',
  MAINTENANCE_FENCE: 'Writes are temporarily fenced for maintenance.',
  RECOVERY_FENCE: 'Writes are fenced pending recovery.',
  INTERNAL_ERROR: 'An internal error occurred.'
};

const retryableCodes = new Set<AgentErrorCode>([
  'DATA_REVISION_CONFLICT',
  'MAINTENANCE_FENCE'
]);

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly details?: AgentErrorDetails;

  constructor(code: AgentErrorCode, details?: AgentErrorDetails) {
    super(errorMessages[code]);
    this.name = 'AgentError';
    this.code = code;
    this.details = details;
  }
}

function safeDetails(details: AgentErrorDetails | undefined): AgentErrorDetails | undefined {
  if (!details) return undefined;
  const result: AgentErrorDetails = {};
  if (typeof details.field === 'string' && /^[A-Za-z0-9_.\[\]-]{1,120}$/.test(details.field)) result.field = details.field;
  if (
    details.currentVersion &&
    typeof details.currentVersion.dataEpoch === 'string' &&
    details.currentVersion.dataEpoch.length > 0 &&
    details.currentVersion.dataEpoch.length <= 200 &&
    Number.isSafeInteger(details.currentVersion.dataRevision) &&
    details.currentVersion.dataRevision >= 0
  ) {
    result.currentVersion = {
      dataEpoch: details.currentVersion.dataEpoch,
      dataRevision: details.currentVersion.dataRevision
    };
  }
  if (Array.isArray(details.conflicts)) {
    const safeReference = /^[A-Za-z0-9._:-]{1,200}$/;
    const conflicts = details.conflicts.filter(
      (reference) => reference !== null && typeof reference === 'object' &&
        safeReference.test((reference as EntityRef).entityType) && safeReference.test((reference as EntityRef).entityId)
    );
    if (conflicts.length) result.conflicts = conflicts.map(({ entityType, entityId }) => ({ entityType, entityId }));
  }
  if (typeof details.safeToReplan === 'boolean') result.safeToReplan = details.safeToReplan;
  return Object.keys(result).length ? result : undefined;
}

export function serializeAgentError(error: unknown): SerializedAgentError {
  const code = error instanceof AgentError ? error.code : 'INTERNAL_ERROR';
  const details = error instanceof AgentError ? safeDetails(error.details) : undefined;
  return {
    code,
    message: errorMessages[code],
    retryable: retryableCodes.has(code),
    ...(details ? { details } : {})
  };
}
