export interface HookProvider {
  onSessionStart(project: string, seq: string, worker: string): Promise<void>;
  onTaskSent(project: string, seq: string, worker: string): Promise<void>;
  onWaiting(project: string, seq: string, prompt: string, destructive: boolean): Promise<void>;
  onCompleted(project: string, seq: string, worker: string): Promise<void>;
  onStop(project: string, seq: string, reason: string): Promise<void>;
  onError(project: string, seq: string, error: string): Promise<void>;
}
