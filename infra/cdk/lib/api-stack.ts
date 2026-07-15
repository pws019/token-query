import { CfnOutput, CfnParameter, Fn, Stack, type StackProps } from "aws-cdk-lib";
import { aws_apigatewayv2 as apigatewayv2, aws_iam as iam, aws_lambda as lambda, aws_logs as logs } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export class ApiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const corsOrigin = new CfnParameter(this, "CorsOrigin", {
      type: "String",
      default: "https://app.doyouadoreme.online",
      description: "Allowed browser origin for the Lambda API.",
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

    const apiCustomDomainName = new CfnParameter(this, "ApiCustomDomainName", {
      type: "String",
      default: "api.doyouadoreme.online",
      description: "Custom domain name for the HTTP API.",
    });

    const apiCertificateArn = new CfnParameter(this, "ApiCertificateArn", {
      type: "String",
      default: "arn:aws:acm:us-west-2:707605822527:certificate/6dd559f1-2c41-43ab-823a-ba094199fcb1",
      description: "ACM certificate ARN for the custom API domain. Must be in the same region as the API.",
    });

    const functionName = "token-query-function";

    const executionRole = new iam.Role(this, "TokenQueryFunctionRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the Token Query Lambda API.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [`arn:${this.partition}:lambda:${this.region}:${this.account}:function:token-query-pr-*`],
      }),
    );

    const logGroup = new logs.CfnLogGroup(this, "TokenQueryFunctionLogGroup", {
      logGroupName: `/aws/lambda/${functionName}`,
      retentionInDays: 14,
    });

    const serverDistPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/server/dist");
    const functionCode = lambda.Code.fromAsset(serverDistPath).bind(this);

    if (!functionCode.s3Location) {
      throw new Error("Token Query Lambda code must be packaged as an S3 asset.");
    }

    const apiFunction = new lambda.CfnFunction(this, "TokenQueryFunction", {
      functionName,
      description: "Token Query API running on AWS Lambda.",
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
          APP_ENV: "prod",
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

    const httpApi = new apigatewayv2.CfnApi(this, "TokenQueryHttpApi", {
      name: "token-query-http-api",
      protocolType: "HTTP",
      disableExecuteApiEndpoint: false,
    });

    const integration = new apigatewayv2.CfnIntegration(this, "TokenQueryFunctionIntegration", {
      apiId: httpApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: apiFunction.attrArn,
      integrationMethod: "POST",
      payloadFormatVersion: "2.0",
    });

    new apigatewayv2.CfnRoute(this, "TokenQueryRootRoute", {
      apiId: httpApi.ref,
      routeKey: "ANY /",
      target: Fn.sub("integrations/${IntegrationId}", {
        IntegrationId: integration.ref,
      }),
    });

    new apigatewayv2.CfnRoute(this, "TokenQueryProxyRoute", {
      apiId: httpApi.ref,
      routeKey: "ANY /{proxy+}",
      target: Fn.sub("integrations/${IntegrationId}", {
        IntegrationId: integration.ref,
      }),
    });

    const defaultStage = new apigatewayv2.CfnStage(this, "TokenQueryDefaultStage", {
      apiId: httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
    });

    const apiDomainName = new apigatewayv2.CfnDomainName(this, "ApiDomainName", {
      domainName: apiCustomDomainName.valueAsString,
      domainNameConfigurations: [
        {
          certificateArn: apiCertificateArn.valueAsString,
          endpointType: "REGIONAL",
          securityPolicy: "TLS_1_2",
        },
      ],
    });

    const apiMapping = new apigatewayv2.CfnApiMapping(this, "ApiCustomDomainMapping", {
      apiId: httpApi.ref,
      domainName: apiDomainName.ref,
      stage: "$default",
    });
    apiMapping.addDependency(defaultStage);

    new lambda.CfnPermission(this, "AllowHttpApiInvokeFunction", {
      action: "lambda:InvokeFunction",
      functionName: apiFunction.ref,
      principal: "apigateway.amazonaws.com",
      sourceArn: Fn.sub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*", {
        ApiId: httpApi.ref,
      }),
    });

    new CfnOutput(this, "ApiEndpoint", {
      description: "HTTP API endpoint for the Lambda API.",
      value: Fn.sub("https://${ApiId}.execute-api.${AWS::Region}.${AWS::URLSuffix}", {
        ApiId: httpApi.ref,
      }),
    });

    new CfnOutput(this, "CustomDomainUrl", {
      description: "Custom domain endpoint for the Lambda API.",
      value: Fn.sub("https://${DomainName}", {
        DomainName: apiDomainName.ref,
      }),
    });

    new CfnOutput(this, "CustomDomainRegionalDomainName", {
      description: "Regional API Gateway target for the custom domain DNS record.",
      value: apiDomainName.attrRegionalDomainName,
    });

    new CfnOutput(this, "FunctionName", {
      description: "Lambda function managed by this CDK stack.",
      value: apiFunction.ref,
    });

    new CfnOutput(this, "FunctionArn", {
      description: "Lambda function ARN managed by this CDK stack.",
      value: apiFunction.attrArn,
    });
  }
}
