/** Human-readable message for a caught value that may or may not be an `Error`. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `value` if it is a non-blank string, otherwise `undefined`. */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
