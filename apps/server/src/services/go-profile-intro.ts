import { env } from "@token-query/env/server";
import { z } from "zod";

import { logError, logInfo, requestIdHeader } from "../utils/request-log";

const goProfileIntroResponseSchema = z.object({
  githubId: z.number().int().positive(),
  login: z.string().min(1),
  intro: z.string().min(1),
});

export type GoProfileIntroResponse = z.infer<typeof goProfileIntroResponseSchema>;

export type GoProfileIntroContext = {
  requestId: string;
  appEnv: string;
  previewId?: string;
};

export class GoProfileIntroError extends Error {
  constructor(
    public readonly code: "go_service_request_failed" | "go_service_invalid_response",
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "GoProfileIntroError";
  }
}

export async function generateProfileIntro(
  githubId: number,
  context: GoProfileIntroContext,
): Promise<GoProfileIntroResponse> {
  const url = new URL("/profile/intro", env.GO_SERVICE_ORIGIN);
  const startedAt = Date.now();
  const headers = new Headers({
    "Content-Type": "application/json",
    [requestIdHeader]: context.requestId,
    "X-App-Env": context.appEnv,
  });

  if (context.previewId) {
    headers.set("X-Preview-Id", context.previewId);
  }

  logInfo("go_profile_intro_fetch_start", {
    requestId: context.requestId,
    appEnv: context.appEnv,
    previewId: context.previewId,
    githubId,
    goServiceOrigin: env.GO_SERVICE_ORIGIN,
  });

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ githubId }),
  });

  if (!response.ok) {
    const bodySnippet = await response
      .clone()
      .text()
      .then((body) => body.slice(0, 500))
      .catch(() => "<unavailable>");

    logError("go_profile_intro_fetch_failed", {
      requestId: context.requestId,
      appEnv: context.appEnv,
      previewId: context.previewId,
      githubId,
      status: response.status,
      durationMs: Date.now() - startedAt,
      bodySnippet,
    });

    throw new GoProfileIntroError("go_service_request_failed", response.status);
  }

  const parseResult = goProfileIntroResponseSchema.safeParse(await response.json());
  if (!parseResult.success) {
    logError("go_profile_intro_invalid_response", {
      requestId: context.requestId,
      appEnv: context.appEnv,
      previewId: context.previewId,
      githubId,
      durationMs: Date.now() - startedAt,
      issues: parseResult.error.issues.map((issue) => issue.path.join(".")),
    });

    throw new GoProfileIntroError("go_service_invalid_response");
  }

  logInfo("go_profile_intro_fetch_success", {
    requestId: context.requestId,
    appEnv: context.appEnv,
    previewId: context.previewId,
    githubId: parseResult.data.githubId,
    login: parseResult.data.login,
    status: response.status,
    durationMs: Date.now() - startedAt,
  });

  return parseResult.data;
}
