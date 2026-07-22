import { CfnOutput, CfnParameter, Fn, Stack, type StackProps } from "aws-cdk-lib";
import {
  aws_cloudwatch as cloudwatch,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sns_subscriptions as sns_subscriptions,
  aws_ssm as ssm,
  aws_synthetics as synthetics,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

function renderHealthCheckScript(extraAssertion: string): string {
  return `
const synthetics = require('Synthetics');
const log = require('SyntheticsLogger');

const syntheticsConfiguration = synthetics.getConfiguration();
syntheticsConfiguration.setConfig({
  includeRequestHeaders: false,
  includeResponseHeaders: true,
  includeRequestBody: false,
  includeResponseBody: true,
  restrictedHeaders: [],
  restrictedUrlParameters: [],
});

const apiCanaryBlueprint = async function () {
  const validateSuccessful = async function (res) {
    return new Promise((resolve, reject) => {
      if (res.statusCode < 200 || res.statusCode > 299) {
        return reject(new Error(res.statusCode + ' ' + res.statusMessage));
      }

      let responseBody = '';
      res.on('data', (d) => {
        responseBody += d;
      });

      res.on('end', () => {
        let body;
        try {
          body = JSON.parse(responseBody);
        } catch (err) {
          return reject(new Error('Response body is not valid JSON: ' + responseBody.slice(0, 200)));
        }

        if (body.ok !== true) {
          return reject(new Error('Reported unhealthy: ok=' + JSON.stringify(body.ok)));
        }

        ${extraAssertion}

        log.info('Health check passed: ' + responseBody);
        resolve();
      });
    });
  };

  const healthCheckUrl = new URL(process.env.HEALTH_CHECK_URL);

  const requestOptions = {
    hostname: healthCheckUrl.hostname,
    method: 'GET',
    path: healthCheckUrl.pathname,
    port: healthCheckUrl.port || (healthCheckUrl.protocol === 'https:' ? 443 : 80),
    protocol: healthCheckUrl.protocol,
    body: '',
    headers: {},
  };

  const stepConfig = {
    includeRequestHeaders: false,
    includeResponseHeaders: true,
    includeRequestBody: false,
    includeResponseBody: true,
    continueOnHttpStepFailure: false,
  };

  await synthetics.executeHttpStep('verifyHealth', requestOptions, validateSuccessful, stepConfig);
};

exports.handler = async () => {
  return await apiCanaryBlueprint();
};
`;
}

// Only asserts Lambda's own health. Go's health is checked independently by the
// Go heartbeat canary below, so a Go outage must not fail this canary too --
// otherwise a single failed run can no longer tell you which service is down.
const LAMBDA_HEARTBEAT_SCRIPT = renderHealthCheckScript("");

// Go's /health handler only ever returns { ok, service } -- no extra fields to assert.
const GO_HEARTBEAT_SCRIPT = renderHealthCheckScript("");

interface HeartbeatCanaryProps {
  /** Distinguishes construct IDs and default tags; must be unique within the stack. */
  readonly idPrefix: string;
  readonly canaryName: string;
  readonly script: string;
  readonly healthCheckUrl: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly securityGroupIds: string[];
  readonly artifactsBucket: s3.IBucket;
  readonly artifactPrefix: string;
}

export class MonitoringStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const vpcId = new CfnParameter(this, "VpcId", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/foundation/vpc-id",
      description: "VPC ID exported by the foundation stack.",
    });

    const privateSubnetIds = new CfnParameter(this, "PrivateSubnetIds", {
      type: "AWS::SSM::Parameter::Value<List<AWS::EC2::Subnet::Id>>",
      default: "/token-query/foundation/private-subnet-ids",
      description: "Private subnet IDs exported by the foundation stack.",
    });

    const goSecurityGroupId = new CfnParameter(this, "GoSecurityGroupId", {
      type: "AWS::SSM::Parameter::Value<AWS::EC2::SecurityGroup::Id>",
      default: "/token-query/foundation/go-security-group-id",
      description: "Go ECS service security group exported by the foundation stack.",
    });

    const apiHealthCheckUrl = new CfnParameter(this, "ApiHealthCheckUrl", {
      type: "String",
      default: "https://api.doyouadoreme.online/health",
      description: "Public Lambda API endpoint the Lambda heartbeat canary probes.",
    });

    const goInternalOrigin = new CfnParameter(this, "GoInternalOrigin", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/foundation/go-internal-origin",
      description: "Internal Go service origin (ALB DNS name), exported by the Go stack.",
    });

    const goAlbSecurityGroupId = new CfnParameter(this, "GoAlbSecurityGroupId", {
      type: "AWS::SSM::Parameter::Value<AWS::EC2::SecurityGroup::Id>",
      default: "/token-query/foundation/go-alb-security-group-id",
      description: "Go ALB security group exported by the Go stack.",
    });

    const alertEmail = new CfnParameter(this, "AlertEmail", {
      type: "String",
      description: "Email address subscribed to the ops alerts SNS topic for CloudWatch Alarm notifications.",
    });

    // Shared notification channel: every ops Alarm in this stack (and future ones,
    // e.g. the Part 6 preview-cleanup DLQ) publishes here instead of each getting
    // its own topic. Subject/body for CloudWatch Alarms is auto-generated by AWS and
    // already includes AlarmName + metric Dimensions, so no extra formatting needed
    // here -- only hand-rolled publishers (CodeBuild/GitHub Actions, added later)
    // will need to prefix their own Subject with a source tag.
    const opsAlertsTopic = new sns.Topic(this, "OpsAlertsTopic", {
      topicName: "token-query-ops-alerts",
      displayName: "Token Query Ops Alerts",
    });

    opsAlertsTopic.addSubscription(new sns_subscriptions.EmailSubscription(alertEmail.valueAsString));

    new ssm.StringParameter(this, "OpsAlertsTopicArnParam", {
      parameterName: "/token-query/monitoring/ops-alerts-topic-arn",
      stringValue: opsAlertsTopic.topicArn,
    });

    const artifactsBucket = s3.Bucket.fromBucketName(
      this,
      "CanaryArtifactsBucket",
      "cw-syn-results-707605822527-us-west-2",
    );

    const lambdaCanarySecurityGroup = new ec2.CfnSecurityGroup(this, "LambdaCanarySecurityGroup", {
      groupDescription: "Security group for the Token Query Lambda API heartbeat Synthetics canary.",
      groupName: "token-query-api-canary-sg",
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [
        {
          cidrIp: "0.0.0.0/0",
          ipProtocol: "-1",
          description: "Allow all outbound traffic (reaches the public API endpoint and S3 through the NAT gateway).",
        },
      ],
      tags: [
        { key: "Name", value: "token-query-api-canary-sg" },
        { key: "Project", value: "token-query" },
      ],
    });

    const lambdaCanary = this.buildHeartbeatCanary({
      idPrefix: "ApiHeartbeat",
      canaryName: "token-query-api-heartbeat",
      script: LAMBDA_HEARTBEAT_SCRIPT,
      healthCheckUrl: apiHealthCheckUrl.valueAsString,
      vpcId: vpcId.valueAsString,
      subnetIds: privateSubnetIds.valueAsList,
      securityGroupIds: [lambdaCanarySecurityGroup.attrGroupId],
      artifactsBucket,
      artifactPrefix: "canary/us-west-2/token-query-api-heartbeat-cdk",
    });

    const goCanarySecurityGroup = new ec2.CfnSecurityGroup(this, "GoCanarySecurityGroup", {
      groupDescription: "Security group for the Token Query Go heartbeat Synthetics canary.",
      groupName: "token-query-go-canary-sg",
      vpcId: vpcId.valueAsString,
      securityGroupEgress: [
        {
          cidrIp: "0.0.0.0/0",
          ipProtocol: "-1",
          description: "Allow all outbound traffic (reaches the Go service internally and S3 through the NAT gateway).",
        },
      ],
      tags: [
        { key: "Name", value: "token-query-go-canary-sg" },
        { key: "Project", value: "token-query" },
      ],
    });

    // Kept for backwards compatibility with anything still resolving Go's task IPs
    // directly; the heartbeat canary itself now goes through the ALB (see
    // GoAlbIngressFromCanary below) since native ECS blue/green deployments don't
    // support Cloud Map service registration (AWS rejects serviceRegistries + a
    // non-ROLLING deploymentController), so Cloud Map no longer has live instances.
    new ec2.CfnSecurityGroupIngress(this, "GoIngressFromCanary", {
      groupId: goSecurityGroupId.valueAsString,
      sourceSecurityGroupId: goCanarySecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      description: "HTTP from the Token Query Go heartbeat Synthetics canary.",
    });

    // The Go canary now probes through the ALB (Cloud Map no longer has live
    // instances -- see the comment above), so it needs to be let through the ALB's
    // security group too.
    new ec2.CfnSecurityGroupIngress(this, "GoAlbIngressFromCanary", {
      groupId: goAlbSecurityGroupId.valueAsString,
      sourceSecurityGroupId: goCanarySecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      description: "HTTP from the Token Query Go heartbeat Synthetics canary.",
    });

    const goCanary = this.buildHeartbeatCanary({
      idPrefix: "GoHeartbeat",
      canaryName: "token-query-go-heartbeat",
      script: GO_HEARTBEAT_SCRIPT,
      healthCheckUrl: Fn.sub("${Origin}/health", { Origin: goInternalOrigin.valueAsString }),
      vpcId: vpcId.valueAsString,
      subnetIds: privateSubnetIds.valueAsList,
      securityGroupIds: [goCanarySecurityGroup.attrGroupId],
      artifactsBucket,
      artifactPrefix: "canary/us-west-2/token-query-go-heartbeat-cdk",
    });

    this.buildFailureAlarm({
      idPrefix: "ApiHeartbeat",
      canaryName: lambdaCanary.name,
      alarmName: "token-query-api-heartbeat-failed",
      alarmDescription: "Token Query Lambda API heartbeat canary failed -- the /health endpoint is unreachable or reporting unhealthy.",
      alarmTopicArn: opsAlertsTopic.topicArn,
    });

    this.buildFailureAlarm({
      idPrefix: "GoHeartbeat",
      canaryName: goCanary.name,
      alarmName: "token-query-go-heartbeat-failed",
      alarmDescription: "Token Query Go heartbeat canary failed -- the internal Go service is unreachable or reporting unhealthy.",
      alarmTopicArn: opsAlertsTopic.topicArn,
    });

    new CfnOutput(this, "OpsAlertsTopicArn", {
      description: "SNS topic ARN that ops Alarms publish to. Subscribe additional endpoints (Slack, PagerDuty, etc.) here.",
      value: opsAlertsTopic.topicArn,
    });

    new CfnOutput(this, "LambdaCanaryName", {
      description: "Name of the Lambda API heartbeat Synthetics canary.",
      value: lambdaCanary.name,
    });

    new CfnOutput(this, "GoCanaryName", {
      description: "Name of the Go heartbeat Synthetics canary.",
      value: goCanary.name,
    });

    new CfnOutput(this, "LambdaCanarySecurityGroupId", {
      description: "Security group ID attached to the Lambda heartbeat canary's VPC network interfaces.",
      value: lambdaCanarySecurityGroup.attrGroupId,
    });

    new CfnOutput(this, "GoCanarySecurityGroupId", {
      description: "Security group ID attached to the Go heartbeat canary's VPC network interfaces.",
      value: goCanarySecurityGroup.attrGroupId,
    });
  }

  private buildHeartbeatCanary(props: HeartbeatCanaryProps): synthetics.CfnCanary {
    const canaryRole = new iam.Role(this, `${props.idPrefix}CanaryRole`, {
      roleName: `token-query-${props.canaryName.replace(/^token-query-/, "")}-canary-role`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the ${props.canaryName} Synthetics canary.`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole")],
    });

    canaryRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteCanaryArtifacts",
        actions: ["s3:PutObject", "s3:GetBucketLocation"],
        resources: [props.artifactsBucket.bucketArn, `${props.artifactsBucket.bucketArn}/*`],
      }),
    );

    canaryRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PublishCanaryMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "CloudWatchSynthetics" },
        },
      }),
    );

    return new synthetics.CfnCanary(this, `${props.idPrefix}Canary`, {
      name: props.canaryName,
      artifactS3Location: `s3://${props.artifactsBucket.bucketName}/${props.artifactPrefix}`,
      executionRoleArn: canaryRole.roleArn,
      runtimeVersion: "syn-nodejs-puppeteer-16.1",
      startCanaryAfterCreation: true,
      schedule: {
        expression: "rate(5 minutes)",
        durationInSeconds: "0",
      },
      failureRetentionPeriod: 2,
      successRetentionPeriod: 1,
      code: {
        handler: "apiCanaryBlueprint.handler",
        script: props.script,
      },
      runConfig: {
        timeoutInSeconds: 60,
        memoryInMb: 960,
        activeTracing: false,
        environmentVariables: {
          HEALTH_CHECK_URL: props.healthCheckUrl,
        },
      },
      vpcConfig: {
        vpcId: props.vpcId,
        subnetIds: props.subnetIds,
        securityGroupIds: props.securityGroupIds,
      },
      tags: [
        { key: "Name", value: props.canaryName },
        { key: "Project", value: "token-query" },
      ],
    });
  }

  private buildFailureAlarm(props: {
    idPrefix: string;
    canaryName: string;
    alarmName: string;
    alarmDescription: string;
    alarmTopicArn: string;
  }): void {
    new cloudwatch.CfnAlarm(this, `${props.idPrefix}FailureAlarm`, {
      alarmName: props.alarmName,
      alarmDescription: props.alarmDescription,
      namespace: "CloudWatchSynthetics",
      // SuccessPercent publishes a datapoint on every run (100 or 0), unlike Failed,
      // which Synthetics only emits when a run actually fails. Alarming on Failed with
      // treatMissingData: breaching meant every successful run (no Failed datapoint)
      // was itself treated as a threshold breach.
      metricName: "SuccessPercent",
      dimensions: [{ name: "CanaryName", value: props.canaryName }],
      statistic: "Average",
      period: 300,
      evaluationPeriods: 1,
      threshold: 100,
      comparisonOperator: "LessThanThreshold",
      treatMissingData: "breaching",
      alarmActions: [props.alarmTopicArn],
      okActions: [props.alarmTopicArn],
    });
  }
}
