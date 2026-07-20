import { CfnOutput, CfnParameter, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  aws_iam as iam,
  aws_lambda as lambda,
  aws_scheduler as scheduler,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Belt-and-suspenders for Part 7: the paths-filter fix on the three cleanup
// workflows (see preview-cleanup-flow.md) only covers "PR closed, cleanup ran".
// It does nothing for previews deployed via `workflow_dispatch` with no PR
// attached at all, or for a cleanup run that itself got cancelled/never ran.
// This scans for orphaned preview resources daily and reconciles them.
export class PreviewReconciliationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const queueUrl = new CfnParameter(this, "QueueUrl", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/preview-cleanup/queue-url",
      description: "Preview-cleanup SQS queue URL exported by the preview-cleanup stack.",
    });

    const queueArn = new CfnParameter(this, "QueueArn", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/preview-cleanup/queue-arn",
      description: "Preview-cleanup SQS queue ARN exported by the preview-cleanup stack.",
    });

    const githubRepo = new CfnParameter(this, "GitHubRepo", {
      type: "String",
      default: "pws019/token-query",
      description: "owner/repo used to look up currently-open PRs.",
    });

    const cloudflareAccountId = new CfnParameter(this, "CloudflareAccountId", {
      type: "String",
      description: "Cloudflare account ID that owns the preview Worker scripts.",
    });

    // These secrets are NOT created by this stack -- create them once, out of band,
    // before deploying (see docs/knowledge/preview-cleanup-flow.md):
    //   aws secretsmanager create-secret --name token-query/reconciliation/github-token --secret-string <PAT>
    //   aws secretsmanager create-secret --name token-query/reconciliation/cloudflare-api-token --secret-string <token>
    // A fine-grained GitHub PAT only needs read access to pull requests; the
    // Cloudflare token needs Workers Scripts Read + Edit (edit = delete orphans).
    const githubTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "GitHubTokenSecret",
      "token-query/reconciliation/github-token",
    );

    const cloudflareApiTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "CloudflareApiTokenSecret",
      "token-query/reconciliation/cloudflare-api-token",
    );

    const reconciliationFunction = new lambda.Function(this, "PreviewReconciliationFunction", {
      functionName: "token-query-preview-reconciliation",
      description:
        "Daily sweep for orphaned preview environments: CFN preview stacks and Cloudflare preview Workers whose PR is no longer open.",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(path.dirname(fileURLToPath(import.meta.url)), "../lambda/preview-reconciliation")),
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        QUEUE_URL: queueUrl.valueAsString,
        GITHUB_REPO: githubRepo.valueAsString,
        CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId.valueAsString,
        GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
        CLOUDFLARE_TOKEN_SECRET_ARN: cloudflareApiTokenSecret.secretArn,
      },
    });

    githubTokenSecret.grantRead(reconciliationFunction);
    cloudflareApiTokenSecret.grantRead(reconciliationFunction);

    reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ListPreviewStacks",
        // ListStacks is account-wide and does not support resource-level scoping.
        actions: ["cloudformation:ListStacks"],
        resources: ["*"],
      }),
    );

    reconciliationFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "QueueOrphanStackCleanup",
        actions: ["sqs:SendMessage"],
        resources: [queueArn.valueAsString],
      }),
    );

    const schedulerRole = new iam.Role(this, "PreviewReconciliationSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
      description: "Assumed by EventBridge Scheduler to invoke the preview reconciliation Lambda.",
    });

    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [reconciliationFunction.functionArn],
      }),
    );

    new scheduler.CfnSchedule(this, "PreviewReconciliationSchedule", {
      name: "token-query-preview-reconciliation-daily",
      description: "Triggers the preview reconciliation sweep once a day.",
      scheduleExpression: "rate(1 day)",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: reconciliationFunction.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    new CfnOutput(this, "ReconciliationFunctionName", {
      description: "Name of the preview reconciliation Lambda.",
      value: reconciliationFunction.functionName,
    });
  }
}
