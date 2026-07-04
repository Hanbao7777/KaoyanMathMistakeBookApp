export type FocusTimerStatus = 'idle' | 'running' | 'paused' | 'break';

export interface FocusTimerState {
  status: FocusTimerStatus;
  secondsLeft: number;
  totalSeconds: number;
  completedSessions: number;
  currentSession: number;
  sessionStartTime: number | null;
  boundTaskId: string | null;
}

export interface FocusTimerConfig {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  sessionsBeforeLongBreak: number;
}

export interface SessionEndInfo {
  sessionType: 'focus';
  durationMinutes: number;
  sessionStartTime: number;
  boundTaskId: string | null;
}

export type SessionEndCallback = (info: SessionEndInfo) => void;

const DEFAULT_CONFIG: FocusTimerConfig = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
};

export class FocusTimerEngine {
  private state: FocusTimerState;
  private config: FocusTimerConfig;
  private onSessionEnd?: SessionEndCallback;

  constructor(config?: Partial<FocusTimerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      status: 'idle',
      secondsLeft: this.config.focusMinutes * 60,
      totalSeconds: this.config.focusMinutes * 60,
      completedSessions: 0,
      currentSession: 1,
      sessionStartTime: null,
      boundTaskId: null,
    };
  }

  setConfig(config: Partial<FocusTimerConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.state.status === 'idle') {
      const focusSecs = this.config.focusMinutes * 60;
      this.state.secondsLeft = focusSecs;
      this.state.totalSeconds = focusSecs;
    }
  }

  setSessionEndCallback(cb: SessionEndCallback): void {
    this.onSessionEnd = cb;
  }

  setBoundTaskId(taskId: string | null): void {
    this.state.boundTaskId = taskId;
  }

  getState(): FocusTimerState {
    return { ...this.state };
  }

  start(now: number = Date.now()): void {
    if (this.state.status === 'running') return;

    if (this.state.status === 'idle' || this.state.status === 'break') {
      const focusSecs = this.config.focusMinutes * 60;
      this.state.totalSeconds = focusSecs;
      this.state.secondsLeft = focusSecs;
      this.state.status = 'running';
      this.state.sessionStartTime = now;
    } else {
      // Resuming from paused
      this.state.status = 'running';
      this.state.sessionStartTime = now - (this.state.totalSeconds - this.state.secondsLeft) * 1000;
    }
  }

  pause(now: number = Date.now()): void {
    if (this.state.status !== 'running') return;
    this.tick(now);
    this.state.status = 'paused';
    this.state.sessionStartTime = null;
  }

  reset(): void {
    const focusSecs = this.config.focusMinutes * 60;
    this.state = {
      status: 'idle',
      secondsLeft: focusSecs,
      totalSeconds: focusSecs,
      completedSessions: 0,
      currentSession: 1,
      sessionStartTime: null,
      boundTaskId: null,
    };
  }

  skipBreak(now: number = Date.now()): void {
    if (this.state.status !== 'break') return;
    const focusSecs = this.config.focusMinutes * 60;
    this.state.currentSession += 1;
    this.state.status = 'idle';
    this.state.secondsLeft = focusSecs;
    this.state.totalSeconds = focusSecs;
    this.state.sessionStartTime = null;
  }

  tick(now: number = Date.now()): FocusTimerState {
    if (this.state.status === 'running' && this.state.sessionStartTime !== null) {
      const elapsed = Math.floor((now - this.state.sessionStartTime) / 1000);
      const remaining = Math.max(0, this.state.totalSeconds - elapsed);
      this.state.secondsLeft = remaining;

      if (remaining <= 0) {
        this.handleFocusEnd(now);
      }
    } else if (this.state.status === 'break' && this.state.sessionStartTime !== null) {
      const elapsed = Math.floor((now - this.state.sessionStartTime) / 1000);
      const remaining = Math.max(0, this.state.totalSeconds - elapsed);
      this.state.secondsLeft = remaining;

      if (remaining <= 0) {
        this.handleBreakEnd();
      }
    }

    return this.getState();
  }

  private handleFocusEnd(now: number): void {
    const sessionStartTime = this.state.sessionStartTime!;
    const durationMinutes = Math.max(1, Math.round((now - sessionStartTime) / 60000));

    if (this.onSessionEnd) {
      this.onSessionEnd({
        sessionType: 'focus',
        durationMinutes,
        sessionStartTime,
        boundTaskId: this.state.boundTaskId,
      });
    }

    this.state.completedSessions += 1;

    const isLongBreak = this.state.completedSessions % this.config.sessionsBeforeLongBreak === 0;
    const breakSecs = (isLongBreak ? this.config.longBreakMinutes : this.config.shortBreakMinutes) * 60;
    this.state.status = 'break';
    this.state.totalSeconds = breakSecs;
    this.state.secondsLeft = breakSecs;
    this.state.sessionStartTime = now;
  }

  private handleBreakEnd(): void {
    const focusSecs = this.config.focusMinutes * 60;
    this.state.currentSession += 1;
    this.state.status = 'idle';
    this.state.secondsLeft = focusSecs;
    this.state.totalSeconds = focusSecs;
    this.state.sessionStartTime = null;
  }
}
