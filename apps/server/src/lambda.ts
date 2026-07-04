import { app } from "./app.lambda";

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

export async function handler(event: LambdaEvent): Promise<LambdaResult> {
  const request = toRequest(event);
  const response = await app.fetch(request);
  return toLambdaResult(response);
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
