import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from 'sql.js';
import { AgentError } from '../../../shared/agent/errors';
import type { AppCommand, DataVersion, TrustedExecutionContext } from '../../../shared/agent/v1/contracts';
import type { CommandHandler } from '../commandBus';
import type { DatabaseCoordinator, DatabaseMutationScope } from '../../persistence/databaseCoordinator';
import {
  createOperationManifest,
  evidenceForBytes,
  OperationJournal,
  OperationManifestStore,
  type OperationJournalDependencies,
  type OperationFile,
  type OperationManifest,
  type OperationManifestError
} from '../../persistence/operationJournal';
import { getPaths } from '../../services/pathService';
import { createManagedImagePath, resolveManagedImagePath } from '../../services/fileService';
import type { ImageType, QuestionImage, QuestionInput } from '../../../shared/types';
import { QuestionRepository, type QuestionImageInsert } from './questionRepository';

type CommandOf<T extends AppCommand['type']> = Extract<AppCommand, { type: T }>;
type Handler<T extends AppCommand['type']> = CommandHandler<CommandOf<T>>;

export interface QuestionCommandDependencies {
  readonly now?: () => string;
  readonly journalHook?: OperationJournalDependencies['hook'];
}

function now(dependencies: QuestionCommandDependencies): string {
  return new Date((dependencies.now ?? (() => new Date().toISOString()))()).toISOString();
}

function currentVersion(database: Database): DataVersion {
  const result = database.exec('SELECT data_epoch, data_revision FROM control_metadata WHERE id = 1');
  const row = result[0]?.values[0];
  if (!row || typeof row[0] !== 'string' || typeof row[1] !== 'number') throw new Error('Question command requires control metadata');
  return { dataEpoch: row[0], dataRevision: row[1] };
}

function plannedVersion(version: DataVersion): DataVersion {
  if (version.dataRevision === Number.MAX_SAFE_INTEGER) throw new Error('Question command revision overflow');
  return { dataEpoch: version.dataEpoch, dataRevision: version.dataRevision + 1 };
}

function safeId(value: string): string {
  const result = value.replace(/[^A-Za-z0-9_-]/g, '');
  if (!result) throw new Error('Question operation identifier is invalid');
  return result;
}

function inputHash(command: AppCommand): string {
  return crypto.createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function manifestStore(): OperationManifestStore {
  return new OperationManifestStore(path.normalize(path.join(getPaths().data, 'operation-journal')));
}

function journal(dependencies: QuestionCommandDependencies): OperationJournal {
  return new OperationJournal(manifestStore(), { now: dependencies.now, hook: dependencies.journalHook });
}

function operationError(error: unknown, phase: string): OperationManifestError {
  return {
    code: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code.slice(0, 200) : 'question_file_operation_failed',
    phase,
    message: error instanceof Error ? error.message.slice(0, 1_000) || 'Question file operation failed' : 'Question file operation failed'
  };
}

function sourceEvidence(sourcePath: string) {
  return evidenceForBytes(fs.readFileSync(sourcePath));
}

function createFileEntries(
  questionId: number,
  command: AppCommand,
  input: QuestionInput,
  context: TrustedExecutionContext
): { files: OperationFile[]; images: QuestionImageInsert[]; sourceRoots: string[] } {
  const files: OperationFile[] = [];
  const images: QuestionImageInsert[] = [];
  const sourceRoots = new Set<string>();
  const append = (sourcePath: string, imageType: ImageType, index: number) => {
    const absoluteSource = path.normalize(path.resolve(sourcePath));
    const fileId = `${imageType}-${index + 1}`;
    const destination = createManagedImagePath(questionId, imageType, absoluteSource, `${safeId(context.requestId)}-${fileId}`);
    const operationRoot = path.normalize(path.join(getPaths().images, '.question-operations'));
    const stagingPath = path.normalize(path.join(operationRoot, 'staging', `${safeId(context.requestId)}-${fileId}.stage`));
    sourceRoots.add(path.dirname(absoluteSource));
    files.push({
      fileId,
      kind: 'create',
      sourcePath: absoluteSource,
      targetPath: destination.absolutePath,
      stagingPath,
      content: sourceEvidence(absoluteSource),
      status: 'pending'
    });
    images.push({ imageType, filePath: destination.storedPath });
  };
  input.questionImageSources.forEach((source, index) => append(source, 'original', index));
  input.solutionImageSources.forEach((source, index) => append(source, 'solution', index));
  return { files, images, sourceRoots: [...sourceRoots] };
}

function deletionFileEntries(images: readonly QuestionImage[], context: TrustedExecutionContext): OperationFile[] {
  const operationRoot = path.normalize(path.join(getPaths().images, '.question-operations'));
  const files: OperationFile[] = [];
  for (const image of images) {
    const targetPath = resolveManagedImagePath(image.file_path);
    let content;
    try {
      content = sourceEvidence(targetPath);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    files.push({
      fileId: `image-${image.id}`,
      kind: 'quarantine_delete',
      targetPath,
      quarantinePath: path.normalize(path.join(operationRoot, 'quarantine', `${safeId(context.requestId)}-image-${image.id}.quarantine`)),
      content,
      status: 'pending'
    });
  }
  return files;
}

async function prepareOperation(
  database: Database,
  command: AppCommand,
  context: TrustedExecutionContext,
  files: readonly OperationFile[],
  sourceRoots: readonly string[],
  affectedEntities: readonly { entityType: string; entityId: string }[],
  dependencies: QuestionCommandDependencies
): Promise<OperationManifest | null> {
  if (!files.length) return null;
  const paths = getPaths();
  fs.mkdirSync(path.join(paths.images, '.question-operations'), { recursive: true });
  fs.mkdirSync(path.join(paths.data, 'operation-journal'), { recursive: true });
  const versionBefore = currentVersion(database);
  const manifest = createOperationManifest({
    operationId: safeId(context.requestId),
    requestId: safeId(context.requestId),
    commandType: command.type,
    source: context.source,
    clientId: context.client.clientId,
    traceId: context.traceId,
    inputHash: inputHash(command),
    storage: 'data_root',
    versionBefore,
    versionAfter: plannedVersion(versionBefore),
    affectedEntities,
    roots: {
      manifestRoot: path.normalize(path.join(paths.data, 'operation-journal')),
      managedRoots: [path.normalize(paths.root)],
      sourceRoots: sourceRoots.length ? sourceRoots : [path.normalize(paths.root)]
    },
    files,
    createdAt: now(dependencies)
  });
  const operationJournal = journal(dependencies);
  return operationJournal.stage(await operationJournal.prepare(manifest));
}

async function preparedImageCreates(
  database: Database,
  questionId: number,
  command: AppCommand,
  input: QuestionInput,
  context: TrustedExecutionContext,
  dependencies: QuestionCommandDependencies
): Promise<readonly QuestionImageInsert[]> {
  const entries = createFileEntries(questionId, command, input, context);
  await prepareOperation(database, command, context, entries.files, entries.sourceRoots,
    [{ entityType: 'question', entityId: String(questionId) }], dependencies);
  return entries.images;
}

export function createQuestionCommandHandlers(dependencies: QuestionCommandDependencies = {}) {
  const repository = (database: Database, scope: DatabaseMutationScope) => new QuestionRepository(database, scope, dependencies.now);

  const create: Handler<'questions.create'> = async (command, context, database, scope) => {
    const repo = repository(database, scope);
    const question = repo.create({ ...command.payload.input, questionImageSources: [], solutionImageSources: [] });
    const images = await preparedImageCreates(database, question.id, command, command.payload.input, context, dependencies);
    const saved = images.length ? repo.update(question.id, command.payload.input, images).question : question;
    return { changed: true, value: saved };
  };

  const update: Handler<'questions.update'> = async (command, context, database, scope) => {
    const repo = repository(database, scope);
    const hasImages = command.payload.input.questionImageSources.length + command.payload.input.solutionImageSources.length > 0;
    const images = hasImages
      ? await preparedImageCreates(database, command.payload.questionId, command, command.payload.input, context, dependencies)
      : [];
    const result = repo.update(command.payload.questionId, command.payload.input, images);
    return {
      changed: result.changed,
      value: result.question,
      events: []
    };
  };

  const removeQuestion: Handler<'questions.delete'> = async (command, context, database, scope) => {
    const repo = repository(database, scope);
    const files = command.payload.deleteImages ? deletionFileEntries(repo.getQuestionImages(command.payload.questionId), context) : [];
    await prepareOperation(database, command, context, files, [path.normalize(getPaths().root)],
      [{ entityType: 'question', entityId: String(command.payload.questionId) }], dependencies);
    const changed = repo.delete(command.payload.questionId);
    return { changed, value: true };
  };

  const removeImage: Handler<'questions.remove_image'> = async (command, context, database, scope) => {
    const repo = repository(database, scope);
    const image = repo.getImage(command.payload.imageId);
    const files = image && command.payload.deleteFile ? deletionFileEntries([image], context) : [];
    await prepareOperation(database, command, context, files, [path.normalize(getPaths().root)],
      [{ entityType: 'question_image', entityId: String(command.payload.imageId) }], dependencies);
    const changed = repo.removeImage(command.payload.imageId);
    return { changed, value: true };
  };

  const markMastery: Handler<'questions.mark_mastery'> = (command, _context, database, scope) => {
    const result = repository(database, scope).markMastery(command.payload.questionId, command.payload.mastery);
    return { changed: result.changed, value: result.question };
  };

  const submitReview: Handler<'questions.submit_review'> = (command, _context, database, scope) => {
    const value = repository(database, scope).submitReview(command.payload);
    return { changed: true, value };
  };

  const linkKnowledge: Handler<'questions.link_knowledge'> = (command, _context, database, scope) => {
    const result = repository(database, scope).linkKnowledgePoints(command.payload.questionId, command.payload.knowledgeNodeIds, command.payload.matchType);
    return { changed: result.inserted > 0, value: result.inserted };
  };

  const migrateCategories: Handler<'questions.migrate_categories'> = (command, _context, database, scope) => {
    const migrated = repository(database, scope).migrateCategories(command.payload.limit);
    return { changed: migrated > 0, value: { migrated } };
  };

  const rematchKnowledge: Handler<'questions.rematch_knowledge'> = (command, _context, database, scope) => {
    const value = repository(database, scope).rematchKnowledge(command.payload.limit, command.payload.questionIds);
    return { changed: value.insertedCount > 0, value };
  };

  const bulkUpsert: Handler<'questions.bulk_upsert'> = async (command, context, database, scope) => {
    const repo = repository(database, scope);
    const questionIds: number[] = [];
    for (const item of command.payload.items) {
      const question = repo.create({ ...item.input, questionImageSources: [], solutionImageSources: [] });
      if (item.input.questionImageSources.length || item.input.solutionImageSources.length) {
        throw new Error('Image-bearing bulk insertion must use bounded single-question commands');
      }
      questionIds.push(question.id);
    }
    return { changed: questionIds.length > 0, value: { processed: questionIds.length, questionIds } };
  };

  const importQuestions: Handler<'questions.import'> = async (command, context, database, scope) => {
    const repo = repository(database, scope);
    const questionIds: number[] = [];
    for (const item of command.payload.items) {
      if (item.input.questionImageSources.length || item.input.solutionImageSources.length) {
        throw new Error('Image-bearing import insertion must use bounded single-question commands');
      }
      const question = repo.create({ ...item.input, import_batch_id: command.payload.batchId });
      repo.linkKnowledgePoints(question.id, item.knowledgeNodeIds, 'gpt');
      questionIds.push(question.id);
    }
    return { changed: questionIds.length > 0, value: { processed: questionIds.length, questionIds } };
  };

  const replaceAll: Handler<'questions.replace_all'> = (command, _context, database, scope) => {
    const repo = repository(database, scope);
    if (command.payload.questions.some((input) => input.questionImageSources.length || input.solutionImageSources.length)) {
      throw new Error('Image-bearing replacement requires the A11 consistency-package path');
    }
    const previous = repo.clearQuestionState();
    const ids = command.payload.questions.map((input) => repo.create(input).id);
    return { changed: previous > 0 || ids.length > 0, value: { replaced: ids.length } };
  };

  const clearAll: Handler<'questions.clear_all'> = async (command, context, database, scope) => {
    const repo = repository(database, scope);
    const count = repo.countQuestions();
    if (count > command.payload.maxQuestions) throw new Error('Question clear exceeds the confirmed bound');
    const images = command.payload.deleteImages ? database.exec('SELECT id, question_id, image_type, file_path, created_at FROM question_images') : [];
    const rows: QuestionImage[] = images.length ? images[0].values.map((values) => ({
      id: Number(values[0]), question_id: Number(values[1]), image_type: String(values[2]) as ImageType,
      file_path: String(values[3]), created_at: String(values[4])
    })) : [];
    const files = deletionFileEntries(rows, context);
    await prepareOperation(database, command, context, files, [path.normalize(getPaths().root)], [{ entityType: 'question_state', entityId: 'all' }], dependencies);
    const deleted = repo.clearQuestionState();
    return { changed: deleted > 0, value: { deleted } };
  };

  return { create, update, delete: removeQuestion, removeImage, markMastery, submitReview, linkKnowledge, migrateCategories, rematchKnowledge, bulkUpsert, importQuestions, replaceAll, clearAll };
}

export async function finalizeQuestionFileOperation(
  coordinator: DatabaseCoordinator,
  requestId: string,
  succeeded: boolean,
  dependencies: QuestionCommandDependencies = {}
): Promise<void> {
  const store = manifestStore();
  const manifest = await store.read(safeId(requestId));
  if (!manifest) return;
  const operationJournal = journal(dependencies);
  try {
    if (succeeded) {
      await operationJournal.commitFiles(await operationJournal.markDatabaseCommitted(manifest));
    } else if (coordinator.state === 'writable') {
      await operationJournal.compensate(manifest, operationError(new Error('Database command did not commit'), 'database_command'));
    } else {
      await operationJournal.needsRecovery(manifest, operationError(new Error('Database outcome is not safe for compensation'), 'database_command'));
    }
  } catch (error) {
    const latest = await store.read(manifest.operationId) ?? manifest;
    await operationJournal.needsRecovery(latest, operationError(error, 'file_finalization')).catch(() => undefined);
    if (coordinator.state === 'writable') {
      const lease = await coordinator.beginMaintenance();
      coordinator.finishMaintenance(lease, 'needs_recovery');
    }
    throw new AgentError('RECOVERY_FENCE');
  }
}
