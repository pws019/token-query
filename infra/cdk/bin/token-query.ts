#!/usr/bin/env node
import { App, CliCredentialsStackSynthesizer } from "aws-cdk-lib";

import { ApiStack } from "../lib/api-stack";
import { FoundationStack } from "../lib/foundation-stack";
import { GoStack } from "../lib/go-stack";
import { PermissionsStack } from "../lib/permissions-stack";
import { PreviewApiStack } from "../lib/preview-api-stack";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
};

new PermissionsStack(app, "token-query-permissions", {
  env,
  synthesizer: new CliCredentialsStackSynthesizer(),
});
new FoundationStack(app, "token-query-foundation", { env });
new ApiStack(app, "token-query-api", { env });
new GoStack(app, "token-query-go", { env });

const previewId = process.env.PREVIEW_ID;
if (previewId) {
  new PreviewApiStack(app, `token-query-preview-api-${previewId}`, {
    env,
    previewId,
  });
}
