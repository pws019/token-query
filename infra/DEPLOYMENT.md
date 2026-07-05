# Token Query AWS 部署手册

本项目的 AWS 基础设施分成三层独立的 CloudFormation stack，依赖关系是单向的：

```
token-query-network  (VPC / 子网 / 路由 / NAT / Lambda 安全组)
        │  发布 SSM 参数
        ▼
token-query-db       (DB 安全组 / DBSubnetGroup / Aurora Cluster+Instance)
        │  发布 SSM 参数
        ▼
token-query-api      (Lambda / HTTP API / 自定义域名)  ← 唯一接入 GitHub Actions 自动部署的一层
```

- `network` 和 `db` **只手动部署**，不接入任何自动触发的 CI 流水线（这两层改动少、改错代价大）。
- `api` 层由 `.github/workflows/deploy-lambda-api.yml` 自动部署，push 到 `main` 分支或手动 `workflow_dispatch` 都会触发。
- 三层之间不用手填 ID 传参——上层通过 CloudFormation 的 `AWS::SSM::Parameter::Value<...>` 类型，在**每次部署时**实时读取下层发布到 SSM Parameter Store 的最新值（VpcId、子网、安全组、Aurora endpoint）。改了 network/db 之后，下次部署 api 层会自动读到新值，不需要手动同步。

---

## 一、GitHub 仓库需要配置的内容

路径：仓库 Settings → Secrets and variables → Actions

> `AWS_DEPLOY_ROLE_ARN` 指向的那个 IAM 角色本身（信任策略、权限策略）是在 AWS 那边配置的，不是 GitHub 上的东西——角色的创建命令、完整权限清单见 [IAM.md](IAM.md)。

### Secrets（敏感值，必须配置）

| 名称 | 说明 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | GitHub OIDC 用来 assume 的部署角色 ARN |
| `DB_PASSWORD` | Aurora 主密码。**必须**和你手动部署 `db-template.yaml` 时传的 `DbMasterPassword` 参数值一致 |
| `INTERNAL_PROXY_TOKEN` | 和 Cloudflare Worker 共享的密钥 |
| `ADMIN_MIGRATION_TOKEN` | 可选，数据库初始化用的临时管理 token，用完可以清空 |

> 不需要再配置 `DATABASE_URL`——它由 workflow 在部署时用 `DB_PASSWORD` + 从 SSM 实时读到的 Aurora endpoint 现拼出来。

### Variables（非敏感，都有默认值兜底，一般不用改）

| 名称 | 默认值 |
|---|---|
| `AWS_REGION` | `us-west-2` |
| `SAM_STACK_NAME` | `token-query-api` |
| `CORS_ORIGIN` | `https://app.doyouadoreme.online` |
| `PRIVATE_SUBNET_IDS_SSM_PARAM` | `/token-query/network/private-subnet-ids` |
| `LAMBDA_SECURITY_GROUP_ID_SSM_PARAM` | `/token-query/network/lambda-security-group-id` |
| `LAMBDA_EXECUTION_ROLE_ARN` | 现有 Lambda 执行角色 ARN（不在任何 stack 里管理，纯引用） |
| `CERTIFICATE_ARN` | 现有 ACM 证书 ARN（ACM 证书不支持 CloudFormation 管理，纯引用） |

---

## 二、正向部署（从零开始）

### 第 1 步：网络层（手动，CLI）

```bash
cd /Users/whitesmith/Projects/token-query

aws cloudformation validate-template \
  --template-body file://infra/network-template.yaml \
  --region us-west-2

aws cloudformation create-stack \
  --stack-name token-query-network \
  --region us-west-2 \
  --template-body file://infra/network-template.yaml

# 轮询进度，直到 CREATE_COMPLETE（NAT Gateway 较慢，预计 2-5 分钟）
aws cloudformation describe-stacks \
  --stack-name token-query-network --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### 第 2 步：数据库层（手动，CLI）

必须等网络层 `CREATE_COMPLETE` 之后再做。`DbMasterPassword` 自己定一个密码，记住它——之后要填进 GitHub Secrets 的 `DB_PASSWORD`。

```bash
aws cloudformation create-stack \
  --stack-name token-query-db \
  --region us-west-2 \
  --template-body file://infra/db-template.yaml \
  --parameters ParameterKey=DbMasterPassword,ParameterValue='<你的密码>'

# Aurora Serverless v2 建集群较慢，预计 5-10 分钟
aws cloudformation describe-stacks \
  --stack-name token-query-db --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### 第 3 步：API 层（自动，GitHub Actions）

1. 确认上面第一节列的 Secrets/Variables 都配置好了（尤其 `DB_PASSWORD` 要跟第 2 步的密码一致）。
2. 去仓库 Actions 页面，找到 `Deploy AWS Lambda API`，点击 `Run workflow`（或者 push 一次触碰到 `apps/server/**`/`infra/template.yaml` 的改动，会自动触发）。
3. 跑完之后确认：

```bash
aws cloudformation describe-stacks \
  --stack-name token-query-api --region us-west-2 \
  --query 'Stacks[0].Outputs' --output table

curl -i https://<ApiEndpoint 或 CustomDomainUrl 输出值>/
```

### 本地手动部署 API 层（不走 CI 的备选方案）

```bash
pnpm --filter server build
cd infra
sam build
sam deploy   # 用 samconfig.toml 里的默认值；DbPassword/InternalProxyToken 等敏感参数会提示你手动输入
```

---

## 三、反向卸载（从有到无）

**删除顺序必须是 api → db → network**，反过来会因为 VPC 还有依赖（Lambda 的 ENI、Aurora 用的子网/安全组）而删除失败。

> ⚠️ 三层模板里所有资源的 `DeletionPolicy` 都是 `Delete`，Aurora 的 `DeletionProtection` 也是关闭状态——意味着删 stack 就是真删，Aurora 没有最终快照，数据永久丢失。确认真的要删再执行。

### 第 1 步：删 API 层

```bash
aws cloudformation delete-stack --stack-name token-query-api --region us-west-2

aws cloudformation describe-stacks \
  --stack-name token-query-api --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
# 目标：命令报 "Stack ... does not exist"，说明删干净了
```

### 第 2 步：删数据库层

等第 1 步确认删完（stack 不存在）之后：

```bash
aws cloudformation delete-stack --stack-name token-query-db --region us-west-2

aws cloudformation describe-stacks \
  --stack-name token-query-db --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### 第 3 步：删网络层

```bash
aws cloudformation delete-stack --stack-name token-query-network --region us-west-2

aws cloudformation describe-stacks \
  --stack-name token-query-network --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### （可选）连 SAM 的托管 bucket 一起清

`aws-sam-cli-managed-default` 是 SAM CLI 自己建的托管 S3 bucket（存部署产物），跟业务三层无关。如果想彻底清空账户：

```bash
# S3 bucket 开了版本控制，得先清空所有版本才能删 bucket，否则 delete-stack 会报 "bucket not empty"
BUCKET=$(aws cloudformation describe-stack-resources \
  --stack-name aws-sam-cli-managed-default --region us-west-2 \
  --logical-resource-id SamCliSourceBucket \
  --query 'StackResources[0].PhysicalResourceId' --output text)

aws s3api list-object-versions --bucket "$BUCKET" --region us-west-2 --output json > /tmp/versions.json
python3 -c "
import json
data = json.load(open('/tmp/versions.json'))
objects = [{'Key': v['Key'], 'VersionId': v['VersionId']} for v in (data.get('Versions') or [])]
objects += [{'Key': m['Key'], 'VersionId': m['VersionId']} for m in (data.get('DeleteMarkers') or [])]
print(json.dumps({'Objects': objects, 'Quiet': True}))
" > /tmp/delete-payload.json
aws s3api delete-objects --bucket "$BUCKET" --region us-west-2 --delete file:///tmp/delete-payload.json

aws cloudformation delete-stack --stack-name aws-sam-cli-managed-default --region us-west-2
```

删完这个之后，下次 `sam deploy --resolve-s3` 会自动重新创建它，不需要手动干预。

---

## 四、变更已部署的 network/db 层（不是从零建，是改配置）

`network`/`db` 这两层严禁 blind apply——永远先出 change set 预览，确认 diff 没问题再执行：

```bash
aws cloudformation create-change-set \
  --stack-name token-query-db \
  --change-set-name my-change \
  --region us-west-2 \
  --template-body file://infra/db-template.yaml

aws cloudformation describe-change-set \
  --stack-name token-query-db --change-set-name my-change --region us-west-2

# 确认没问题再执行
aws cloudformation execute-change-set \
  --stack-name token-query-db --change-set-name my-change --region us-west-2
```

`network` 层同理，把 `token-query-db` 换成 `token-query-network`。

---

## 五、常见坑（踩过的记录一下）

- **CloudFormation 对"只改 Parameter 类型/Default、不带任何资源属性变化"的更新会直接拒绝**（报 `No updates are to be performed`）。这种改动要跟一个真实的资源变更（哪怕是加个新资源）捆在一起才能推得动。
- **`DeletionPolicy` 只是纯属性变更，CloudFormation 会正常识别成 `Modify`**，不受上面那条限制，可以单独更新生效。
- **`ApiMapping` 删除时如果跟它绑定的 Stage 并行删，会报错**"Please remove all base path mappings"——模板里已经加了 `DependsOn: TokenQueryHttpApiApiGatewayDefaultStage` 来强制顺序，正常不会再遇到。
- **SAM 托管 S3 bucket 开了版本控制**，`delete-stack` 删不掉非空 bucket，得先清空所有对象版本（见上面第三节的可选步骤）。
- **`AWS::SSM::Parameter::Value<...>` 类型的参数需要 `ssm:GetParameters`/`ssm:GetParameter` 权限**，且要精确到具体的 SSM 参数路径前缀，不然会报 AccessDenied。
- **ACM 证书本身不支持 CloudFormation import**，只能用 ARN 引用，不放进任何 stack 管理。
- **部署角色的 IAM policy 是照"接管已有资源（import）"这个场景配的，不等于"从零创建/删除"需要的权限**：只给了具体函数名 `token-query-function` 的 `UpdateFunctionCode`/`AddPermission`/`TagResource` 等，没给 `CreateFunction`/`DeleteFunction`。如果 stack 是从零 `create-stack`（不是 import 出来的），第一次部署会在这一步报 AccessDenied 卡住，stack 进入 `ROLLBACK_COMPLETE`。修法：给部署角色补上对应资源名的 `lambda:CreateFunction`/`lambda:DeleteFunction`，然后 `delete-stack` 清掉这个空壳 stack（`ROLLBACK_COMPLETE` 状态下没有任何真实资源残留，可以直接删）重新创建。
- **`ROLLBACK_COMPLETE` 状态的 stack 不能直接 `update`/`create-change-set`**，必须先 `delete-stack` 再重新 `create-stack`。
