# Go + ECS + PR Preview 实施路线图

本文档记录 Token Query 接下来完成作业的 step-by-step 路线。

目标不是一次性把所有云资源自动化到位，而是在做作业的过程中逐步理解：

```text
前端交互
  -> Cloudflare Worker
    -> Lambda
      -> Go service on ECS/Fargate
        -> VPC 内数据库
```

最终再把这条链路接入 PR preview：

```text
PR
  -> App Preview Worker
  -> API Preview Lambda
  -> Go Preview ECS Service
  -> 数据库
```

## 作业目标拆解

原始作业要求：

1. 搭建 Go 的运行环境，使用 Go 连接数据库，把上次 Node 数据库代码迁移过来一部分，用用户名生成一个个人介绍，并在前端展示。
2. 使用 ECR + ECS + ALB + Fargate，通过 Cloud Map 连接 Lambda 接口。
3. 构建一个基于 PR 分支的独立开发环境，包含 Cloudflare + CodeBuild + IAM 角色治理，完成 Go 版本。

本项目中的落地理解：

- 前端不做复杂页面，只在现有 token 查 profile 的流程后增加一个按钮。
- 只有查到 profile 后，按钮才可用。
- 点击按钮后，请求现有 Lambda。
- Lambda 调用 Go 服务。
- Go 服务访问数据库，获取用户名相关信息。
- Go 服务拼出一段写死模板的个人介绍并返回。
- 前端展示这段个人介绍。

完整验收链路：

```text
打开 PR preview 前端
  -> 查询 token profile
  -> 点击“生成个人介绍”
  -> Worker 自动带 X-Preview-Id
  -> Lambda preview/router
  -> Go service
  -> 数据库
  -> 返回个人介绍
  -> 前端渲染
```

## 关键设计原则

### 先手动学习，再 CDK 归档

每个新云服务先走一次手动或半手动流程，理解控制台中的资源关系。

手动跑通后，再把资源写回 CDK：

```text
手动创建/调试
  -> 理解资源边界
  -> 删除手动资源
  -> 用 CDK 重新创建
  -> 接入 GitHub Actions / Preview
```

### GitHub Actions 仍然是流程入口

现阶段 GitHub Actions 继续负责：

- PR 命名校验。
- Cloudflare Worker preview 部署。
- Lambda/CDK 部署。
- 触发或等待 CodeBuild。
- PR 评论 preview 地址。
- PR 关闭后的资源清理。

### CodeBuild 只在 Go 镜像阶段引入

当前 Lambda TypeScript 构建不需要迁到 CodeBuild。

CodeBuild 的首次合理使用点是：

- 构建 Go binary。
- `docker build`。
- 推送镜像到 ECR。
- 后续可选：在 VPC 内跑数据库 migration。

### 本地调试和 VPC 数据库要分开看

数据库在 VPC 私有子网里，本地机器默认不能直连。

后续实现时需要专门讨论调试方案，例如：

- 本地 Go 先用本地数据库或临时外部数据库验证业务逻辑。
- 云上 Go 通过 ECS/Fargate 访问 VPC 内 RDS。
- 必要时使用跳板、SSM Session Manager、RDS Proxy、临时安全组或 migration runner。

不要把“本地无法直连 VPC 数据库”误判为 Go 代码问题。

## Phase 0：当前基线确认

目标：

- 确认今天完成的 Lambda CDK + preview 流程可作为后续基础。

已有能力：

- `Deploy App Preview` 可以为 PR 创建 Cloudflare Worker preview。
- `Deploy API Preview` 可以为 PR 创建 Lambda preview。
- Worker preview 会带 `X-Preview-Id`。
- 生产 API Lambda 会根据 `X-Preview-Id` 调用对应 preview Lambda。
- PR 关闭或合并后，cleanup workflow 会清理 app/api preview 资源。
- `Deploy API` 已补充 `main-v2` push 触发条件。

验收方式：

```bash
curl https://<preview-id>.app.doyouadoreme.online/api/health
```

期望看到：

```json
{
  "appEnv": "preview",
  "previewId": "<preview-id>"
}
```

## Phase 1：初始化 Go 项目并本地跑通 HTTP 接口

目标：

- 在仓库内新增 Go 服务目录。
- Go 服务先暴露一个简单 HTTP 接口。
- 本地不先纠结云上数据库，先跑通 Go runtime 和接口形态。

建议目录：

```text
apps/go-service/
  cmd/server/main.go
  internal/http/
  internal/profile/
  go.mod
  Dockerfile
```

建议接口：

```text
GET /health
POST /profile/intro
```

`/profile/intro` 请求示例：

```json
{
  "tokenId": "123"
}
```

返回示例：

```json
{
  "username": "whitesmith",
  "intro": "Hi, I am whitesmith. I am exploring token profiles and building a Go-powered profile service."
}
```

本阶段实现范围：

- Go HTTP server。
- 简单 JSON request/response。
- 基础日志。
- 本地运行命令。
- Dockerfile。

暂不做：

- ECS。
- Cloud Map。
- CodeBuild。
- VPC 数据库连接。

验收方式：

```bash
cd apps/go-service
go run ./cmd/server
curl http://localhost:8080/health
curl -X POST http://localhost:8080/profile/intro \
  -H "Content-Type: application/json" \
  -d '{"tokenId":"123"}'
```

## Phase 2：迁移一部分 Node 数据库查询到 Go

目标：

- 从现有 Node 代码中挑一小段数据库查询迁移到 Go。
- Go 服务根据 token/profile 信息查出 username。
- Go 使用 username 拼接个人介绍。

建议迁移范围：

- 只迁移“按 token/profile 查 username 所需的最小查询”。
- 不迁移完整业务。
- 不重做复杂 ORM 抽象。

数据库连接策略：

- Go 代码通过 `DATABASE_URL` 读取数据库连接。
- 本地可先用本地数据库或 mock/stub 数据调试。
- 云上通过 ECS task env 注入 VPC 内 RDS 的连接串。

需要单独讨论的问题：

- 本地是否需要连真实 VPC RDS。
- 是否使用临时公网访问、跳板、SSM tunnel，还是本地数据库替代。
- migration/seed 在哪里跑。

验收方式：

- 本地 Go 服务可以返回带 username 的 intro。
- 即使数据库暂时不可连，也要有清晰的错误响应和日志。

## Phase 3：前端增加最小交互

目标：

- 在现有 profile 查询结果页面增加一个按钮。
- 只有 profile 查出来后按钮才可点击。
- 点击按钮后调用 Lambda 新接口。
- 前端展示个人介绍。

建议前端行为：

```text
查 token profile 成功
  -> 显示“生成个人介绍”按钮
  -> 点击后 loading
  -> 成功展示 intro
  -> 失败展示错误提示
```

建议 Lambda 新接口：

```text
POST /api/profile/intro
```

前端只调用 Lambda，不直接调用 Go。

原因：

- 前端不需要知道 Go 服务在哪里。
- PR preview 的 `X-Preview-Id` 已经由 Worker 负责。
- Lambda 是后端入口，可以统一鉴权、路由和错误处理。

验收方式：

- 本地或 preview 前端能完成点击交互。
- Network 里能看到请求走 `/api/profile/intro`。

## Phase 4：手动部署 Go 到 ECR + ECS/Fargate

目标：

- 先通过控制台或 CLI 手动理解 Go 服务上云需要哪些 AWS 资源。
- 跑通一个手动版 ECS/Fargate Go 服务。

手动资源清单：

- ECR repository：存 Go Docker image。
- ECS cluster：容纳 service。
- Task definition：描述容器、端口、CPU/memory、env。
- Fargate task：实际运行容器。
- ECS service：维持 task 数量。
- Security group：控制 Lambda/ECS/ALB 访问。
- CloudWatch Logs：查看 Go 服务日志。

是否立即使用 ALB：

- 作业要求包含 ALB，所以需要理解并最终接入。
- 但 Lambda -> Go 内部调用优先走 Cloud Map。
- ALB 可以作为手动调试入口或作业展示资源。

手动验收方式：

- ECS task 稳定运行。
- CloudWatch Logs 能看到 Go 服务启动。
- 如果有 ALB，能访问 `/health`。

## Phase 5：Lambda 通过 Cloud Map 调 Go

目标：

- 建立 `Lambda -> Cloud Map -> ECS Go service` 的内部调用链路。
- Lambda 新增 `/api/profile/intro`，内部 HTTP 调 Go。

资源关系：

```text
ECS Service
  -> 注册到 Cloud Map service

Lambda
  -> 通过 Cloud Map 名称解析 Go service
  -> HTTP 请求 Go service
```

Cloud Map 和 HTTP 的关系：

- Cloud Map 负责服务发现，即“找到 Go 服务在哪里”。
- HTTP 负责实际业务请求。
- 它们不是同一层概念，而是配合使用。

需要注意：

- Lambda 必须在 VPC 内。
- Lambda security group 要能访问 ECS service security group。
- ECS service security group 要允许来自 Lambda security group 的 Go 服务端口。
- Lambda 需要 DNS/Cloud Map 解析配置正确。

验收方式：

```bash
curl https://api.doyouadoreme.online/api/profile/intro
```

期望：

- Lambda 日志显示调用 Go。
- Go 日志显示收到请求。
- 返回个人介绍。

## Phase 6：删除手动资源并归档到 CDK

目标：

- 把手动创建的 ECR/ECS/ALB/Cloud Map/安全组规则归档到 CDK。
- 删除手动资源，避免双轨配置混乱。

CDK 归档建议：

新增或扩展 stack：

```text
token-query-api
  -> production Lambda
  -> production Go ECS service
  -> Cloud Map service
  -> optional ALB

token-query-preview-api-<preview-id>
  -> preview Lambda
  -> preview Go ECS service
  -> preview Cloud Map service
```

也可以在代码上拆分 construct：

```text
ApiStack
  -> LambdaApiConstruct
  -> GoServiceConstruct
  -> CloudMapWiringConstruct
```

但 stack 名称仍保持 `api` / `api-preview`，因为对外它们都是后端。

验收方式：

```bash
pnpm --filter @token-query/infra-cdk cdk diff token-query-api
pnpm --filter @token-query/infra-cdk cdk deploy token-query-api
```

部署后确认：

- ECS service 由 CDK 管理。
- Lambda env 中有 Go service discovery 地址。
- `/api/profile/intro` 可用。

## Phase 7：接入 CodeBuild 构建 Go 镜像

目标：

- 用 CodeBuild 承接 Go Docker image 构建和推送 ECR。
- GitHub Actions 不直接 docker build。

推荐流程：

```text
GitHub Actions
  -> 校验 PR
  -> start CodeBuild

CodeBuild
  -> checkout source
  -> go test
  -> docker build
  -> docker push ECR
  -> 输出 image tag

GitHub Actions / CDK
  -> 使用 image tag 部署 ECS service
```

为什么在这里接入 CodeBuild：

- Go 镜像构建是 AWS 内部资源强相关任务。
- CodeBuild 推 ECR 权限更自然。
- 后续 migration 如果需要访问 VPC 内 RDS，也适合放进 CodeBuild。

暂不建议放到 CodeBuild 的内容：

- PR 命名校验。
- Cloudflare Worker 部署。
- PR 评论。
- 当前 TypeScript Lambda 构建。

CodeBuild IAM 需要关注：

- 读取源码或接收 source artifact。
- 写 CloudWatch Logs。
- 登录和推送 ECR。
- 读取 Secrets Manager/SSM 中必要配置。
- 后续如进 VPC 跑 migration，需要 VPC/subnet/security group 配置。

验收方式：

- CodeBuild 能成功生成 image tag。
- ECR 中能看到对应 tag。
- ECS service 能使用这个 tag 部署。

## Phase 8：接入 PR Preview 后端 Go 资源

目标：

- 后端 PR preview 从“只创建 Lambda”升级为“创建 Lambda + Go ECS service”。
- 前端 preview 不需要知道 Go 存在，仍然只请求 Lambda。

Preview 资源命名：

```text
Preview ID: feat-123

App Worker:
  token-query-pr-feat-123

API Preview Stack:
  token-query-preview-api-feat-123

Lambda:
  token-query-pr-feat-123

Go ECS Service:
  token-query-go-pr-feat-123

Docker image tag:
  feat-123-<short-sha>

Cloud Map service:
  go-pr-feat-123
```

Preview 触发规则：

- 改前端：只部署 App Preview。
- 改后端 Lambda/Go/CDK：部署 API Preview。
- 后端 preview stack 内部创建完整后端链路：Lambda + Go。
- PR 关闭或合并：统一 cleanup 同时尝试清理 App Preview 和 API Preview。

为什么后端 preview 要创建完整链路：

- 如果只改 Go，不创建 Lambda，前端无法通过现有 preview header 路由到这套 Go。
- 如果只改 Lambda，不创建 Go，Lambda 调 Go 的逻辑又要 fallback，复杂度会上升。
- 对当前作业场景，后端 preview 统一创建 Lambda + Go 更简单。

验收方式：

```bash
curl https://<preview-id>.app.doyouadoreme.online/api/profile/intro
```

期望：

- 返回 preview Go 服务生成的个人介绍。
- Lambda 日志包含 preview id。
- Go ECS service 日志包含请求记录。

## Phase 9：清理与文档化

目标：

- 保证作业最终可讲、可演示、可复现。

需要补充的文档：

- Go 本地运行说明。
- Docker build 说明。
- 手动 ECR/ECS/Fargate 操作记录。
- Cloud Map 如何连接 Lambda 和 Go。
- CodeBuild buildspec 和权限说明。
- PR preview 创建和清理流程。
- VPC 数据库连接的调试说明。

最终演示路径：

```text
1. 创建 PR
2. GitHub Actions 创建 App Preview + API Preview
3. CodeBuild 构建 Go image 并推送 ECR
4. CDK 部署 preview Lambda + ECS/Fargate Go service
5. 打开 preview 前端
6. 查询 token profile
7. 点击生成个人介绍
8. 展示 Go 从数据库查询后生成的 intro
9. 合并或关闭 PR
10. Cleanup workflow 清理 preview 资源
```

## 明天建议执行顺序

1. 新建 `apps/go-service`，本地跑通 `/health`。
2. 增加 `/profile/intro`，先用 mock username 返回个人介绍。
3. 查现有 Node 数据库代码，确定要迁移的最小查询。
4. 给 Go 接入数据库访问，但先讨论本地如何处理 VPC RDS 不可直连的问题。
5. Lambda 新增 `/api/profile/intro`，先本地或云上调用 Go mock。
6. 前端在 profile 查询结果后增加“生成个人介绍”按钮。
7. 手动创建 ECR/ECS/Fargate，部署 Go image。
8. 建 Cloud Map，并让 Lambda 调 Go。
9. 跑通 `前端 -> Lambda -> Go -> DB -> 前端`。
10. 删除手动资源，将 ECR/ECS/Cloud Map/安全组规则归档到 CDK。
11. 引入 CodeBuild 构建 Go image。
12. 扩展 API Preview Stack，完成 PR 级 Go preview。
