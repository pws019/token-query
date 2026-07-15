import { CfnOutput, CfnParameter, Fn, Stack, type StackProps } from "aws-cdk-lib";
import { aws_ecs as ecs, aws_iam as iam, aws_logs as logs, aws_servicediscovery as servicediscovery } from "aws-cdk-lib";
import type { Construct } from "constructs";

export class GoStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const imageTag = new CfnParameter(this, "ImageTag", {
      type: "String",
      default: "latest",
      description: "ECR image tag to deploy for the Go service.",
    });

    const desiredCount = new CfnParameter(this, "DesiredCount", {
      type: "Number",
      default: 1,
      minValue: 0,
      maxValue: 2,
      description: "Desired ECS task count for the production Go service.",
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

    const ecrRepositoryUri = new CfnParameter(this, "EcrRepositoryUri", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/foundation/ecr-repository-uri",
      description: "Go service ECR repository URI exported by the foundation stack.",
    });

    const ecsClusterName = new CfnParameter(this, "EcsClusterName", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/foundation/ecs-cluster-name",
      description: "ECS cluster name exported by the foundation stack.",
    });

    const cloudMapNamespaceId = new CfnParameter(this, "CloudMapNamespaceId", {
      type: "AWS::SSM::Parameter::Value<String>",
      default: "/token-query/foundation/cloudmap-namespace-id",
      description: "Cloud Map namespace ID exported by the foundation stack.",
    });

    const privateSubnetIds = new CfnParameter(this, "PrivateSubnetIds", {
      type: "AWS::SSM::Parameter::Value<List<AWS::EC2::Subnet::Id>>",
      default: "/token-query/foundation/private-subnet-ids",
      description: "Private subnet IDs exported by the foundation stack.",
    });

    const goSecurityGroupId = new CfnParameter(this, "GoSecurityGroupId", {
      type: "AWS::SSM::Parameter::Value<AWS::EC2::SecurityGroup::Id>",
      default: "/token-query/foundation/go-security-group-id",
      description: "Go service security group exported by the foundation stack.",
    });

    const taskExecutionRole = new iam.Role(this, "GoTaskExecutionRole", {
      roleName: "token-query-go-task-execution-role",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Execution role for the Token Query Go ECS task.",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")],
    });
    taskExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [dbCredentialsSecretArn.valueAsString],
      }),
    );

    const taskRole = new iam.Role(this, "GoTaskRole", {
      roleName: "token-query-go-task-role",
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Runtime role for the Token Query Go service.",
    });

    const logGroup = new logs.CfnLogGroup(this, "GoLogGroup", {
      logGroupName: "/ecs/token-query-go",
      retentionInDays: 14,
    });

    const serviceDiscovery = new servicediscovery.CfnService(this, "GoCloudMapService", {
      name: "go",
      namespaceId: cloudMapNamespaceId.valueAsString,
      dnsConfig: {
        dnsRecords: [
          {
            ttl: 10,
            type: "A",
          },
        ],
        routingPolicy: "MULTIVALUE",
      },
      healthCheckCustomConfig: {
        failureThreshold: 1,
      },
      tags: nameTags("token-query-go-cloudmap-service"),
    });

    const taskDefinition = new ecs.CfnTaskDefinition(this, "GoTaskDefinition", {
      family: "token-query-go",
      cpu: "256",
      memory: "512",
      networkMode: "awsvpc",
      requiresCompatibilities: ["FARGATE"],
      executionRoleArn: taskExecutionRole.roleArn,
      taskRoleArn: taskRole.roleArn,
      runtimePlatform: {
        cpuArchitecture: "ARM64",
        operatingSystemFamily: "LINUX",
      },
      containerDefinitions: [
        {
          name: "token-query-go",
          image: Fn.sub("${RepositoryUri}:${Tag}", {
            RepositoryUri: ecrRepositoryUri.valueAsString,
            Tag: imageTag.valueAsString,
          }),
          essential: true,
          portMappings: [
            {
              containerPort: 8080,
              protocol: "tcp",
            },
          ],
          environment: [
            {
              name: "PORT",
              value: "8080",
            },
            {
              name: "DATABASE_HOST",
              value: dbClusterEndpoint.valueAsString,
            },
            {
              name: "DATABASE_PORT",
              value: "5432",
            },
            {
              name: "DATABASE_NAME",
              value: "postgres",
            },
            {
              name: "DATABASE_USER",
              value: "postgres",
            },
            {
              name: "DATABASE_SSLMODE",
              value: "require",
            },
          ],
          secrets: [
            {
              name: "DATABASE_PASSWORD",
              valueFrom: Fn.sub("${SecretArn}:password::", {
                SecretArn: dbCredentialsSecretArn.valueAsString,
              }),
            },
          ],
          logConfiguration: {
            logDriver: "awslogs",
            options: {
              "awslogs-group": logGroup.ref,
              "awslogs-region": this.region,
              "awslogs-stream-prefix": "go",
            },
          },
        },
      ],
      tags: nameTags("token-query-go-task"),
    });
    taskDefinition.addDependency(logGroup);

    const goService = new ecs.CfnService(this, "GoService", {
      serviceName: "token-query-go-service",
      cluster: ecsClusterName.valueAsString,
      taskDefinition: taskDefinition.ref,
      desiredCount: desiredCount.valueAsNumber,
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          assignPublicIp: "DISABLED",
          securityGroups: [goSecurityGroupId.valueAsString],
          subnets: privateSubnetIds.valueAsList,
        },
      },
      serviceRegistries: [
        {
          registryArn: serviceDiscovery.attrArn,
        },
      ],
      tags: nameTags("token-query-go-service"),
    });
    goService.addDependency(serviceDiscovery);

    new CfnOutput(this, "ServiceName", {
      value: goService.ref,
    });

    new CfnOutput(this, "TaskDefinitionArn", {
      value: taskDefinition.ref,
    });

    new CfnOutput(this, "CloudMapServiceArn", {
      value: serviceDiscovery.attrArn,
    });

    new CfnOutput(this, "InternalServiceOrigin", {
      value: "http://go.token-query.internal:8080",
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
