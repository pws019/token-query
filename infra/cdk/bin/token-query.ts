#!/usr/bin/env node
import { App, CliCredentialsStackSynthesizer } from "aws-cdk-lib";

import { ApiStack } from "../lib/api-stack";
import { FoundationStack } from "../lib/foundation-stack";
import { GoStack } from "../lib/go-stack";
import { MonitoringStack } from "../lib/monitoring-stack";
import { PermissionsStack } from "../lib/permissions-stack";
import { PreviewApiStack } from "../lib/preview-api-stack";
import { PreviewCleanupStack } from "../lib/preview-cleanup-stack";
import { PreviewGoStack } from "../lib/preview-go-stack";
import { PreviewReconciliationStack } from "../lib/preview-reconciliation-stack";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
};

const stackScope = process.env.CDK_STACK_SCOPE ?? "all";

if (stackScope === "permissions" || stackScope === "all") {
  new PermissionsStack(app, "token-query-permissions", {
    env,
    synthesizer: new CliCredentialsStackSynthesizer(),
  });
}

if (stackScope === "foundation" || stackScope === "all") {
  new FoundationStack(app, "token-query-foundation", { env });
}

if (stackScope === "api" || stackScope === "all") {
  new ApiStack(app, "token-query-api", { env });
}

if (stackScope === "go" || stackScope === "all") {
  new GoStack(app, "token-query-go", { env });
}

if (stackScope === "monitoring" || stackScope === "all") {
  new MonitoringStack(app, "token-query-monitoring", { env });
}

if (stackScope === "preview-cleanup" || stackScope === "all") {
  new PreviewCleanupStack(app, "token-query-preview-cleanup", { env });
}

if (stackScope === "preview-reconciliation" || stackScope === "all") {
  new PreviewReconciliationStack(app, "token-query-preview-reconciliation", { env });
}

const previewId = process.env.PREVIEW_ID;
if (previewId) {
  const previewStackScope = process.env.PREVIEW_STACK_SCOPE ?? stackScope;

  if (previewStackScope === "api" || previewStackScope === "all") {
    new PreviewApiStack(app, `token-query-preview-api-${previewId}`, {
      env,
      previewId,
    });
  }

  if (previewStackScope === "go" || previewStackScope === "all") {
    new PreviewGoStack(app, `token-query-preview-go-${previewId}`, {
      env,
      previewId,
    });
  }
}
