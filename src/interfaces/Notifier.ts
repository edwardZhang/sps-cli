/**
 * @module        Notifier
 * @description   通知器接口，定义消息发送、摘要推送等通知能力的契约
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-03-19
 *
 * @role          interface
 * @layer         interface
 * @boundedContext notification
 */

export interface Notifier {
  send(message: string, level?: 'info' | 'success' | 'warning' | 'error'): Promise<void>;
  sendSuccess(message: string): Promise<void>;
  sendWarning(message: string): Promise<void>;
  sendError(message: string): Promise<void>;
  sendDigest(items: { title: string; status: string }[]): Promise<void>;
}
