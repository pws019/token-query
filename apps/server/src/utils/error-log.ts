type LoggableError = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  detail?: unknown;
  schema?: unknown;
  table?: unknown;
  column?: unknown;
  constraint?: unknown;
  routine?: unknown;
  cause?: unknown;
};

export function serializeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error) || depth > 2) {
    return {
      type: typeof error,
    };
  }

  const loggable = error as LoggableError;

  return {
    name: error.name,
    message: error.message,
    code: loggable.code,
    detail: loggable.detail,
    schema: loggable.schema,
    table: loggable.table,
    column: loggable.column,
    constraint: loggable.constraint,
    routine: loggable.routine,
    cause:
      loggable.cause === undefined ? undefined : serializeError(loggable.cause, depth + 1),
  };
}
