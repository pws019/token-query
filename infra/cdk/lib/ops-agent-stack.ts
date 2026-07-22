import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  aws_cloudwatch as cloudwatch,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// AI Ops Agent, root-cause MVP -- see docs/todayToDo-ai-ops-agent.md.
// Chain: apps/server's existing structured `logError("github_profile_request_failed", { code:
// "database_upsert_failed", ... })` call (routes/github.ts) -> Metric Filter turns that into a
// custom metric -> Alarm -> EventBridge Rule (event-driven, not the Scheduler used by
// preview-reconciliation-stack.ts) -> this Lambda queries Logs Insights for context, asks an
// LLM for a root-cause hypothesis, and dedupes against open GitHub issues before filing one.
export class OpsAgentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const apiFunctionLogGroupName = "/aws/lambda/token-query-function";

    // Not created here -- token-query-function's own log group belongs to api-stack.ts.
    // Importing by name (not via an SSM export) matches how api-stack.ts itself imports the
    // heartbeat Alarm by a hardcoded ARN pattern: the log group name is a fixed, known literal.
    const apiFunctionLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      "ImportedApiFunctionLogGroup",
      apiFunctionLogGroupName,
    );

    // Only matches the one error code we've validated end-to-end in Part 1 of
    // docs/todayToDo-ai-ops-agent.md. Extending to other error codes later just means adding
    // more Metric Filter + Alarm pairs pointed at the same ops-agent Lambda, not a redesign.
    const dbUpsertFailedMetricFilter = new logs.MetricFilter(this, "DbUpsertFailedMetricFilter", {
      logGroup: apiFunctionLogGroup,
      filterPattern: logs.FilterPattern.literal(
        '{ $.level = "error" && $.event = "github_profile_request_failed" && $.code = "database_upsert_failed" }',
      ),
      metricNamespace: "TokenQueryOps",
      metricName: "DbUpsertFailedCount",
      metricValue: "1",
      defaultValue: 0,
    });

    // treatMissingData is NOT_BREACHING here (long stretches with zero database errors are the
    // normal, healthy state), the opposite of the heartbeat Alarm in monitoring-stack.ts (where
    // no data means the canary itself stopped running, which IS a problem) -- same asymmetry
    // as the preview-cleanup DLQ Alarm, don't copy the heartbeat Alarm's settings here.
    const dbUpsertFailedAlarm = dbUpsertFailedMetricFilter.metric({
      statistic: "Sum",
      period: Duration.minutes(5),
    }).createAlarm(this, "DbUpsertFailedAlarm", {
      alarmName: "token-query-db-upsert-failed",
      alarmDescription:
        "A database upsert failed in queryAndSaveGithubProfile (apps/server/src/services/github-profile.ts) -- likely a schema/migration or connectivity problem.",
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Not created by this stack -- create once, out of band, before deploying:
    //   aws secretsmanager create-secret --name token-query/ops-agent/github-token --secret-string <PAT>
    //   aws secretsmanager create-secret --name token-query/ops-agent/gemini-api-key --secret-string <key>
    // A separate GitHub PAT from Part 7's reconciliation token, scoped to issues:write only --
    // deliberately not reusing that token so this Lambda can't touch preview infrastructure.
    // Get a Gemini key at https://aistudio.google.com/apikey.
    const githubTokenSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "OpsAgentGitHubTokenSecret",
      "token-query/ops-agent/github-token",
    );

    const geminiApiKeySecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "OpsAgentGeminiApiKeySecret",
      "token-query/ops-agent/gemini-api-key",
    );

    const opsAgentFunction = new lambda.Function(this, "OpsAgentFunction", {
      functionName: "token-query-ops-agent",
      description:
        "Root-cause MVP: queries Logs Insights for context around a database-error Alarm, asks an LLM for a hypothesis, and files/comments on a GitHub issue.",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(path.dirname(fileURLToPath(import.meta.url)), "../lambda/ops-agent")),
      // Logs Insights polling plus the Gemini API call ran ~10s in Part 1 practice (see the
      // archived flowchart in docs/todayToDo-ai-ops-agent.md) -- the Lambda default of 3s/128MB
      // is nowhere near enough.
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        SOURCE_LOG_GROUP: apiFunctionLogGroupName,
        GITHUB_REPO: "pws019/token-query",
        GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
        GEMINI_API_KEY_SECRET_ARN: geminiApiKeySecret.secretArn,
      },
    });

    githubTokenSecret.grantRead(opsAgentFunction);
    geminiApiKeySecret.grantRead(opsAgentFunction);

    opsAgentFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "QueryApiFunctionLogsForRootCause",
        actions: ["logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery"],
        resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:${apiFunctionLogGroupName}:*`],
      }),
    );

    // Event-driven (Rule), not time-driven (Scheduler, used by preview-reconciliation-stack.ts)
    // -- this only needs to run when the Alarm actually trips.
    new events.Rule(this, "DbUpsertFailedAlarmRule", {
      ruleName: "token-query-db-upsert-failed-alarm-rule",
      eventPattern: {
        source: ["aws.cloudwatch"],
        detailType: ["CloudWatch Alarm State Change"],
        resources: [dbUpsertFailedAlarm.alarmArn],
        detail: {
          state: { value: ["ALARM"] },
        },
      },
      targets: [new events_targets.LambdaFunction(opsAgentFunction)],
    });

    new CfnOutput(this, "OpsAgentFunctionName", {
      description: "Name of the ops-agent Lambda.",
      value: opsAgentFunction.functionName,
    });

    new CfnOutput(this, "DbUpsertFailedAlarmName", {
      description: "Alarm that triggers the ops-agent Lambda via EventBridge.",
      value: dbUpsertFailedAlarm.alarmName,
    });
  }
}
