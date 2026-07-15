import { env } from "@token-query/env/server";
import { z } from "zod";

const goProfileIntroResponseSchema = z.object({
  githubId: z.number().int().positive(),
  login: z.string().min(1),
  intro: z.string().min(1),
});

export type GoProfileIntroResponse = z.infer<typeof goProfileIntroResponseSchema>;

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

export async function generateProfileIntro(githubId: number): Promise<GoProfileIntroResponse> {
  const response = await fetch(new URL("/profile/intro", env.GO_SERVICE_ORIGIN), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ githubId }),
  });

  if (!response.ok) {
    throw new GoProfileIntroError("go_service_request_failed", response.status);
  }

  const parseResult = goProfileIntroResponseSchema.safeParse(await response.json());
  if (!parseResult.success) {
    throw new GoProfileIntroError("go_service_invalid_response");
  }

  return parseResult.data;
}
