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

## 清理顺序

按依赖反向删除，避免 foundation 资源仍被应用层引用：

```bash
CDK_STACK_SCOPE=api PREVIEW_ID=<preview-id> PREVIEW_STACK_SCOPE=api \
  pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-api-<preview-id>

CDK_STACK_SCOPE=go PREVIEW_ID=<preview-id> PREVIEW_STACK_SCOPE=go \
  pnpm --filter @token-query/infra-cdk cdk destroy token-query-preview-go-<preview-id>

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

