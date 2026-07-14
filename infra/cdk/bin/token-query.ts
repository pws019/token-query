#!/usr/bin/env node
import { App, BootstraplessSynthesizer } from "aws-cdk-lib";

import { ApiStack } from "../lib/api-stack";
import { FoundationStack } from "../lib/foundation-stack";
import { PermissionsStack } from "../lib/permissions-stack";
import { PreviewApiStack } from "../lib/preview-api-stack";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-west-2",
};

new PermissionsStack(app, "token-query-permissions", {
  env,
  synthesizer: new BootstraplessSynthesizer(),
});
new FoundationStack(app, "token-query-foundation", { env });
new ApiStack(app, "token-query-api", { env });
new PreviewApiStack(app, "token-query-preview-api", { env });
