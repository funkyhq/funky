// packages/configs/src/errors.ts
// Domain errors — HTTP-agnostic. apps/api/src/http.ts maps them to the envelope.

export class NotFoundError extends Error {
  readonly kind = "not_found" as const;
  constructor(message = "resource not found") {
    super(message);
  }
}

export class ConflictError extends Error {
  readonly kind = "conflict" as const;
  constructor(message: string) {
    super(message);
  }
}
