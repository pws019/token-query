import { CfnOutput, CfnParameter, Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  aws_cloudwatch as cloudwatch,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_lambda_event_sources as lambda_event_sources,
  aws_sns as sns,
  aws_sqs as sqs,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

// Runs as a normal Lambda invocation (not Synthetics), so this is plain Node.js --
// the AWS SDK v3 CloudFormation client ships with the nodejs22.x managed runtime,
// no bundling required for an inline function this small.
const CONSUMER_SCRIPT = `
const { CloudFormationClient, DeleteStackCommand, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');

const cfn = new CloudFormationClient({});
const stackNamePattern = /^token-query-preview-(api|go)-[a-z0-9-]+$/;

exports.handler = async (event) => {
  for (const record of event.Records) {
    let payload;
    try {
      payload = JSON.parse(record.body);
    } catch (err) {
      throw new Error('Invalid JSON payload: ' + record.body.slice(0, 200));
    }

    const stackName = payload.stackName;
    if (typeof stackName !== 'string' || !stackNamePattern.test(stackName)) {
      throw new Error('Invalid or missing stackName in payload: ' + JSON.stringify(payload));
    }

    console.log(JSON.stringify({ event: 'preview_cleanup_start', stackName, previewId: payload.previewId }));

    try {
      const describeResult = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const status = describeResult.Stacks && describeResult.Stacks[0] && describeResult.Stacks[0].StackStatus;
      if (status === 'DELETE_COMPLETE') {
        console.log(JSON.stringify({ event: 'preview_cleanup_already_deleted', stackName }));
        continue;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/does not exist/i.test(message)) {
        console.log(JSON.stringify({ event: 'preview_cleanup_stack_not_found', stackName }));
        continue;
      }
      throw err;
    }

    await cfn.send(new DeleteStackCommand({ StackName: stackName }));
    console.log(JSON.stringify({ event: 'preview_cleanup_delete_initiated', stackName }));
  }
};
`;

export class PreviewCleanupStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const opsAlertsTopicArn = new CfnParameter(this, "OpsAlertsTopicArn", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/monitoring/ops-alerts-topic-arn",
      description: "SNS topic ARN (from the monitoring stack) that ops alerts publish to.",
    });

    const opsAlertsTopic = sns.Topic.fromTopicArn(this, "OpsAlertsTopic", opsAlertsTopicArn.valueAsString);

    const dlq = new sqs.Queue(this, "PreviewCleanupDlq", {
      queueName: "token-query-preview-cleanup-dlq",
      retentionPeriod: Duration.days(14),
    });

    // maxReceiveCount is intentionally low (3): a retry a handful of times is enough
    // for transient CloudFormation throttling, but a stackName that keeps failing
    // validation or DeleteStack is a bug, not something more retries will fix.
    const queue = new sqs.Queue(this, "PreviewCleanupQueue", {
      queueName: "token-query-preview-cleanup-queue",
      // 6x the consumer Lambda's timeout (30s), per SQS best practice, so a message
      // being processed can't become visible again -- and picked up by a second
      // concurrent invocation -- before the first one finishes.
      visibilityTimeout: Duration.seconds(180),
      deadLetterQueue: {
        queue: dlq,
        maxReceiveCount: 3,
      },
    });

    const consumerFunction = new lambda.Function(this, "PreviewCleanupConsumer", {
      functionName: "token-query-preview-cleanup-consumer",
      description: "Consumes preview-cleanup retry messages and deletes the failed CDK preview stack directly via CloudFormation.",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromInline(CONSUMER_SCRIPT),
      timeout: Duration.seconds(30),
      memorySize: 256,
    });

    consumerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ManagePreviewStacks",
        actions: ["cloudformation:DescribeStacks", "cloudformation:DeleteStack"],
        resources: [
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/token-query-preview-api-*/*`,
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/token-query-preview-go-*/*`,
        ],
      }),
    );

    consumerFunction.addEventSource(
      new lambda_event_sources.SqsEventSource(queue, {
        batchSize: 1,
      }),
    );

    new cloudwatch.CfnAlarm(this, "PreviewCleanupDlqAlarm", {
      alarmName: "token-query-preview-cleanup-dlq-not-empty",
      alarmDescription:
        "A preview environment failed to clean up after retries and is stuck in the dead-letter queue -- it is likely still running and billing.",
      namespace: "AWS/SQS",
      metricName: "ApproximateNumberOfMessagesVisible",
      dimensions: [{ name: "QueueName", value: dlq.queueName }],
      statistic: "Maximum",
      period: 300,
      evaluationPeriods: 1,
      threshold: 0,
      comparisonOperator: "GreaterThanThreshold",
      // Unlike the canary SuccessPercent alarm (Part 2), this metric only gets a
      // datapoint when the queue has messages -- an empty, idle DLQ is the normal
      // state and does not publish 0s every period. Missing data here means
      // "nothing happened", not "something broke", so it must not be breaching.
      treatMissingData: "notBreaching",
      alarmActions: [opsAlertsTopic.topicArn],
    });

    new ssm.StringParameter(this, "QueueUrlParam", {
      parameterName: "/token-query/preview-cleanup/queue-url",
      stringValue: queue.queueUrl,
    });

    new ssm.StringParameter(this, "QueueArnParam", {
      parameterName: "/token-query/preview-cleanup/queue-arn",
      stringValue: queue.queueArn,
    });

    new CfnOutput(this, "QueueUrl", {
      description: "SQS queue URL that GitHub Actions sends failed preview-cleanup jobs to.",
      value: queue.queueUrl,
    });

    new CfnOutput(this, "QueueArn", {
      description: "SQS queue ARN for the preview-cleanup retry queue.",
      value: queue.queueArn,
    });

    new CfnOutput(this, "DlqUrl", {
      description: "Dead-letter queue URL. A non-zero message count means preview cleanup is stuck and needs manual attention.",
      value: dlq.queueUrl,
    });
  }
}
