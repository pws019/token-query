import { CfnOutput, Fn, Stack, type StackProps } from "aws-cdk-lib";
import {
  aws_codebuild as codebuild,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_rds as rds,
  aws_secretsmanager as secretsmanager,
  aws_servicediscovery as servicediscovery,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

export class FoundationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const dbCredentialsSecret = new secretsmanager.CfnSecret(this, "DbCredentialsSecret", {
      name: "token-query/db/master",
      description: "Master credentials for the Token Query Aurora PostgreSQL cluster.",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: "postgres",
        }),
        generateStringKey: "password",
        passwordLength: 32,
        excludePunctuation: true,
        includeSpace: false,
      },
      tags: nameTags("token-query-db-master-secret"),
    });

    const vpc = new ec2.CfnVPC(this, "Vpc", {
      cidrBlock: "10.0.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: nameTags("token-query-vpc"),
    });

    const publicSubnet = new ec2.CfnSubnet(this, "PublicSubnet", {
      vpcId: vpc.ref,
      cidrBlock: "10.0.1.0/24",
      availabilityZone: Fn.select(0, Fn.getAzs()),
      mapPublicIpOnLaunch: true,
      tags: nameTags("token-query-public-01"),
    });

    const privateSubnet1 = new ec2.CfnSubnet(this, "PrivateSubnet1", {
      vpcId: vpc.ref,
      cidrBlock: "10.0.2.0/24",
      availabilityZone: Fn.select(0, Fn.getAzs()),
      mapPublicIpOnLaunch: false,
      tags: nameTags("token-query-private-01"),
    });

    const privateSubnet2 = new ec2.CfnSubnet(this, "PrivateSubnet2", {
      vpcId: vpc.ref,
      cidrBlock: "10.0.3.0/24",
      availabilityZone: Fn.select(1, Fn.getAzs()),
      mapPublicIpOnLaunch: false,
      tags: nameTags("token-query-private-02"),
    });

    const privateSubnet3 = new ec2.CfnSubnet(this, "PrivateSubnet3", {
      vpcId: vpc.ref,
      cidrBlock: "10.0.4.0/24",
      availabilityZone: Fn.select(2, Fn.getAzs()),
      mapPublicIpOnLaunch: false,
      tags: nameTags("token-query-private-03"),
    });

    const internetGateway = new ec2.CfnInternetGateway(this, "InternetGateway", {
      tags: nameTags("token-query-igw"),
    });

    const internetGatewayAttachment = new ec2.CfnVPCGatewayAttachment(this, "InternetGatewayAttachment", {
      vpcId: vpc.ref,
      internetGatewayId: internetGateway.ref,
    });

    const natEip = new ec2.CfnEIP(this, "NatEip", {
      domain: "vpc",
      tags: nameTags("token-query-nat-eip"),
    });

    const natGateway = new ec2.CfnNatGateway(this, "NatGateway", {
      allocationId: natEip.attrAllocationId,
      subnetId: publicSubnet.ref,
      tags: nameTags("token-query-nat-gateway"),
    });
    natGateway.addDependency(internetGatewayAttachment);

    const publicRouteTable = new ec2.CfnRouteTable(this, "PublicRouteTable", {
      vpcId: vpc.ref,
      tags: nameTags("token-query-public-rt"),
    });

    const privateRouteTable = new ec2.CfnRouteTable(this, "PrivateRouteTable", {
      vpcId: vpc.ref,
      tags: nameTags("token-query-private-rt"),
    });

    const publicDefaultRoute = new ec2.CfnRoute(this, "PublicDefaultRoute", {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: internetGateway.ref,
    });
    publicDefaultRoute.addDependency(internetGatewayAttachment);

    new ec2.CfnRoute(this, "PrivateDefaultRoute", {
      routeTableId: privateRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      natGatewayId: natGateway.ref,
    });

    new ec2.CfnSubnetRouteTableAssociation(this, "PublicSubnetRouteTableAssociation", {
      subnetId: publicSubnet.ref,
      routeTableId: publicRouteTable.ref,
    });

    for (const [index, subnet] of [privateSubnet1, privateSubnet2, privateSubnet3].entries()) {
      new ec2.CfnSubnetRouteTableAssociation(this, `PrivateSubnet${index + 1}RouteTableAssociation`, {
        subnetId: subnet.ref,
        routeTableId: privateRouteTable.ref,
      });
    }

    const lambdaSecurityGroup = new ec2.CfnSecurityGroup(this, "LambdaSecurityGroup", {
      groupDescription: "Security group for Token Query Lambda functions.",
      groupName: "token-query-lambda-sg",
      vpcId: vpc.ref,
      securityGroupEgress: [
        {
          cidrIp: "0.0.0.0/0",
          ipProtocol: "-1",
          description: "Allow all outbound traffic.",
        },
      ],
      tags: nameTags("token-query-lambda-sg"),
    });

    const dbSecurityGroup = new ec2.CfnSecurityGroup(this, "DbSecurityGroup", {
      groupDescription: "Security group for Token Query Aurora PostgreSQL.",
      groupName: "token-query-db-sg",
      vpcId: vpc.ref,
      securityGroupEgress: [
        {
          cidrIp: "0.0.0.0/0",
          ipProtocol: "-1",
          description: "Allow all outbound traffic.",
        },
      ],
      tags: nameTags("token-query-db-sg"),
    });

    const goSecurityGroup = new ec2.CfnSecurityGroup(this, "GoSecurityGroup", {
      groupDescription: "Security group for Token Query Go services on ECS/Fargate.",
      groupName: "token-query-go-sg",
      vpcId: vpc.ref,
      securityGroupEgress: [
        {
          cidrIp: "0.0.0.0/0",
          ipProtocol: "-1",
          description: "Allow all outbound traffic.",
        },
      ],
      tags: nameTags("token-query-go-sg"),
    });

    const migrationSecurityGroup = new ec2.CfnSecurityGroup(this, "MigrationSecurityGroup", {
      groupDescription: "Security group for Token Query database migration CodeBuild jobs.",
      groupName: "token-query-migration-sg",
      vpcId: vpc.ref,
      securityGroupEgress: [
        {
          cidrIp: "0.0.0.0/0",
          ipProtocol: "-1",
          description: "Allow all outbound traffic.",
        },
      ],
      tags: nameTags("token-query-migration-sg"),
    });

    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromLambda", {
      groupId: dbSecurityGroup.attrGroupId,
      sourceSecurityGroupId: lambdaSecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "PostgreSQL from Token Query Lambda functions.",
    });

    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromGo", {
      groupId: dbSecurityGroup.attrGroupId,
      sourceSecurityGroupId: goSecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "PostgreSQL from Token Query Go services.",
    });

    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromMigration", {
      groupId: dbSecurityGroup.attrGroupId,
      sourceSecurityGroupId: migrationSecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "PostgreSQL from Token Query database migration CodeBuild jobs.",
    });

    new ec2.CfnSecurityGroupIngress(this, "GoIngressFromLambda", {
      groupId: goSecurityGroup.attrGroupId,
      sourceSecurityGroupId: lambdaSecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 8080,
      toPort: 8080,
      description: "HTTP from Token Query Lambda functions.",
    });

    const privateSubnetIds = [privateSubnet1.ref, privateSubnet2.ref, privateSubnet3.ref];

    const goRepository = new ecr.CfnRepository(this, "GoRepository", {
      repositoryName: "token-query-go",
      imageScanningConfiguration: {
        scanOnPush: true,
      },
      imageTagMutability: "MUTABLE",
      encryptionConfiguration: {
        encryptionType: "AES256",
      },
      lifecyclePolicy: {
        lifecyclePolicyText: JSON.stringify({
          rules: [
            {
              rulePriority: 1,
              description: "Keep recent Go service images and expire older untagged images.",
              selection: {
                tagStatus: "untagged",
                countType: "sinceImagePushed",
                countUnit: "days",
                countNumber: 7,
              },
              action: {
                type: "expire",
              },
            },
          ],
        }),
      },
      tags: nameTags("token-query-go"),
    });

    const ecsCluster = new ecs.CfnCluster(this, "EcsCluster", {
      clusterName: "token-query-cluster",
      tags: nameTags("token-query-cluster"),
    });

    const cloudMapNamespace = new servicediscovery.CfnPrivateDnsNamespace(this, "CloudMapNamespace", {
      name: "token-query.internal",
      vpc: vpc.ref,
      description: "Private service discovery namespace for Token Query services.",
      tags: nameTags("token-query-internal-namespace"),
    });

    const goCodeBuildRole = new iam.Role(this, "GoCodeBuildRole", {
      roleName: "token-query-go-codebuild-role",
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "Service role used by CodeBuild to build and push the Token Query Go image.",
    });
    goCodeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          Fn.sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/token-query-go-build"),
          Fn.sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/token-query-go-build:*"),
        ],
      }),
    );
    goCodeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken", "sts:GetCallerIdentity"],
        resources: ["*"],
      }),
    );
    goCodeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:DescribeRepositories",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ],
        resources: [goRepository.attrArn],
      }),
    );

    const goCodeBuildProject = new codebuild.CfnProject(this, "GoCodeBuildProject", {
      name: "token-query-go-build",
      description: "Builds and pushes the Token Query Go service image to ECR.",
      serviceRole: goCodeBuildRole.roleArn,
      source: {
        type: "GITHUB",
        location: "https://github.com/pws019/token-query.git",
        buildSpec: "infra/codebuild/go-buildspec.yml",
        gitCloneDepth: 1,
      },
      artifacts: {
        type: "NO_ARTIFACTS",
      },
      environment: {
        type: "ARM_CONTAINER",
        image: "aws/codebuild/amazonlinux-aarch64-standard:4.0",
        computeType: "BUILD_GENERAL1_SMALL",
        privilegedMode: true,
        environmentVariables: [
          {
            name: "AWS_REGION",
            type: "PLAINTEXT",
            value: this.region,
          },
          {
            name: "ECR_REPOSITORY",
            type: "PLAINTEXT",
            value: goRepository.ref,
          },
          {
            name: "ECR_REPOSITORY_URI",
            type: "PLAINTEXT",
            value: goRepository.attrRepositoryUri,
          },
        ],
      },
      logsConfig: {
        cloudWatchLogs: {
          status: "ENABLED",
          groupName: "/aws/codebuild/token-query-go-build",
        },
      },
      queuedTimeoutInMinutes: 30,
      timeoutInMinutes: 30,
      tags: nameTags("token-query-go-build"),
    });

    const dbSubnetGroup = new rds.CfnDBSubnetGroup(this, "DbSubnetGroup", {
      dbSubnetGroupDescription: "token-query-db-subnet-group",
      subnetIds: privateSubnetIds,
    });

    const dbCluster = new rds.CfnDBCluster(this, "DbCluster", {
      dbClusterIdentifier: "token-query-db",
      engine: "aurora-postgresql",
      engineVersion: "17.7",
      masterUsername: "postgres",
      masterUserPassword: Fn.sub("{{resolve:secretsmanager:${SecretId}:SecretString:password}}", {
        SecretId: dbCredentialsSecret.ref,
      }),
      dbSubnetGroupName: dbSubnetGroup.ref,
      vpcSecurityGroupIds: [dbSecurityGroup.attrGroupId],
      backupRetentionPeriod: 7,
      copyTagsToSnapshot: true,
      deletionProtection: false,
      preferredBackupWindow: "08:51-09:21",
      preferredMaintenanceWindow: "fri:11:01-fri:11:31",
      serverlessV2ScalingConfiguration: {
        minCapacity: 0.5,
        maxCapacity: 2,
      },
      storageEncrypted: true,
      tags: [
        {
          key: "Project",
          value: "token-query",
        },
      ],
    });
    dbCluster.addDependency(dbCredentialsSecret);

    new secretsmanager.CfnSecretTargetAttachment(this, "DbCredentialsSecretAttachment", {
      secretId: dbCredentialsSecret.ref,
      targetId: dbCluster.ref,
      targetType: "AWS::RDS::DBCluster",
    });

    const dbInstance = new rds.CfnDBInstance(this, "DbInstance", {
      dbInstanceIdentifier: "token-query-db-instance-1",
      dbClusterIdentifier: dbCluster.ref,
      dbInstanceClass: "db.serverless",
      engine: "aurora-postgresql",
      publiclyAccessible: false,
      autoMinorVersionUpgrade: true,
      tags: [
        {
          key: "Project",
          value: "token-query",
        },
      ],
    });
    dbInstance.addDependency(dbCluster);

    const dbMigrationCodeBuildRole = new iam.Role(this, "DbMigrationCodeBuildRole", {
      roleName: "token-query-db-migrate-codebuild-role",
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      description: "Service role used by CodeBuild to run Token Query database migrations inside the VPC.",
    });

    const dbMigrationLogsPolicy = new iam.Policy(this, "DbMigrationCodeBuildLogsPolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents",
          ],
          resources: [
            Fn.sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/token-query-db-migrate"),
            Fn.sub("arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/token-query-db-migrate:*"),
          ],
        }),
      ],
    });
    dbMigrationLogsPolicy.attachToRole(dbMigrationCodeBuildRole);

    const dbMigrationParametersPolicy = new iam.Policy(this, "DbMigrationCodeBuildParametersPolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: ["ssm:GetParameter", "ssm:GetParameters"],
          resources: [Fn.sub("arn:${AWS::Partition}:ssm:${AWS::Region}:${AWS::AccountId}:parameter/token-query/foundation/*")],
        }),
      ],
    });
    dbMigrationParametersPolicy.attachToRole(dbMigrationCodeBuildRole);

    const dbMigrationSecretsPolicy = new iam.Policy(this, "DbMigrationCodeBuildSecretsPolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [dbCredentialsSecret.ref],
        }),
      ],
    });
    dbMigrationSecretsPolicy.attachToRole(dbMigrationCodeBuildRole);

    const dbMigrationVpcPolicy = new iam.Policy(this, "DbMigrationCodeBuildVpcPolicy", {
      statements: [
        new iam.PolicyStatement({
          actions: [
            "ec2:CreateNetworkInterface",
            "ec2:CreateNetworkInterfacePermission",
            "ec2:DeleteNetworkInterface",
            "ec2:DescribeDhcpOptions",
            "ec2:DescribeNetworkInterfaces",
            "ec2:DescribeSecurityGroups",
            "ec2:DescribeSubnets",
            "ec2:DescribeVpcs",
          ],
          resources: ["*"],
        }),
      ],
    });
    dbMigrationVpcPolicy.attachToRole(dbMigrationCodeBuildRole);

    const dbMigrationCodeBuildProject = new codebuild.CfnProject(this, "DbMigrationCodeBuildProject", {
      name: "token-query-db-migrate",
      description: "Runs Token Query database migration commands inside the VPC.",
      serviceRole: dbMigrationCodeBuildRole.roleArn,
      source: {
        type: "GITHUB",
        location: "https://github.com/pws019/token-query.git",
        buildSpec: "infra/codebuild/db-migrate-buildspec.yml",
        gitCloneDepth: 1,
      },
      artifacts: {
        type: "NO_ARTIFACTS",
      },
      environment: {
        type: "LINUX_CONTAINER",
        image: "aws/codebuild/amazonlinux-x86_64-standard:6.0",
        computeType: "BUILD_GENERAL1_SMALL",
        privilegedMode: false,
        environmentVariables: [
          {
            name: "AWS_REGION",
            type: "PLAINTEXT",
            value: this.region,
          },
          {
            name: "DB_CLUSTER_ENDPOINT",
            type: "PLAINTEXT",
            value: dbCluster.attrEndpointAddress,
          },
          {
            name: "DB_CREDENTIALS_SECRET_ARN",
            type: "PLAINTEXT",
            value: dbCredentialsSecret.ref,
          },
        ],
      },
      vpcConfig: {
        vpcId: vpc.ref,
        subnets: privateSubnetIds,
        securityGroupIds: [migrationSecurityGroup.attrGroupId],
      },
      logsConfig: {
        cloudWatchLogs: {
          status: "ENABLED",
          groupName: "/aws/codebuild/token-query-db-migrate",
        },
      },
      queuedTimeoutInMinutes: 30,
      timeoutInMinutes: 30,
      tags: nameTags("token-query-db-migrate"),
    });
    dbMigrationCodeBuildProject.node.addDependency(dbMigrationLogsPolicy);
    dbMigrationCodeBuildProject.node.addDependency(dbMigrationParametersPolicy);
    dbMigrationCodeBuildProject.node.addDependency(dbMigrationSecretsPolicy);
    dbMigrationCodeBuildProject.node.addDependency(dbMigrationVpcPolicy);

    new ssm.StringParameter(this, "VpcIdParam", {
      parameterName: "/token-query/foundation/vpc-id",
      stringValue: vpc.ref,
    });

    new ssm.StringListParameter(this, "PrivateSubnetIdsParam", {
      parameterName: "/token-query/foundation/private-subnet-ids",
      stringListValue: privateSubnetIds,
    });

    new ssm.StringParameter(this, "LambdaSecurityGroupIdParam", {
      parameterName: "/token-query/foundation/lambda-security-group-id",
      stringValue: lambdaSecurityGroup.attrGroupId,
    });

    new ssm.StringParameter(this, "DbClusterEndpointParam", {
      parameterName: "/token-query/foundation/db-cluster-endpoint",
      stringValue: dbCluster.attrEndpointAddress,
    });

    new ssm.StringParameter(this, "DbCredentialsSecretArnParam", {
      parameterName: "/token-query/foundation/db-credentials-secret-arn",
      stringValue: dbCredentialsSecret.ref,
    });

    new ssm.StringParameter(this, "DbSecurityGroupIdParam", {
      parameterName: "/token-query/foundation/db-security-group-id",
      stringValue: dbSecurityGroup.attrGroupId,
    });

    new ssm.StringParameter(this, "GoSecurityGroupIdParam", {
      parameterName: "/token-query/foundation/go-security-group-id",
      stringValue: goSecurityGroup.attrGroupId,
    });

    new ssm.StringParameter(this, "MigrationSecurityGroupIdParam", {
      parameterName: "/token-query/foundation/migration-security-group-id",
      stringValue: migrationSecurityGroup.attrGroupId,
    });

    new ssm.StringParameter(this, "EcrRepositoryNameParam", {
      parameterName: "/token-query/foundation/ecr-repository-name",
      stringValue: goRepository.ref,
    });

    new ssm.StringParameter(this, "EcrRepositoryUriParam", {
      parameterName: "/token-query/foundation/ecr-repository-uri",
      stringValue: goRepository.attrRepositoryUri,
    });

    new ssm.StringParameter(this, "EcsClusterNameParam", {
      parameterName: "/token-query/foundation/ecs-cluster-name",
      stringValue: ecsCluster.ref,
    });

    new ssm.StringParameter(this, "CloudMapNamespaceIdParam", {
      parameterName: "/token-query/foundation/cloudmap-namespace-id",
      stringValue: cloudMapNamespace.attrId,
    });

    new ssm.StringParameter(this, "CloudMapNamespaceNameParam", {
      parameterName: "/token-query/foundation/cloudmap-namespace-name",
      stringValue: "token-query.internal",
    });

    new ssm.StringParameter(this, "GoCodeBuildProjectNameParam", {
      parameterName: "/token-query/foundation/go-codebuild-project-name",
      stringValue: goCodeBuildProject.ref,
    });

    new ssm.StringParameter(this, "DbMigrationCodeBuildProjectNameParam", {
      parameterName: "/token-query/foundation/db-migration-codebuild-project-name",
      stringValue: dbMigrationCodeBuildProject.ref,
    });

    new CfnOutput(this, "VpcId", {
      value: vpc.ref,
    });

    new CfnOutput(this, "PrivateSubnetIds", {
      value: Fn.join(",", privateSubnetIds),
    });

    new CfnOutput(this, "LambdaSecurityGroupId", {
      value: lambdaSecurityGroup.attrGroupId,
    });

    new CfnOutput(this, "DbClusterEndpoint", {
      value: dbCluster.attrEndpointAddress,
    });

    new CfnOutput(this, "DbCredentialsSecretArn", {
      value: dbCredentialsSecret.ref,
    });

    new CfnOutput(this, "DbSecurityGroupId", {
      value: dbSecurityGroup.attrGroupId,
    });

    new CfnOutput(this, "GoSecurityGroupId", {
      value: goSecurityGroup.attrGroupId,
    });

    new CfnOutput(this, "MigrationSecurityGroupId", {
      value: migrationSecurityGroup.attrGroupId,
    });

    new CfnOutput(this, "EcrRepositoryName", {
      value: goRepository.ref,
    });

    new CfnOutput(this, "EcrRepositoryUri", {
      value: goRepository.attrRepositoryUri,
    });

    new CfnOutput(this, "EcsClusterName", {
      value: ecsCluster.ref,
    });

    new CfnOutput(this, "CloudMapNamespaceId", {
      value: cloudMapNamespace.attrId,
    });

    new CfnOutput(this, "CloudMapNamespaceName", {
      value: "token-query.internal",
    });

    new CfnOutput(this, "GoCodeBuildProjectName", {
      value: goCodeBuildProject.ref,
    });

    new CfnOutput(this, "DbMigrationCodeBuildProjectName", {
      value: dbMigrationCodeBuildProject.ref,
    });
  }
}

function nameTags(name: string) {
  return [
    {
      key: "Name",
      value: name,
    },
    {
      key: "Project",
      value: "token-query",
    },
  ];
}
