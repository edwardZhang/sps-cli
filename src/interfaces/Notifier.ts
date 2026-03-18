export interface Notifier {
  send(message: string, level?: 'info' | 'success' | 'warning' | 'error'): Promise<void>;
  sendSuccess(message: string): Promise<void>;
  sendWarning(message: string): Promise<void>;
  sendError(message: string): Promise<void>;
  sendDigest(items: { title: string; status: string }[]): Promise<void>;
}
