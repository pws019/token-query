# IAM 角色与权限清单

本项目部署链路涉及两个 IAM 角色，**都是 AWS 账号里的资源，不是 GitHub 上配置的东西**——GitHub 那边只需要在 Secrets 里存一个角色 ARN（`AWS_DEPLOY_ROLE_ARN`，见 [DEPLOYMENT.md](DEPLOYMENT.md) 第一节），实际的角色定义、信任关系、权限策略都在 AWS IAM 里维护。

```
GitHub Actions (OIDC)
        │  assume role
        ▼
github-actions-token-query-deploy-role   ← 部署角色：跑 sam/cloudformation 命令的身份
        │  iam:PassRole
        ▼
token-query-function-role-qsx6aji9       ← Lambda 执行角色：Lambda 函数运行时的身份
```

两个角色职责完全不同，不要混：**部署角色**是"CI 用来调用 AWS API 建资源"的身份；**执行角色**是"Lambda 函数运行起来之后，代码本身访问其他 AWS 服务（如果有）"的身份。

---

## 一、GitHub OIDC Provider（一次性账号级配置）

让 GitHub Actions 免密钥（不存 AK/SK）assume AWS 角色的前提，整个账号只需要建一次：

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 22ff89586561fc2d52f77491e9f1eff1b80be33e
```

> Thumbprint 是 GitHub OIDC 服务器证书链的指纹，AWS 控制台创建 Provider 时会自动帮你抓取正确值；也可以用 `openssl` 现查最新的，不建议长期硬编码在文档里（证书轮换会变）。

> 当前账号里已存在：`arn:aws:iam::707605822527:oidc-provider/token.actions.githubusercontent.com`

---

## 二、`github-actions-token-query-deploy-role`（部署角色）

### 信任策略（谁能 assume 这个角色）

只允许 `pws019/token-query` 这个仓库的 GitHub Actions 通过 OIDC 换取临时凭证：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::707605822527:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:pws019/token-query:*"
          ]
        }
      }
    }
  ]
}
```

创建角色的命令：

```bash
cat > trust-policy.json <<'EOF'
{ ... 上面这段 JSON ... }
EOF

aws iam create-role \
  --role-name github-actions-token-query-deploy-role \
  --assume-role-policy-document file://trust-policy.json
```

### 挂载的 inline policy（按创建顺序，共 8 份）

这些权限是**边部署边踩坑边补出来的**，不是一次性设计完美的——保留分成多份小文件的历史，方便追溯"哪次报错对应补了哪条权限"。新环境从零搭建时，建议直接按下面的最终清单一次性配置，不用重复踩坑。

| 文件 | 解决的问题 |
|---|---|
| `token-query-lambda-deploy-policy` | 更新已存在的 `token-query-function` 代码/配置 |
| `token-query-sam-deploy-policy` | SAM 部署主体权限：CFN stack 管理、S3 托管 bucket、Lambda（`token-query-api-*` 前缀）、API Gateway、IAM 执行角色（`token-query-api-*` 前缀）、日志组、VPC 只读 |
| `token-query-sam-deploy-policy-patch` | 补 S3 bucket 的 PublicAccessBlock/BucketPolicy/Delete 权限；补 `token-query-function` 这个具体函数名的 AddPermission/RemovePermission/TagResource；补对应日志组权限 |
| `token-query-sam-deploy-policy-patch2` | 补 `cloudformation:GetTemplateSummary`（SAM 模板含 Transform 时必须） |
| `token-query-sam-deploy-policy-patch3` | 补 `iam:PassRole`（部署角色要把 Lambda 执行角色"传"给 Lambda 服务） |
| `token-query-sam-deploy-policy-patch4` | 补读取 `/token-query/network/*` SSM 参数的权限 |
| `token-query-sam-deploy-policy-patch5` | 补读取 `/token-query/db/*` SSM 参数的权限 |
| `token-query-sam-deploy-policy-patch6` | 补 `token-query-function` 这个具体函数名的 `CreateFunction`/`DeleteFunction`（从零创建/彻底删除 stack 时才会用到，import 场景不需要） |
| `token-query-sam-deploy-policy-patch7` | 补 `apigateway:TagResource`/`UntagResource`（打标签是独立 action，不归 GET/POST/PUT/PATCH/DELETE 管）；补 `token-query-function` 日志组的 `logs:DeleteLogGroup`（之前只补了 Create/PutRetentionPolicy/TagResource，漏了 Delete） |

完整策略内容和一次性创建命令：

```bash
mkdir -p /tmp/iam-policies

cat > /tmp/iam-policies/lambda-deploy-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "UpdateTokenQueryLambdaCode",
      "Effect": "Allow",
      "Action": [
        "lambda:UpdateFunctionCode",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionConfiguration"
      ],
      "Resource": "arn:aws:lambda:us-west-2:707605822527:function:token-query-function"
    },
    {
      "Sid": "ReadLambdaDeploymentStatus",
      "Effect": "Allow",
      "Action": ["lambda:GetAccountSettings"],
      "Resource": "*"
    }
  ]
}
EOF

cat > /tmp/iam-policies/sam-deploy-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManageSamCloudFormationStacks",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateChangeSet",
        "cloudformation:CreateStack",
        "cloudformation:DeleteChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResource",
        "cloudformation:DescribeStackResources",
        "cloudformation:DescribeStacks",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:UpdateStack",
        "cloudformation:ValidateTemplate"
      ],
      "Resource": [
        "arn:aws:cloudformation:us-west-2:707605822527:stack/token-query-api/*",
        "arn:aws:cloudformation:us-west-2:707605822527:stack/aws-sam-cli-managed-default/*",
        "arn:aws:cloudformation:us-west-2:aws:transform/Serverless-2016-10-31"
      ]
    },
    {
      "Sid": "ManageSamArtifactsBucket",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:DeleteBucketPolicy",
        "s3:DeleteObject",
        "s3:GetBucketLocation",
        "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketVersioning",
        "s3:GetEncryptionConfiguration",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:PutBucketPolicy",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketTagging",
        "s3:PutBucketVersioning",
        "s3:PutEncryptionConfiguration",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::aws-sam-cli-managed-default-*",
        "arn:aws:s3:::aws-sam-cli-managed-default-*/*"
      ]
    },
    {
      "Sid": "ManageSamLambdaFunctions",
      "Effect": "Allow",
      "Action": [
        "lambda:AddPermission",
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:RemovePermission",
        "lambda:TagResource",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration"
      ],
      "Resource": [
        "arn:aws:lambda:us-west-2:707605822527:function:token-query-api-*",
        "arn:aws:lambda:us-west-2:707605822527:function:token-query-function"
      ]
    },
    {
      "Sid": "ManageSamHttpApi",
      "Effect": "Allow",
      "Action": ["apigateway:DELETE", "apigateway:GET", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT", "apigateway:TagResource", "apigateway:UntagResource"],
      "Resource": "arn:aws:apigateway:us-west-2::/*"
    },
    {
      "Sid": "ManageSamExecutionRole",
      "Effect": "Allow",
      "Action": ["iam:AttachRolePolicy", "iam:CreateRole", "iam:DeleteRole", "iam:DetachRolePolicy", "iam:GetRole", "iam:PassRole", "iam:TagRole"],
      "Resource": "arn:aws:iam::707605822527:role/token-query-api-*"
    },
    {
      "Sid": "PassTokenQueryFunctionExecutionRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::707605822527:role/service-role/token-query-function-role-qsx6aji9",
      "Condition": { "StringEquals": { "iam:PassedToService": "lambda.amazonaws.com" } }
    },
    {
      "Sid": "ManageSamLogGroups",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DescribeLogGroups", "logs:PutRetentionPolicy", "logs:TagResource"],
      "Resource": [
        "arn:aws:logs:us-west-2:707605822527:log-group:/aws/lambda/token-query-api-*",
        "arn:aws:logs:us-west-2:707605822527:log-group:/aws/lambda/token-query-function",
        "arn:aws:logs:us-west-2:707605822527:log-group:/aws/lambda/token-query-function:*"
      ]
    },
    {
      "Sid": "ReadVpcConfiguration",
      "Effect": "Allow",
      "Action": ["ec2:DescribeSecurityGroups", "ec2:DescribeSubnets", "ec2:DescribeVpcs"],
      "Resource": "*"
    },
    {
      "Sid": "ReadNetworkAndDbSsmParameters",
      "Effect": "Allow",
      "Action": ["ssm:GetParameters", "ssm:GetParameter"],
      "Resource": [
        "arn:aws:ssm:us-west-2:707605822527:parameter/token-query/network/*",
        "arn:aws:ssm:us-west-2:707605822527:parameter/token-query/db/*"
      ]
    }
  ]
}
EOF

aws iam put-role-policy --role-name github-actions-token-query-deploy-role \
  --policy-name token-query-lambda-deploy-policy \
  --policy-document file:///tmp/iam-policies/lambda-deploy-policy.json

aws iam put-role-policy --role-name github-actions-token-query-deploy-role \
  --policy-name token-query-sam-deploy-policy \
  --policy-document file:///tmp/iam-policies/sam-deploy-policy.json
```

> 上面把原来分散的 8 份 patch 合并整理成了 2 份等价内容（`sam-deploy-policy` 已经把 patch1~6 的内容全部并进去了）。如果是在**已有账号**上操作，直接照当前实际状态（8 份分开的 policy）走就行，不用合并；这里合并只是方便**全新账号**一次性配置到位。

---

## 三、`token-query-function-role-qsx6aji9`（Lambda 执行角色）

### 信任策略（谁能 assume 这个角色）

只允许 Lambda 服务本身：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

### 挂载的托管策略（2 个，AWS 官方策略，不是自定义的）

| 策略名 | 作用 |
|---|---|
| `AWSLambdaBasicExecutionRole`（或同名的账号内自定义版本） | 写 CloudWatch Logs 的基本权限 |
| `AWSLambdaVPCAccessExecutionRole` | 在 VPC 里创建/删除 ENI，让 Lambda 能连進私有子网（连 Aurora 必需） |

创建 + 挂载命令：

```bash
cat > /tmp/iam-policies/lambda-trust-policy.json <<'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "lambda.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role \
  --path /service-role/ \
  --role-name token-query-function-role \
  --assume-role-policy-document file:///tmp/iam-policies/lambda-trust-policy.json

aws iam attach-role-policy \
  --role-name token-query-function-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

aws iam attach-role-policy \
  --role-name token-query-function-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole
```

创建好之后，把这个角色的 ARN 填进 GitHub Variables 的 `LAMBDA_EXECUTION_ROLE_ARN`（见 [DEPLOYMENT.md](DEPLOYMENT.md)）。

这个角色**不由任何 CloudFormation stack 管理**，`infra/template.yaml` 只是通过 `LambdaExecutionRoleArn` 参数引用它的 ARN——增删改都要手动用上面这类命令操作。

---

## 四、快速核对当前配置（诊断用）

```bash
# 部署角色信任策略 + inline policy 列表
aws iam get-role --role-name github-actions-token-query-deploy-role --query 'Role.AssumeRolePolicyDocument'
aws iam list-role-policies --role-name github-actions-token-query-deploy-role

# 看某一条 policy 的具体内容
aws iam get-role-policy --role-name github-actions-token-query-deploy-role --policy-name <policy-name>

# Lambda 执行角色挂了哪些策略
aws iam list-attached-role-policies --role-name token-query-function-role-qsx6aji9
```
