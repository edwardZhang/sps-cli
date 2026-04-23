/**
 * @module        shared/errors
 * @description   DomainError —— 所有 Service 层错误的统一结构
 *
 * @layer         shared
 *
 * Delivery 层（CLI / HTTP）负责翻译 DomainError 到各自输出格式：
 *   - HTTP：toHttpStatus + problem+json body
 *   - CLI：toExitCode + stderr 渲染
 *
 * Domain 层允许正常抛 Error；Service 层捕获后转 DomainError。
 */

export type DomainErrorKind =
  /** 资源不存在 —— HTTP 404 / CLI exit 1 */
  | 'not-found'
  /** etag 冲突 / 状态冲突 / 并发竞争 —— HTTP 409 / CLI exit 1 */
  | 'conflict'
  /** 入参非法（格式、schema 违反）—— HTTP 422 / CLI exit 2 */
  | 'validation'
  /** 前置条件不满足（业务规则阻挡）—— HTTP 409 / CLI exit 2 */
  | 'precondition'
  /** 外部系统错误（Git 失败 / npm registry 不通）—— HTTP 502 / CLI exit 3 */
  | 'external'
  /** 未知内部错误 —— HTTP 500 / CLI exit 1 */
  | 'internal';

export interface DomainError {
  readonly kind: DomainErrorKind;
  /** 机读码（全大写 + 下划线），便于 i18n / 客户端分支。 */
  readonly code: string;
  /** 人读消息（默认中文），展示给终端用户。 */
  readonly message: string;
  /** 结构化上下文 —— 不含大对象 / 不含敏感数据。 */
  readonly details?: Readonly<Record<string, unknown>>;
  /** 原始异常 —— 仅日志 / debug 用，不暴露给客户端。 */
  readonly cause?: unknown;
}

/** 构造 DomainError 的 factory（避免到处写 `{ kind, code, message }` 字面量）。 */
export function domainError(
  kind: DomainErrorKind,
  code: string,
  message: string,
  extra: { details?: Record<string, unknown>; cause?: unknown } = {},
): DomainError {
  return {
    kind,
    code,
    message,
    ...(extra.details ? { details: extra.details } : {}),
    ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
  };
}

/** HTTP status code 映射 —— Console route 层用。 */
export function toHttpStatus(e: DomainError): number {
  switch (e.kind) {
    case 'not-found':
      return 404;
    case 'conflict':
    case 'precondition':
      return 409;
    case 'validation':
      return 422;
    case 'external':
      return 502;
    case 'internal':
      return 500;
  }
}

/** CLI exit code 映射 —— CLI command 层用。 */
export function toExitCode(e: DomainError): number {
  switch (e.kind) {
    case 'validation':
    case 'precondition':
      return 2;
    case 'external':
      return 3;
    case 'not-found':
    case 'conflict':
    case 'internal':
      return 1;
  }
}

/**
 * 翻译为 application/problem+json（RFC 7807 兼容 shape）。
 * Delivery 层的 HTTP 响应体用。
 */
export interface ProblemJson {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  [k: string]: unknown;
}

export function toProblemJson(e: DomainError): ProblemJson {
  return {
    type: e.kind,
    title: titleFor(e.kind),
    status: toHttpStatus(e),
    detail: e.message,
    code: e.code,
    ...(e.details ? { details: e.details } : {}),
  };
}

function titleFor(kind: DomainErrorKind): string {
  switch (kind) {
    case 'not-found':
      return 'Not Found';
    case 'conflict':
      return 'Conflict';
    case 'precondition':
      return 'Precondition Failed';
    case 'validation':
      return 'Validation Error';
    case 'external':
      return 'External Service Error';
    case 'internal':
      return 'Internal Error';
  }
}
