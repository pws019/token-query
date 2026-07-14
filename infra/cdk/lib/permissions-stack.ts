import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
import { aws_iam as iam, aws_ssm as ssm } from "aws-cdk-lib";
import type { Construct } from "constructs";

export class PermissionsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const githubProvider = new iam.CfnOIDCProvider(this, "GitHubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIdList: ["sts.amazonaws.com"],
    });

    const deployRole = new iam.Role(this, "GitHubActionsDeployRole", {
      roleName: "token-query-github-actions-deploy-role",
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.attrArn, {
        StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        },
        StringLike: {
          "token.actions.githubusercontent.com:sub": "repo:pws019/token-query:*",
        },
      }),
      description: "Deploy role assumed by GitHub Actions through OIDC for Token Query.",
    });

    const lambdaExecutionRole = new iam.Role(this, "LambdaExecutionRole", {
      roleName: "token-query-lambda-execution-role",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Runtime role used by Token Query Lambda functions.",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaVPCAccessExecutionRole"),
      ],
    });

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${this.account}:role/cdk-*`],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageTokenQueryCloudFormationStacks",
        actions: [
          "cloudformation:CreateChangeSet",
          "cloudformation:CreateStack",
          "cloudformation:DeleteChangeSet",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeChangeSet",
          "cloudformation:DescribeStackEvents",
          "cloudformation:DescribeStackResource",
          "cloudformation:DescribeStackResources",
          "cloudformation:DescribeStacks",
          "cloudformation:ExecuteChangeSet",
          "cloudformation:GetTemplate",
          "cloudformation:GetTemplateSummary",
          "cloudformation:UpdateStack",
          "cloudformation:ValidateTemplate",
        ],
        resources: [
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/token-query-foundation/*`,
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/token-query-api/*`,
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/token-query-preview-api*/*`,
          `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stack/CDKToolkit/*`,
        ],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PublishCdkAssets",
        actions: [
          "s3:AbortMultipartUpload",
          "s3:DeleteObject",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:PutObject",
        ],
        resources: [
          `arn:${this.partition}:s3:::cdk-*-${this.account}-${this.region}`,
          `arn:${this.partition}:s3:::cdk-*-${this.account}-${this.region}/*`,
        ],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageFoundationResources",
        actions: [
          "ec2:AllocateAddress",
          "ec2:AssociateRouteTable",
          "ec2:AttachInternetGateway",
          "ec2:AuthorizeSecurityGroupEgress",
          "ec2:AuthorizeSecurityGroupIngress",
          "ec2:CreateInternetGateway",
          "ec2:CreateNatGateway",
          "ec2:CreateRoute",
          "ec2:CreateRouteTable",
          "ec2:CreateSecurityGroup",
          "ec2:CreateSubnet",
          "ec2:CreateTags",
          "ec2:CreateVpc",
          "ec2:DeleteInternetGateway",
          "ec2:DeleteNatGateway",
          "ec2:DeleteRoute",
          "ec2:DeleteRouteTable",
          "ec2:DeleteSecurityGroup",
          "ec2:DeleteSubnet",
          "ec2:DeleteTags",
          "ec2:DeleteVpc",
          "ec2:Describe*",
          "ec2:DetachInternetGateway",
          "ec2:DisassociateRouteTable",
          "ec2:ModifySubnetAttribute",
          "ec2:ModifyVpcAttribute",
          "ec2:ReleaseAddress",
          "ec2:RevokeSecurityGroupEgress",
          "ec2:RevokeSecurityGroupIngress",
          "rds:AddTagsToResource",
          "rds:CreateDBCluster",
          "rds:CreateDBInstance",
          "rds:CreateDBSubnetGroup",
          "rds:DeleteDBCluster",
          "rds:DeleteDBInstance",
          "rds:DeleteDBSubnetGroup",
          "rds:Describe*",
          "rds:ModifyDBCluster",
          "rds:ModifyDBInstance",
          "rds:ModifyDBSubnetGroup",
          "rds:RemoveTagsFromResource",
        ],
        resources: ["*"],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageApplicationResources",
        actions: [
          "apigateway:DELETE",
          "apigateway:GET",
          "apigateway:PATCH",
          "apigateway:POST",
          "apigateway:PUT",
          "apigateway:TagResource",
          "apigateway:UntagResource",
          "lambda:AddPermission",
          "lambda:CreateFunction",
          "lambda:DeleteFunction",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:RemovePermission",
          "lambda:TagResource",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "logs:CreateLogGroup",
          "logs:DeleteLogGroup",
          "logs:DescribeLogGroups",
          "logs:PutRetentionPolicy",
          "logs:TagResource",
        ],
        resources: ["*"],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageTokenQueryParameters",
        actions: [
          "ssm:AddTagsToResource",
          "ssm:DeleteParameter",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:PutParameter",
        ],
        resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/token-query/*`],
      }),
    );

    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassTokenQueryRuntimeRoles",
        actions: ["iam:PassRole"],
        resources: [lambdaExecutionRole.roleArn],
        conditions: {
          StringEquals: {
            "iam:PassedToService": "lambda.amazonaws.com",
          },
        },
      }),
    );

    new ssm.StringParameter(this, "GitHubActionsDeployRoleArnParam", {
      parameterName: "/token-query/permissions/github-actions-deploy-role-arn",
      stringValue: deployRole.roleArn,
    });

    new ssm.StringParameter(this, "LambdaExecutionRoleArnParam", {
      parameterName: "/token-query/permissions/lambda-execution-role-arn",
      stringValue: lambdaExecutionRole.roleArn,
    });

    new CfnOutput(this, "GitHubActionsDeployRoleArn", {
      value: deployRole.roleArn,
    });

    new CfnOutput(this, "LambdaExecutionRoleArn", {
      value: lambdaExecutionRole.roleArn,
    });
  }
}
