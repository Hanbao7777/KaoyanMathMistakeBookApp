import type { StudyQuality } from '../../shared/types';

export type FocusTimerStatus = 'idle' | 'running' | 'paused';

export interface FocusTimerState {
  status: FocusTimerStatus;
  subjectId: string;
  subjectName: string;
  taskId: string;
  taskTitle: string;
  materialId: string;
  materialName: string;
  startedAt: string | null;
  lastStartedAt: string | null;
  accumulatedSeconds: number;
  quality: StudyQuality;
  note: string;
  restored: boolean;
}

export interface FocusTimerPatch {
  subjectId?: string;
  subjectName?: string;
  taskId?: string;
  taskTitle?: string;
  materialId?: string;
  materialName?: string;
  quality?: StudyQuality;
  note?: string;
}

export interface FocusTimerControls {
  start: () => void;
  pause: () => void;
  reset: () => void;
  update: (patch: FocusTimerPatch) => void;
  clearRestored: () => void;
  elapsedSeconds: number;
}

export const defaultFocusTimerState: FocusTimerState = {
  status: 'idle',
  subjectId: 'math',
  subjectName: '数学',
  taskId: '',
  taskTitle: '',
  materialId: '',
  materialName: '',
  startedAt: null,
  lastStartedAt: null,
  accumulatedSeconds: 0,
  quality: '良好',
  note: '',
  restored: false
};
