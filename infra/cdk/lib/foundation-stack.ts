import { CfnOutput, Fn, Stack, type StackProps } from "aws-cdk-lib";
import { aws_ec2 as ec2, aws_rds as rds, aws_secretsmanager as secretsmanager, aws_ssm as ssm } from "aws-cdk-lib";
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

    new ec2.CfnSecurityGroupIngress(this, "DbIngressFromLambda", {
      groupId: dbSecurityGroup.attrGroupId,
      sourceSecurityGroupId: lambdaSecurityGroup.attrGroupId,
      ipProtocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      description: "PostgreSQL from Token Query Lambda functions.",
    });

    const privateSubnetIds = [privateSubnet1.ref, privateSubnet2.ref, privateSubnet3.ref];

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
