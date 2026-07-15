import { randomUUID } from "node:crypto";

import { serializeError } from "./error-log";

export const requestIdHeader = "X-Request-Id";

export function ensureRequestId(headers: Headers) {
  const incomingRequestId = headers.get(requestIdHeader);
  if (incomingRequestId && isSafeRequestId(incomingRequestId)) {
    return incomingRequestId;
  }

  return randomUUID();
}

export function logInfo(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

export function logWarn(event: string, fields: Record<string, unknown> = {}) {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

export function logError(event: string, fields: Record<string, unknown> = {}) {
  console.error(JSON.stringify({ level: "error", event, ...fields }));
}

export function errorField(error: unknown) {
  return serializeError(error);
}

function isSafeRequestId(requestId: string) {
  return /^[a-zA-Z0-9._:-]{1,128}$/.test(requestId);
}
