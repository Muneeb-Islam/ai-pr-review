import type { RunStatus } from "@ai-pr-review/shared";

/** The row does not exist, or belongs to an installation the caller cannot access (indistinguishable on purpose). */
export class NotFoundError extends Error {
  constructor(entity: string) {
    super(`${entity} not found`);
    this.name = "NotFoundError";
  }
}

/** A run state change that scope §5.1 does not allow (for example `completed` -> `running`). */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`Illegal run transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

export class InvalidCursorError extends InvalidInputError {
  constructor() {
    super("Invalid pagination cursor");
    this.name = "InvalidCursorError";
  }
}
