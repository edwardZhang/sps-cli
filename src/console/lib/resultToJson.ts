/**
 * @module        console/lib/resultToJson
 * @description   Result → Hono JSON 响应的单点翻译
 *
 * Delivery 层模板：service 返 Result<T, DomainError>，这里统一转 HTTP JSON。
 */
import type { Context } from 'hono';
import { toHttpStatus, toProblemJson } from '../../shared/errors.js';
import type { Result } from '../../shared/result.js';

type StatusCode = Parameters<Context['json']>[1];

/**
 * 把 Result 翻译成 Hono 响应。成功返 200 + value；失败按 DomainError.kind 返对应 status + problem+json。
 * 调用方：`return sendResult(c, await svc.method(...))`
 */
export function sendResult<T>(
  c: Context,
  result: Result<T>,
  opts: { successStatus?: number } = {},
): Response {
  if (result.ok) {
    return c.json(result.value as Record<string, unknown> | T, (opts.successStatus ?? 200) as StatusCode);
  }
  return c.json(toProblemJson(result.error), toHttpStatus(result.error) as StatusCode);
}

/** 同上，但成功返 204 no-content（value=undefined 的 Result 用） */
export function sendNoContent<T>(c: Context, result: Result<T>): Response {
  if (result.ok) {
    return c.body(null, 204);
  }
  return c.json(toProblemJson(result.error), toHttpStatus(result.error) as StatusCode);
}
