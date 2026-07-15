# 域名规划
我建议你把域名规划成三层语义：

```text
<preview-id>.<service>.<env>.doyouadoreme.online
```

落到你项目就是：

```text
生产前端：app.doyouadoreme.online
生产后端：api.doyouadoreme.online

稳定开发前端：app.dev.doyouadoreme.online
稳定开发后端：api.dev.doyouadoreme.online

PR 前端：bug-111.app.dev.doyouadoreme.online
PR 后端：通常不需要暴露；如需要则 bug-111.api.dev.doyouadoreme.online
```

我会明确推荐这个，而不是 `bug-111.app.doyouadoreme.online`。刚才我们讨论 PR 域名时那个方案能用，但从完整环境规划看，`bug-111.app.dev.doyouadoreme.online` 更合理。

原因是：

```text
app / api 表示服务类型
dev 表示环境 namespace
bug-111 表示临时 preview 实例
```

这样语义不会混：

```text
app.doyouadoreme.online              # 生产 app
api.doyouadoreme.online              # 生产 api

app.dev.doyouadoreme.online          # 固定 dev app
api.dev.doyouadoreme.online          # 固定 dev api

bug-111.app.dev.doyouadoreme.online  # bug-111 的 worker preview
bug-222.app.dev.doyouadoreme.online  # bug-222 的 worker preview
```

我不太建议：

```text
bug-111-dev.doyouadoreme.online
bug-111-app.doyouadoreme.online
```

因为它们把多个语义揉进一个 label，后面多服务、多环境时会变难读。

也不太建议只用：

```text
bug-111.dev.doyouadoreme.online
```

因为它看不出来这是前端 app、API、admin、docs，还是别的服务。你现在虽然只有 app/api，但把结构留好很值。

至于主站，一般最佳实践是：

```text
doyouadoreme.online       # 官网、落地页、品牌主页，或者跳转到 app
app.doyouadoreme.online   # 登录后的应用
api.doyouadoreme.online   # API
```

如果你的产品没有营销主页，`doyouadoreme.online` 可以先 301/302 到 `app.doyouadoreme.online`。以后要做官网时再把 root 域拿回来。

最终我给你的定稿是：

```text
Production:
  doyouadoreme.online                  # 官网或跳转 app
  app.doyouadoreme.online              # 生产前端
  api.doyouadoreme.online              # 生产后端

Development:
  app.dev.doyouadoreme.online          # 固定 dev 前端
  api.dev.doyouadoreme.online          # 固定 dev 后端

PR Preview:
  <jira-id>.app.dev.doyouadoreme.online
  # 例如 bug-111.app.dev.doyouadoreme.online
```

后端 PR 环境如果通过前端 Worker 加 header 路由，就不一定需要公开域名。内部统一打：

```text
api.dev.doyouadoreme.online
```

然后 Worker 加：

```text
X-Preview-Id: bug-111
```

这样外部测试人员只看前端 preview URL，后端怎么分流他们无感。

# 环境规划

是的，真实云上架构里我建议 **prod 和 dev 至少部署两套隔离资源**。

最推荐的层级是：

```text
prod:
  prod-vpc
  prod-db
  prod-lambda/api
  prod-worker/app

dev:
  dev-vpc
  dev-db
  dev-lambda/api
  dev-worker/app
  pr-preview-* resources
```

也就是说：

```text
prod 和 dev 隔离
PR preview 挂在 dev 这套环境下面
```

不要每个 PR 都完整起一套 VPC + DB。那样资源成本、创建速度、清理风险都会很难受。PR 环境更适合：

```text
每个 PR:
  独立 Worker
  独立 Lambda 或 Lambda alias/version
  可选独立 schema / database
  共享 dev VPC
  共享 dev Aurora/RDS 实例或集群
```

**我会这样规划**

```text
Production:
  token-query-prod-network
  token-query-prod-db
  token-query-prod-api
  token-query-prod-iam
  app.doyouadoreme.online
  api.doyouadoreme.online

Development:
  token-query-dev-network
  token-query-dev-db
  token-query-dev-api
  token-query-dev-iam
  app.dev.doyouadoreme.online
  api.dev.doyouadoreme.online

PR Preview:
  token-query-pr-bug-111-worker
  token-query-pr-bug-111-lambda
  bug-111.app.dev.doyouadoreme.online
  DB schema: pr_bug_111 或 database: pr_bug_111
  共享 dev VPC / dev DB cluster
```

**数据库这里要稍微讲究**

PR 如果涉及迁移脚本，有三种做法：

1. **共享 dev DB，同一个 schema**
   最省事，但 PR 之间互相污染，迁移冲突多，不推荐。

2. **共享 dev DB cluster，每个 PR 一个 schema/database**
   我推荐第一阶段用这个。  
   例如：

```text
dev_db.public                 # 固定 dev
dev_db.pr_bug_111             # PR preview
dev_db.pr_bug_222
```

PR 关闭时删 schema/database。

3. **每个 PR 一个完整 DB 实例/集群**
   隔离最好，但贵、慢、清理复杂。只有高风险迁移、企业级测试或强隔离要求时再考虑。

**VPC 不建议每个 PR 一套**

VPC、子网、NAT、路由表这些东西创建慢，而且 AWS 资源限制/成本都会上来。最佳做法是：

```text
prod VPC 一套
dev VPC 一套
PR Lambda 挂 dev VPC
```

这样 PR 有自己的计算资源和数据库命名空间，但网络基础设施复用 dev。

所以我的决断是：

```text
prod/dev 两套基础设施：是，需要
每个 PR 完整一套基础设施：不要
每个 PR 独立应用资源 + 独立 DB schema/database：推荐
```

这就是成本、隔离、自动化复杂度之间比较稳的平衡。


# 接入ecs后的规划
对，这种架构下要先分清几个层级：

```text
ECS Cluster
  -> ECS Service
      -> Fargate Task
          -> Docker container
              -> Go app
```

如果做 PR 环境，**通常不复制 ECS Cluster/VPC**，而是复制更下层的“应用运行单元”。

我建议：

```text
prod:
  prod VPC
  prod ECS cluster
  prod Go ECS service
  prod Lambda

dev:
  dev VPC
  dev ECS cluster
  dev Go ECS service
  dev Lambda

PR bug-111:
  共享 dev VPC
  共享 dev ECS cluster
  新建 ECS service: go-app-pr-bug-111
  新建 Fargate tasks，跑 bug-111 对应 Docker image
  新建/更新 Lambda: lambda-pr-bug-111
```

也就是说，PR 级别复制的是：

```text
Lambda
ECS Service
Fargate Task
Docker image version
Cloud Map service registration
可选 DB schema/database
```

不是每个 PR 复制：

```text
VPC
Subnet
NAT
ECS Cluster
Aurora Cluster
```

**Docker 和 Fargate 的关系**

Docker image 是你的 Go 应用构建产物，例如：

```text
token-query-go:bug-111-abc123
```

Fargate 是 AWS 帮你运行这个 Docker container 的无服务器计算平台。你不是“复制 Docker”，而是：

```text
为 PR 构建一个 Docker image
ECS Service 使用这个 image 启动 Fargate Task
```

所以 PR `bug-111` 的 Go 服务可能是：

```text
ECR image:
  token-query-go:bug-111-a1b2c3

ECS service:
  token-query-go-pr-bug-111

Fargate task:
  running token-query-go:bug-111-a1b2c3
```

**Cloud Map 是什么**

Cloud Map 不是 HTTP 的同一层级。它更像“服务发现 / 名字解析”。

比如 Go ECS Service 注册到 Cloud Map：

```text
go-pr-bug-111.service.dev.local
```

Lambda 里配置：

```text
GO_SERVICE_URL=http://go-pr-bug-111.service.dev.local:8080
```

然后 Lambda 访问 Go 服务时还是走 HTTP：

```ts
fetch("http://go-pr-bug-111.service.dev.local:8080/internal/foo")
```

这里的关系是：

```text
Cloud Map：告诉 Lambda “go-pr-bug-111.service.dev.local 对应哪些 task IP”
HTTP：Lambda 真正调用 Go app 的协议
```

所以 Cloud Map 解决的是“我怎么找到这个服务”，HTTP/gRPC 解决的是“我怎么和这个服务通信”。

**PR 路由怎么串起来**

完整链路可以是：

```text
bug-111.app.dev.doyouadoreme.online
  -> Cloudflare Worker: token-query-pr-bug-111
  -> 加 Header: X-Preview-Id: bug-111
  -> API Gateway dev
  -> 路由到 Lambda pr-bug-111
  -> Lambda 通过 Cloud Map 调用 go-app-pr-bug-111
  -> Go app 访问 pr_bug_111 schema/database
```

如果你每个 PR 都有独立 Lambda，那 Lambda 可以直接用环境变量指向对应 Go 服务：

```text
GO_SERVICE_URL=http://go-pr-bug-111.service.dev.local:8080
```

这比 Lambda 运行时再按 header 查路由表更简单。

**我的建议定稿**

PR 环境不要复制整套云基础设施，而是复制应用层资源：

```text
每个 PR 创建：
  Cloudflare Worker
  Lambda
  ECS Service
  Fargate Task
  Cloud Map service name
  DB schema/database

共享 dev：
  VPC
  Subnets
  ECS Cluster
  ECR Repository
  Aurora/RDS Cluster
  API Gateway 或 dev ingress
```

Cloud Map 可以用，但要记住它只是服务发现。Lambda 最终还是通过 `http://cloud-map-name:port` 或 `grpc://cloud-map-name:port` 去访问 Go 应用。



# ECS分层职责
可以，把它想成“调度平台 → 应用声明 → 实际运行实例 → 镜像进程 → 业务代码”这几层。

```text
ECS Cluster
  -> ECS Service
      -> Fargate Task
          -> Docker container
              -> Go app
```

**ECS Cluster**

ECS Cluster 是一个逻辑集群，负责承载和组织一组 ECS workload。

它本身不是你的应用，也不是机器。更像一个命名空间/调度边界：

```text
token-query-dev-cluster
token-query-prod-cluster
```

里面可以跑很多 Service，比如：

```text
go-api-service
worker-service
admin-service
```

为什么要有它：  
因为 AWS 需要一个地方来管理“这些任务属于哪个环境、在哪个调度域里运行、用哪些 capacity provider，比如 Fargate”。prod 和 dev 通常各有一个 cluster，方便隔离和权限管理。

**ECS Service**

ECS Service 是“我要长期运行某个应用”的声明。

它描述：

```text
我要跑哪个 Task Definition
我要保持几个副本
挂在哪些 subnet/security group
是否接负载均衡
失败了要不要自动拉起来
怎么滚动更新
是否注册 Cloud Map
```

比如：

```text
go-app-dev-service
desiredCount = 2
taskDefinition = go-app:42
```

如果一个 Task 崩了，Service 会自动补一个新的。  
如果你发布新镜像，Service 会滚动替换旧 Task。

为什么要有它：  
因为容器不是一次性跑起来就完了。生产服务需要“持续保持运行、自动恢复、滚动发布、服务发现注册”。这些是 Service 管的。

**Fargate Task**

Task 是一次实际运行出来的应用实例。

如果 Service 声明：

```text
desiredCount = 2
```

那 ECS 会启动两个 Task：

```text
task-aaa
task-bbb
```

每个 Task 会拿到自己的：

```text
私网 IP
CPU / memory
ENI 网络接口
运行状态
日志流
```

Fargate 表示这些 Task 不需要你管理 EC2 机器。AWS 自动给你找计算资源来跑它。

为什么要有它：  
Service 是“期望状态”，Task 是“真实运行状态”。你扩容、滚动部署、故障恢复，最终都是在创建/停止 Task。

**Docker container**

Container 是 Task 里面真正启动的容器进程环境。

一个 Task 可以有一个或多个 container。比如：

```text
Go app container
sidecar logging container
proxy container
```

container 由 Docker image 创建：

```text
123456789.dkr.ecr.us-west-2.amazonaws.com/go-app:bug-111-a1b2c3
```

它定义：

```text
启动命令
环境变量
端口
文件系统
依赖库
```

为什么要有它：  
容器把 Go app 和它的运行环境打包起来，保证本地、CI、dev、prod 跑的是同一个东西。

**Go app**

Go app 是你真正写的业务代码。

它在 container 里监听端口，比如：

```text
:8080
```

对外提供 HTTP/gRPC 接口，处理业务逻辑，访问数据库，调用其他服务。

为什么还要单独说它：  
因为云资源只负责“把程序跑起来、暴露出来、保持可用”。真正的请求处理、接口语义、数据库逻辑，都在 Go app 里面。

**为什么要这么分层**

因为每层解决的问题不同：

```text
ECS Cluster:
  这个环境/调度域在哪里？

ECS Service:
  这个应用应该长期保持几个副本，怎么发布，怎么恢复？

Fargate Task:
  当前真实跑着哪些实例？

Docker container:
  实例里具体跑什么镜像、什么进程环境？

Go app:
  业务到底怎么处理请求？
```

用 PR 环境举例：

```text
共享：
  dev ECS Cluster

每个 PR 创建：
  ECS Service: go-app-pr-bug-111
  Task Definition: go-app image bug-111-a1b2c3
  Fargate Task: AWS 自动启动
  Container: 运行这个 image
  Go app: 提供 bug-111 的业务逻辑
```

所以你复制的通常是 Service/Task Definition/image 这层，不复制 Cluster。Cluster 是环境级资源，Service 是应用/版本级资源。
