/**
 * @module        shared/result
 * @description   Result<T, E> —— Service 层约定返回的容器类型
 *
 * @layer         shared
 *
 * Service 方法不抛业务异常 —— 用 Result 表达"成功 + 值"或"失败 + 结构化错误"。
 * `throw` 保留给真正的系统问题（OOM / 断言违反 / 库 panic）。
 */
import type { DomainError } from './errors.js';

export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** 包装成功结果。 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** 包装失败结果。 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** 类型守卫：Result 是 Ok？ */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

/** 类型守卫：Result 是 Err？ */
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

/**
 * 成功时 map 值；失败时原样传递。
 * 不改变 error 类型。
 */
export function mapOk<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

/**
 * 失败时 map 错误；成功时原样传递。
 */
export function mapErr<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

/**
 * 对 Ok 执行会返回 Result 的下一步（链式）。
 * 任一步失败短路。
 */
export async function andThen<T, U, E>(
  r: Result<T, E>,
  f: (t: T) => Promise<Result<U, E>>,
): Promise<Result<U, E>> {
  return r.ok ? await f(r.value) : r;
}

/**
 * 取 Ok 值，不是 Ok 就抛 —— 仅用于测试 / 边界场景。
 * 生产代码应该用 isOk + 分支处理。
 */
export function unwrap<T, E>(r: Result<T, E>, ctx?: string): T {
  if (!r.ok) {
    const prefix = ctx ? `${ctx}: ` : '';
    throw new Error(`${prefix}unwrap on Err: ${JSON.stringify(r.error)}`);
  }
  return r.value;
}
