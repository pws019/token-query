import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { env } from "@token-query/env/server";

import { app } from "./app.lambda";
import { ensureRequestId, logError, logInfo, requestIdHeader } from "./utils/request-log";

type LambdaEvent = {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  path?: string;
  httpMethod?: string;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
    };
    domainName?: string;
    stage?: string;
  };
  headers?: Record<string, string | undefined>;
  cookies?: string[];
  body?: string | null;
  isBase64Encoded?: boolean;
};

type LambdaResult = {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: false;
};

const lambdaClient = new LambdaClient({});

export async function handler(event: LambdaEvent): Promise<LambdaResult> {
  const requestId = ensureEventRequestId(event);
  logInfo("lambda_event_received", {
    requestId,
    appEnv: env.APP_ENV,
    previewId: getHeader(event, "x-preview-id") ?? env.PREVIEW_ID,
    method: event.requestContext?.http?.method ?? event.httpMethod ?? "GET",
    path: event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/",
  });

  const previewResult = await maybeInvokePreview(event);
  if (previewResult) {
    previewResult.headers[requestIdHeader] = requestId;
    return previewResult;
  }

  const request = toRequest(event);
  const response = await app.fetch(request);
  return toLambdaResult(response);
}

async function maybeInvokePreview(event: LambdaEvent): Promise<LambdaResult | undefined> {
  if (env.APP_ENV !== "prod") {
    return undefined;
  }

  const previewId = getHeader(event, "x-preview-id");
  if (!previewId || !isValidPreviewId(previewId)) {
    return undefined;
  }

  const functionName = `token-query-pr-${previewId}`;
  const requestId = getHeader(event, requestIdHeader.toLowerCase());

  logInfo("preview_lambda_invoke_start", {
    requestId,
    appEnv: env.APP_ENV,
    previewId,
    functionName,
  });

  try {
    const result = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(event)),
      }),
    );

    if (!result.Payload) {
      logError("preview_lambda_empty_response", {
        requestId,
        appEnv: env.APP_ENV,
        previewId,
        functionName,
      });
      return jsonResult(502, { error: "Preview Lambda returned an empty response." });
    }

    const payload = JSON.parse(Buffer.from(result.Payload).toString("utf8")) as LambdaResult;
    if (result.FunctionError) {
      logError("preview_lambda_function_error", {
        requestId,
        appEnv: env.APP_ENV,
        previewId,
        functionName,
        functionError: result.FunctionError,
      });
      return jsonResult(502, {
        error: "Preview Lambda invocation failed.",
        previewId,
        functionError: result.FunctionError,
      });
    }

    logInfo("preview_lambda_invoke_success", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      functionName,
      status: payload.statusCode,
    });

    return payload;
  } catch (error) {
    if (isLambdaNotFoundError(error)) {
      logInfo("preview_lambda_not_found_fallback", {
        requestId,
        appEnv: env.APP_ENV,
        previewId,
        functionName,
      });
      return undefined;
    }

    logError("preview_lambda_invoke_failed", {
      requestId,
      appEnv: env.APP_ENV,
      previewId,
      functionName,
      error: error instanceof Error ? error.message : String(error),
    });

    return jsonResult(502, { error: "Preview Lambda invocation failed.", previewId });
  }
}

function toRequest(event: LambdaEvent) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? "GET";
  const headers = new Headers();

  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  if (event.cookies?.length) {
    headers.set("cookie", event.cookies.join("; "));
  }

  const body =
    event.body == null
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;

  return new Request(toUrl(event), {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });
}

function toUrl(event: LambdaEvent) {
  const headers = event.headers ?? {};
  const host = headers.host ?? headers.Host ?? event.requestContext?.domainName ?? "localhost";
  const proto = headers["x-forwarded-proto"] ?? headers["X-Forwarded-Proto"] ?? "https";
  const path = event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";

  return `${proto}://${host}${path}${query}`;
}

function getHeader(event: LambdaEvent, targetName: string) {
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (name.toLowerCase() === targetName) {
      return value;
    }
  }

  return undefined;
}

function ensureEventRequestId(event: LambdaEvent) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const requestId = ensureRequestId(headers);
  event.headers = {
    ...(event.headers ?? {}),
    [requestIdHeader]: requestId,
  };

  return requestId;
}

function isValidPreviewId(previewId: string) {
  return /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(previewId);
}

function isLambdaNotFoundError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "ResourceNotFoundException" || error.message.includes("Function not found"))
  );
}

function jsonResult(statusCode: number, body: unknown): LambdaResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

async function toLambdaResult(response: Response): Promise<LambdaResult> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      cookies.push(value);
      return;
    }

    headers[name] = value;
  });

  return {
    statusCode: response.status,
    headers,
    cookies: cookies.length ? cookies : undefined,
    body: await response.text(),
    isBase64Encoded: false,
  };
}
