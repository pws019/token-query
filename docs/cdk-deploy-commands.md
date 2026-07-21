# CDK Deploy Commands

本文记录当前项目 CDK 相关的本地部署、预览部署和清理指令。CDK 入口在 `infra/cdk`，workspace package 名称是 `@token-query/infra-cdk`。

默认 AWS 区域是 `us-west-2`。以下命令都从仓库根目录执行。

## 前置检查

```bash
pnpm install
pnpm --filter @token-query/infra-cdk check-types
```

确认当前 AWS 身份和区域：

```bash
aws sts get-caller-identity
aws configure get region
```

如果当前账号或区域还没有 CDK bootstrap 资源，先执行：

```bash
pnpm --filter @token-query/infra-cdk cdk bootstrap aws://<account-id>/us-west-2
```

## Stack Scope

`infra/cdk/bin/token-query.ts` 会根据环境变量选择要 synth 的 stack：

| Scope | Stack |
| --- | --- |
| `permissions` | `token-query-permissions` |
| `foundation` | `token-query-foundation` |
| `api` | `token-query-api` |
| `go` | `token-query-go` |
| `monitoring` | `token-query-monitoring` |
| `preview-cleanup` | `token-query-preview-cleanup` |
| `preview-reconciliation` | `token-query-preview-reconciliation` |
| `all` 或未设置 | 以上生产 stack 全部 |

Preview stack 需要额外设置 `PREVIEW_ID`，并可用 `PREVIEW_STACK_SCOPE` 选择 `api` 或 `go`。

## 权限层

权限层创建 GitHub Actions OIDC deploy role，并把 role ARN 写入 SSM 参数 `/token-query/permissions/github-actions-deploy-role-arn`。这个 stack 使用本地 CLI 凭证部署，首次部署需要从可信本地会话执行。

```bash
CDK_STACK_SCOPE=permissions pnpm --filter @token-query/infra-cdk cdk diff token-query-permissions
CDK_STACK_SCOPE=permissions pnpm --filter @token-query/infra-cdk cdk deploy token-query-permissions
```

部署后查看输出：

```bash
aws cloudformation describe-stacks \
  --stack-name token-query-permissions \
  --region us-west-2 \
  --query 'Stacks[0].Outputs' \
  --output table
```

## 基础设施层

基础设施层创建 VPC、私有子网、安全组、Aurora、ECR、ECS cluster、Cloud Map 和 CodeBuild，并把共享资源引用写入 `/token-query/foundation/*` SSM 参数。

```bash
CDK_STACK_SCOPE=foundation pnpm --filter @token-query/infra-cdk cdk diff token-query-foundation
CDK_STACK_SCOPE=foundation pnpm --filter @token-query/infra-cdk cdk deploy token-query-foundation
```

查看 foundation 输出和参数：

```bash
aws cloudformation describe-stacks \
  --stack-name token-query-foundation \
  --region us-west-2 \
  --query 'Stacks[0].Outputs' \
  --output table

aws ssm get-parameters-by-path \
  --path /token-query/foundation \
  --recursive \
  --region us-west-2 \
  --query 'Parameters[*].[Name,Value]' \
  --output table
```

## Lambda API 生产部署

Lambda API stack 名称是 `token-query-api`。CDK 会从 `apps/server/dist` 打包 Lambda asset，所以部署前必须先 build server。

```bash
pnpm --filter server check-types
pnpm --filter server build
CDK_STACK_SCOPE=api pnpm --filter @token-query/infra-cdk cdk diff token-query-api
```

最小部署命令：

```bash
CDK_STACK_SCOPE=api pnpm --filter @token-query/infra-cdk cdk deploy token-query-api
```

带生产参数的部署命令：

```bash
CDK_STACK_SCOPE=api pnpm --filter @token-query/infra-cdk cdk deploy token-query-api \
  --require-approval never \
  --parameters token-query-api:CorsOrigin=https://app.doyouadoreme.online \
  --parameters token-query-api:ApiCustomDomainName=api.doyouadoreme.online \
  --parameters token-query-api:ApiCertificateArn=<acm-certificate-arn> \
  --parameters token-query-api:InternalProxyToken=<internal-proxy-token>
```

如果需要临时打开数据库初始化接口，再额外传入：

```bash
--parameters token-query-api:AdminMigrationToken=<temporary-admin-token>
```

### 灰度部署（Lambda Alias + CodeDeploy Canary）

`token-query-api` 栈里 Lambda 走的是 Alias（固定名字 `live`）+ CodeDeploy `CANARY_10PERCENT_10MINUTES` 灰度策略，API Gateway 调用的也是这个 alias，不是裸函数。这套机制通过 CloudFormation 原生的 `UpdatePolicy: CodeDeployLambdaAliasUpdate` 触发——**上面这条 `cdk deploy` 命令本身不用改**，只要代码变了，`cdk deploy` 就会自动走"发布新 Version → 灰度切流量 10% → 观察 10 分钟 → 全量或自动回滚"，回滚判断复用的是监控层的 `token-query-api-heartbeat-failed` 这个 Alarm（见下方"监控层"小节），不需要额外配置。

`cdk deploy` 这一步因此会比以前多花 10 分钟以上，是预期行为。概念详解和排障见 [docs/knowledge/lambda-codedeploy-canary.md](knowledge/lambda-codedeploy-canary.md)。

常用观察命令：

```bash
# 看这次部署的状态（Created/InProgress/Succeeded/Stopped）
aws deploy list-deployments --application-name token-query-api --deployment-group-name token-query-api-dg --region us-west-2

# 看 alias 当前指向哪个/哪些 version（灰度中会有 RoutingConfig 加权，结束后变回单一 version）
aws lambda get-alias --function-name token-query-function --name live --region us-west-2
```

部署后查看 API 输出：

```bash
aws cloudformation describe-stacks \
  --stack-name token-query-api \
  --region us-west-2 \
  --query 'Stacks[0].Outputs' \
  --output table
```

如果 `CustomDomainRegionalDomainName` 变化，需要同步 Cloudflare DNS 中 `api.doyouadoreme.online` 的 CNAME target。

## Go ECS 生产部署

Go stack 名称是 `token-query-go`。它部署 ECS/Fargate service，镜像来自 foundation 层创建的 ECR repository。ECS 任务和 Lambda API 共用同一个 Aurora 集群，所以 Go 服务上线前需要保证数据库 schema 是最新的。

### 推荐流程：通过 GitHub Actions 部署

首次部署，或数据库 schema 有变化时，先在 GitHub 上手动跑一次数据库迁移，再跑一次 Go 部署：

1. 打开 `Actions` → `Run DB Migration` → `Run workflow`
   - `operation` 选择默认值 `migrate`（保持默认即可，不要误选成上次用过的 `reset_profiles`）
   - `confirm_reset` 留空
   - 触发后底层会调用 CodeBuild 项目 `token-query-db-migrate` 执行 `pnpm --filter @token-query/db db:migrate`（即 `drizzle-kit migrate`），对目标 Aurora 集群做增量 schema 迁移
2. 等待上一步 workflow 显示成功后，打开 `Actions` → `Deploy Go` → `Run workflow`
   - `image_tag` 留空即可，默认使用 `go-<short-sha>`
   - 该 workflow 会依次执行：assume `AWS_DEPLOY_ROLE_ARN` → 启动 CodeBuild 项目 `token-query-go-build` 构建并推镜像到 ECR → `cdk deploy token-query-go --parameters ImageTag=<tag>` 更新 ECS service

对应的 workflow 文件：`.github/workflows/run-db-migration.yml`、`.github/workflows/deploy-go.yml`。也可以用 CLI 触发：

```bash
gh workflow run run-db-migration.yml --repo pws019/token-query --ref main-v2 -f operation=migrate
# 等待上面这个 run 成功后再跑：
gh workflow run deploy-go.yml --repo pws019/token-query --ref main-v2
```

推送到 `main` / `main-v2` 且改动命中 `apps/go-service/**`、`infra/codebuild/**`、`infra/cdk/**` 或该 workflow 文件本身时，`Deploy Go` 也会自动触发一次，不需要每次都手动跑；数据库迁移目前是纯手动 workflow，不会跟着 push 自动跑。

### 手动 / 本地排查用命令

不经过 GitHub Actions、直接用本地 AWS CLI 构建镜像并部署（用于调试或 CI 之外的场景）：

```bash
IMAGE_TAG=go-<short-sha>
CODEBUILD_PROJECT_NAME=token-query-go-build

aws codebuild start-build \
  --project-name "$CODEBUILD_PROJECT_NAME" \
  --source-version <git-sha> \
  --environment-variables-override name=IMAGE_TAG,value="$IMAGE_TAG",type=PLAINTEXT \
  --region us-west-2
```

确认 CodeBuild 成功后部署 Go stack：

```bash
CDK_STACK_SCOPE=go pnpm --filter @token-query/infra-cdk cdk diff token-query-go \
  --parameters token-query-go:ImageTag="$IMAGE_TAG"

CDK_STACK_SCOPE=go pnpm --filter @token-query/infra-cdk cdk deploy token-query-go \
  --require-approval never \
  --parameters token-query-go:ImageTag="$IMAGE_TAG"
```

如果要临时扩容或停服务，可以设置 `DesiredCount`：

```bash
CDK_STACK_SCOPE=go pnpm --filter @token-query/infra-cdk cdk deploy token-query-go \
  --parameters token-query-go:ImageTag="$IMAGE_TAG" \
  --parameters token-query-go:DesiredCount=0
```

## Lambda API Preview 部署

Preview ID 必须符合 `<type>-<number>`，例如 `feat-001`、`bug-111`。Lambda preview stack 名称是 `token-query-preview-api-<preview-id>`，函数名是 `token-query-pr-<preview-id>`。

```bash
PREVIEW_ID=feat-001
STACK_NAME=token-query-preview-api-$PREVIEW_ID
PREVIEW_DOMAIN=$PREVIEW_ID.app.doyouadoreme.online

pnpm --filter server build

CDK_STACK_SCOPE=api PREVIEW_ID="$PREVIEW_ID" PREVIEW_STACK_SCOPE=api \
  pnpm --filter @token-query/infra-cdk cdk deploy "$STACK_NAME" \
  --require-approval never \
  --parameters "$STACK_NAME:CorsOrigin=https://$PREVIEW_DOMAIN" \
  --parameters "$STACK_NAME:InternalProxyToken=<internal-proxy-token>"
```

如果该 preview Lambda 需要临时数据库初始化 token，追加：

```bash
--parameters "$STACK_NAME:AdminMigrationToken=<temporary-admin-token>"
```

## Go ECS Preview 部署

Go preview stack 名称是 `token-query-preview-go-<preview-id>`，ECS service 名称是 `token-query-go-pr-<preview-id>`，Cloud Map origin 是 `http://go-<preview-id>.token-query.internal:8080`。

先构建 preview 镜像：

```bash
PREVIEW_ID=feat-001
IMAGE_TAG=$PREVIEW_ID-<short-sha>
CODEBUILD_PROJECT_NAME=token-query-go-build

aws codebuild start-build \
  --project-name "$CODEBUILD_PROJECT_NAME" \
  --source-version <git-sha> \
  --environment-variables-override name=IMAGE_TAG,value="$IMAGE_TAG",type=PLAINTEXT \
  --region us-west-2
```

确认 CodeBuild 成功后部署 preview Go stack：

```bash
STACK_NAME=token-query-preview-go-$PREVIEW_ID

CDK_STACK_SCOPE=go PREVIEW_ID="$PREVIEW_ID" PREVIEW_STACK_SCOPE=go \
  pnpm --filter @token-query/infra-cdk cdk deploy "$STACK_NAME" \
  --require-approval never \
  --parameters "$STACK_NAME:ImageTag=$IMAGE_TAG"
```

## 监控层（Synthetics canary）生产部署

Monitoring stack 名称是 `token-query-monitoring`，包含两个独立的 CloudWatch Synthetics 心跳 canary：

- `token-query-api-heartbeat`：探测公网 Lambda API 的 `https://api.doyouadoreme.online/health`，只断言 `ok === true`
- `token-query-go-heartbeat`：探测内网 Go 服务的 `http://go.token-query.internal:8080/health`，只断言 `ok === true`

两个 canary 故意拆开、各自独立断言、各自独立 CloudWatch Alarm（`token-query-api-heartbeat-failed` / `token-query-go-heartbeat-failed`）——这样任意一个失败时，从告警名字就能直接知道是 Lambda 挂了还是 Go 挂了，不需要再去翻 `failureReason` 判断。两个 canary 都跑在 foundation 层的私有子网里（VPC ID / 子网 ID 直接从 SSM 参数 `/token-query/foundation/vpc-id`、`/token-query/foundation/private-subnet-ids` 读取），Go canary 额外对 foundation 导出的 `go-security-group-id` 打了一条入站放行规则（tcp/8080，来源是 Go canary 自己的安全组）。

Artifact 统一存到 Part 1 手工创建时用过的 S3 bucket（`cw-syn-results-707605822527-us-west-2`），CDK 只是复用它，不新建 bucket。

这个 stack 还包含一个共用的 SNS Topic `token-query-ops-alerts`（`AlertEmail` 是必填参数，没有默认值，部署时必须传），两个 canary 的 Alarm 都挂在这个 Topic 上。部署命令：

```bash
CDK_STACK_SCOPE=monitoring pnpm --filter @token-query/infra-cdk cdk diff token-query-monitoring
CDK_STACK_SCOPE=monitoring pnpm --filter @token-query/infra-cdk cdk deploy token-query-monitoring \
  --require-approval never \
  --parameters token-query-monitoring:AlertEmail=<接收告警的邮箱>
```

部署后确认两个 canary 都跑出 `PASSED`：

```bash
aws synthetics get-canary-runs --name token-query-api-heartbeat --region us-west-2 --max-results 1 --query 'CanaryRuns[0].Status'
aws synthetics get-canary-runs --name token-query-go-heartbeat --region us-west-2 --max-results 1 --query 'CanaryRuns[0].Status'
```

看 canary 运行报告时，只能走控制台或 `aws s3 cp`（带凭证），不要直接拼公网 S3 HTTPS 直链——桶是私有的，裸链接一定会拿到 `AccessDenied`（详见 `docs/todayToDo.md` 里的踩坑记录）。

**首次部署后**，Email 订阅是 `PendingConfirmation` 状态，必须去邮箱点确认链接才能真的收到通知：

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn arn:aws:sns:us-west-2:707605822527:token-query-ops-alerts \
  --region us-west-2 --query 'Subscriptions[*].{Endpoint:Endpoint,Status:SubscriptionArn}'
```

## PR Preview 清理兜底层（SQS + DLQ）生产部署

Stack 名称是 `token-query-preview-cleanup`，依赖监控层导出的 SSM 参数 `/token-query/monitoring/ops-alerts-topic-arn`——**必须先部署 `token-query-monitoring`**，再部署这个 stack。完整流程图和排查笔记见 [docs/knowledge/preview-cleanup-flow.md](knowledge/preview-cleanup-flow.md)。

这个 stack 给 `cleanup-lambda-preview.yml` / `cleanup-go-preview.yml` 的 `cdk destroy` 失败分支提供兜底：失败时那两个 workflow 会把 `{ stackName, previewId }` 发到这里的 SQS 队列，由一个 Lambda 消费者直接调 `cloudformation:DeleteStack` 重试；重试 3 次还失败会进死信队列，触发 Alarm 通知到上面 `token-query-ops-alerts` 这个 Topic。

```bash
CDK_STACK_SCOPE=preview-cleanup pnpm --filter @token-query/infra-cdk cdk diff token-query-preview-cleanup
CDK_STACK_SCOPE=preview-cleanup pnpm --filter @token-query/infra-cdk cdk deploy token-query-preview-cleanup --require-approval never
```

部署后确认队列和 Alarm 都建好了：

```bash
aws sqs get-queue-url --queue-name token-query-preview-cleanup-queue --region us-west-2
aws sqs get-queue-url --queue-name token-query-preview-cleanup-dlq --region us-west-2
aws cloudwatch describe-alarms --alarm-names token-query-preview-cleanup-dlq-not-empty --region us-west-2 --query 'MetricAlarms[0].StateValue'
```

`GitHubActionsDeployRole` 需要 `sqs:SendMessage` / `sqs:GetQueueUrl` 权限才能在两个 cleanup workflow 里往这个队列发消息，这条权限在 `permissions-stack.ts` 里（`QueuePreviewCleanupRetries`），跟 `token-query-preview-cleanup` 是两个独立的栈，改动权限层要单独 `cdk deploy token-query-permissions`。

## Preview 环境定时对账层（第二层兜底）生产部署

Stack 名称是 `token-query-preview-reconciliation`，依赖 `token-query-preview-cleanup` 导出的 SSM 参数（`/token-query/preview-cleanup/queue-url`、`queue-arn`）——**必须先部署 `token-query-preview-cleanup`**。这是 Part 7 的第二层兜底：每天定时扫一遍 `token-query-preview-*` CFN 栈和 `token-query-pr-*` Cloudflare Worker，跟 GitHub 上仍然 open 的 PR 比对，孤儿 CFN 栈丢进上面那个 preview-cleanup 队列复用同一套重试/DLQ/告警，孤儿 Cloudflare Worker 直接调 API 删掉。完整设计和排查笔记见 [docs/knowledge/preview-cleanup-flow.md](knowledge/preview-cleanup-flow.md)。

**部署前必须先手动创建两个 Secrets Manager 密钥**（这一步不由 CDK 管理，避免把凭证写进模板/仓库）：

```bash
# 一个只需要读 PR 权限的 fine-grained GitHub PAT
aws secretsmanager create-secret \
  --name token-query/reconciliation/github-token \
  --secret-string '<你的 GitHub PAT>' \
  --region us-west-2

# 一个有 Workers Scripts:Read + Workers Scripts:Edit 权限的 Cloudflare API Token（Edit 是为了能删孤儿 Worker）
aws secretsmanager create-secret \
  --name token-query/reconciliation/cloudflare-api-token \
  --secret-string '<你的 Cloudflare API Token>' \
  --region us-west-2
```

部署时需要额外传 `CloudflareAccountId`（没有默认值）：

```bash
CDK_STACK_SCOPE=preview-reconciliation pnpm --filter @token-query/infra-cdk cdk diff token-query-preview-reconciliation
CDK_STACK_SCOPE=preview-reconciliation pnpm --filter @token-query/infra-cdk cdk deploy token-query-preview-reconciliation \
  --require-approval never \
  --parameters token-query-preview-reconciliation:CloudflareAccountId=<你的 Cloudflare account id>
```

部署后可以手动触发一次看看效果，不用等第二天的定时调度：

```bash
aws lambda invoke --function-name token-query-preview-reconciliation --region us-west-2 /tmp/reconciliation-output.json
cat /tmp/reconciliation-output.json

# 看这次调用的日志，确认扫描到的栈/Worker/open PR 数量，以及有没有孤儿资源
aws logs tail /aws/lambda/token-query-preview-reconciliation --region us-west-2 --since 5m
```

## 清理顺序

按依赖反向删除，避免 foundation 资源仍被应用层引用：

```bash
CDK_STACK_SCOPE=api PREVIEW_ID=<preview-id> PREVIEW_STACK_SCOPE=api \
  pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-api-<preview-id>

CDK_STACK_SCOPE=go PREVIEW_ID=<preview-id> PREVIEW_STACK_SCOPE=go \
  pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-go-<preview-id>

CDK_STACK_SCOPE=preview-reconciliation pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-reconciliation
CDK_STACK_SCOPE=preview-cleanup pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-cleanup
CDK_STACK_SCOPE=monitoring pnpm --filter @token-query/infra-cdk cdk destroy token-query-monitoring
CDK_STACK_SCOPE=go pnpm --filter @token-query/infra-cdk cdk destroy token-query-go
CDK_STACK_SCOPE=api pnpm --filter @token-query/infra-cdk cdk destroy token-query-api
CDK_STACK_SCOPE=foundation pnpm --filter @token-query/infra-cdk cdk destroy token-query-foundation
CDK_STACK_SCOPE=permissions pnpm --filter @token-query/infra-cdk cdk destroy token-query-permissions
```

日常清理不要使用 `cdk destroy --all`。显式 stack 名称更容易审查，也能降低误删共享资源或权限层的风险。

## GitHub Actions 对应关系

| 操作 | Workflow |
| --- | --- |
| 生产 Lambda API | `.github/workflows/deploy-lambda.yml` |
| Lambda API preview | `.github/workflows/deploy-lambda-preview.yml` |
| 清理 Lambda API preview | `.github/workflows/cleanup-lambda-preview.yml` |
| 生产 Go ECS | `.github/workflows/deploy-go.yml` |
| Go ECS preview | `.github/workflows/deploy-go-preview.yml` |
| 清理 Go ECS preview | `.github/workflows/cleanup-go-preview.yml` |

