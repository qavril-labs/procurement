// Domain errors carry a stable code and an HTTP status. The API maps them to the error shape
// in contracts/openapi.yaml: { error: { code, message, details? } }.

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown[],
  ) {
    super(message);
  }
}

export function validation(message: string, details?: unknown[]): DomainError {
  return new DomainError("VALIDATION", message, 400, details);
}

export function notFound(what: string): DomainError {
  return new DomainError("NOT_FOUND", `${what} not found`, 404);
}

export function forbidden(message: string): DomainError {
  return new DomainError("FORBIDDEN", message, 403);
}
