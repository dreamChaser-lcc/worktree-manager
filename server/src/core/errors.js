/**
 * 统一错误类型：路由层据此映射 HTTP 状态码，
 * core 层只抛语义错误，不感知 HTTP。
 */
export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.details = options.details || null;
    this.httpStatus = options.httpStatus || 500;
  }
}

/** 参数/前置校验不通过 → 400 */
export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, httpStatus: 400 });
    this.name = 'ValidationError';
  }
}

/** 资源冲突（分支被占用、存在未提交修改等）→ 409 */
export class ConflictError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, httpStatus: 409 });
    this.name = 'ConflictError';
  }
}

/** 资源不存在 → 404 */
export class NotFoundError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, httpStatus: 404 });
    this.name = 'NotFoundError';
  }
}

/** git 命令执行失败 → 500，携带退出码与 stderr 摘要 */
export class GitCommandError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, httpStatus: 500 });
    this.name = 'GitCommandError';
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? '';
  }
}
