import { CfnOutput, CfnParameter, Fn, Stack, type StackProps } from "aws-cdk-lib";
import { aws_iam as iam, aws_lambda as lambda, aws_logs as logs } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type PreviewApiStackProps = StackProps & {
  previewId: string;
};

export class PreviewApiStack extends Stack {
  constructor(scope: Construct, id: string, props: PreviewApiStackProps) {
    super(scope, id, props);

    const { previewId } = props;
    const resourceName = `token-query-pr-${previewId}`;

    const corsOrigin = new CfnParameter(this, "CorsOrigin", {
      type: "String",
      default: `https://${previewId}.app.doyouadoreme.online`,
      description: "Allowed browser origin for the preview Lambda API.",
    });

    const dbClusterEndpoint = new CfnParameter(this, "DbClusterEndpoint", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/foundation/db-cluster-endpoint",
      description: "Aurora cluster endpoint exported by the foundation stack.",
    });

    const dbCredentialsSecretArn = new CfnParameter(this, "DbCredentialsSecretArn", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/foundation/db-credentials-secret-arn",
      description: "Secrets Manager secret ARN for the Aurora master credentials.",
    });

    const internalProxyToken = new CfnParameter(this, "InternalProxyToken", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Optional token required from Cloudflare Worker requests.",
    });

    const adminMigrationToken = new CfnParameter(this, "AdminMigrationToken", {
      type: "String",
      noEcho: true,
      default: "",
      description: "Optional token used to run admin database initialization.",
    });

    const goServiceOrigin = new CfnParameter(this, "GoServiceOrigin", {
      type: "String",
      default: "http://go.token-query.internal:8080",
      description: "Internal Go service origin resolved through Cloud Map.",
    });

    const privateSubnetIds = new CfnParameter(this, "PrivateSubnetIds", {
      type: "AWS::SSM::Parameter::Value<List<AWS::EC2::Subnet::Id>>",
      default: "/token-query/foundation/private-subnet-ids",
      description: "Private subnet IDs exported by the foundation stack.",
    });

    const lambdaSecurityGroupId = new CfnParameter(this, "LambdaSecurityGroupId", {
      type: "AWS::SSM::Parameter::Value<AWS::EC2::SecurityGroup::Id>",
      default: "/token-query/foundation/lambda-security-group-id",
      description: "Lambda security group exported by the foundation stack.",
    });

    const executionRole = new iam.Role(this, "PreviewFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for Token Query preview Lambda API ${previewId}.`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    const logGroup = new logs.CfnLogGroup(this, "PreviewFunctionLogGroup", {
      logGroupName: `/aws/lambda/${resourceName}`,
      retentionInDays: 7,
    });

    const serverDistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/server/dist");
    const functionCode = lambda.Code.fromAsset(serverDistPath).bind(this);

    if (!functionCode.s3Location) {
      throw new Error("Token Query preview Lambda code must be packaged as an S3 asset.");
    }

    const apiFunction = new lambda.CfnFunction(this, "PreviewFunction", {
      functionName: resourceName,
      description: `Token Query preview API for ${previewId}.`,
      runtime: "nodejs22.x",
      architectures: ["arm64"],
      handler: "lambda.handler",
      role: executionRole.roleArn,
      code: {
        s3Bucket: functionCode.s3Location.bucketName,
        s3Key: functionCode.s3Location.objectKey,
        s3ObjectVersion: functionCode.s3Location.objectVersion,
      },
      memorySize: 128,
      timeout: 20,
      tracingConfig: {
        mode: "PassThrough",
      },
      loggingConfig: {
        logFormat: "Text",
        logGroup: logGroup.ref,
      },
      vpcConfig: {
        securityGroupIds: [lambdaSecurityGroupId.valueAsString],
        subnetIds: privateSubnetIds.valueAsList,
      },
      environment: {
        variables: {
          NODE_ENV: "production",
          APP_ENV: "preview",
          PREVIEW_ID: previewId,
          CORS_ORIGIN: corsOrigin.valueAsString,
          DATABASE_URL: Fn.sub(
            "postgresql://postgres:{{resolve:secretsmanager:${SecretId}:SecretString:password}}@${DbClusterEndpoint}:5432/postgres?sslmode=require&uselibpqcompat=true",
            {
              SecretId: dbCredentialsSecretArn.valueAsString,
              DbClusterEndpoint: dbClusterEndpoint.valueAsString,
            },
          ),
          INTERNAL_PROXY_TOKEN: internalProxyToken.valueAsString,
          ADMIN_MIGRATION_TOKEN: adminMigrationToken.valueAsString,
          GO_SERVICE_ORIGIN: goServiceOrigin.valueAsString,
        },
      },
    });
    apiFunction.addDependency(logGroup);

    new CfnOutput(this, "PreviewId", {
      value: previewId,
    });

    new CfnOutput(this, "FunctionName", {
      description: "Preview Lambda function managed by this CDK stack.",
      value: apiFunction.ref,
    });
  }
}
