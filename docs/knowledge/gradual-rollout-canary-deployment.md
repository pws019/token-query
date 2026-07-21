# 灰度上线（Canary Deployment）必知知识

这份文档记录一次关于"Worker/Lambda/Go 三个组件怎么做灰度上线"的讨论，不绑定具体实施代码（还没有落地任何一个方案），后续真正动手实现时再补充对应的 CDK/workflow 改动。

## 先澄清一个容易搞混的概念："Synthetics Canary" ≠ "灰度发布"

这个项目里已经建好的 CloudWatch Synthetics Canary（`token-query-api-heartbeat` / `token-query-go-heartbeat`，见 [preview-cleanup-flow.md](preview-cleanup-flow.md) 和 `docs/todayToDo.md` Part 1/2）是**监控/探活工具**——定时发一次请求，检查服务健不健康，跟"新版本上线时把流量从 10% 慢慢放到 100%"这件事没有任何关系。

AWS 里没有一个叫"API Canary"的统一灰度发布模块——Lambda、ECS、CDN/边缘各自有自己的灰度机制，服务类型不同，机制完全不是一套东西，容易被"canary"这个词的字面意思搞混（两者都叫 canary，但一个是"金丝雀探测健康"，一个是"金丝雀先吃一小口流量试毒"，取的是同一个隐喻但用在了不同场景）。

## 三个组件各自的灰度机制

### Lambda（后端 API）—— AWS 原生支持最成熟

- **Alias + 加权路由**：一个 Lambda Alias 可以同时指向两个 Version，按百分比分流（比如 90% 老版本 / 10% 新版本）
- **CodeDeploy for Lambda**：在 Alias 加权之上再包一层自动化，内置几种部署策略：
  - `Canary10Percent5Minutes`：先切 10% 流量，观察 5 分钟，没问题再切到 100%
  - `Linear10PercentEvery1Minute`：每分钟递增 10%
  - `AllAtOnce`：（对照组，直接全量，无灰度）
  - **可以挂 CloudWatch Alarm 做自动回滚**——这一点可以直接复用项目里已经建好的 `token-query-api-heartbeat-failed` 这个 Alarm（[monitoring-stack.ts](../../infra/cdk/lib/monitoring-stack.ts)），新版本如果把这个 Alarm 触发了，CodeDeploy 自动回滚到旧版本，不用人工介入

**限制**：项目现在用的是 API Gateway **HTTP API**（`apigatewayv2`，见 [api-stack.ts](../../infra/cdk/lib/api-stack.ts)），不是 REST API v1——只有 REST API 才支持 API Gateway 自己的 canary stage 功能，HTTP API 没有这个能力。所以 Lambda 灰度只能走"Alias 加权 + CodeDeploy"这条路，指望不上 API Gateway 层面做分流。

**Version / Alias / Application / Deployment Group 这几个概念怎么串起来、一次部署背后的状态机是什么**：动手操练过一遍后专门整理了概念详解 + 层次图，见 [lambda-codedeploy-canary.md](lambda-codedeploy-canary.md)。

### Go（ECS/Fargate）—— 目前没有 ALB，是三块里最麻烦的

ECS 传统灰度方案是 **CodeDeploy 的 ECS Blue/Green 部署**，但这套机制**依赖 Application Load Balancer 的加权 Target Group**做流量切换。项目现在 Go 服务是纯内网 **Cloud Map** 服务发现（[foundation-stack.ts](../../infra/cdk/lib/foundation-stack.ts)、[go-stack.ts](../../infra/cdk/lib/go-stack.ts)），完全没有 ALB——要上 Blue/Green 这套就得先新增一层 ALB，属于新增基础设施，不是小改动。

**完整的 ALB 接入方案（要改哪些资源、操练计划、实际落地步骤）**：已经整理成单独一份计划文档，见 [go-alb-canary-deployment.md](go-alb-canary-deployment.md)——目前只是计划，还没有开始执行任何一步。

更轻量的替代方案：**AWS Cloud Map 加权路由**——Cloud Map 的服务发现实例支持配权重，`DiscoverInstances` 返回结果时能按权重分配，理论上不用引入 ALB 就能做简单的按比例分流。但这个机制比较原始，没有 CodeDeploy 那种"自动观察 Alarm、自动回滚"的能力，得自己写控制逻辑。

#### 接入 ALB 之后的链路会是什么样（讨论记录，暂不实施）

现在（没有 ALB）：`Lambda ──(Cloud Map DNS)──▶ 直接解析到某个 Go 任务 ENI IP ──▶ Go 任务`，Cloud Map 做的是客户端 DNS 负载均衡，没有中间代理层。

接入 ALB 之后：`Lambda ──(内部 ALB 域名)──▶ Internal ALB ──(按 CodeDeploy 权重分流)──▶ Blue/Green 两个 Target Group ──▶ 对应版本的 Go 任务`。

- **ALB 必须放在 VPC 里**，具体是 **Internal（非 Internet-facing）** 类型，直接用现有的两个私有子网，不需要新建子网——因为 Go 服务从来没对公网提供过服务
- Target Group 类型是 `ip`（Fargate awsvpc 模式，每个任务独立 ENI），需要 Blue/Green 两个，这是 CodeDeploy ECS Blue/Green 部署类型的硬性要求
- 安全组要多绕一层：`Lambda SG → ALB SG（新增）→ Go SG`，不再是 Lambda SG 直接打 Go SG
- Cloud Map 的"客户端 DNS 负载均衡"这个角色被 ALB 的"主动做健康检查+流量分配"取代

**成本结论（这也是暂不实施的主要原因）**：Internal ALB 按小时收费，约 **$0.0225/小时 ≈ $16-17/月**（不管有没有流量都要付），这是在项目现有的固定成本（NAT Gateway ~$33/月、Aurora Serverless v2 最低 ~$22/月、Go Fargate 任务、两个 Synthetics canary ~$20/月）基础上再加 15-20%。对一个**学习项目**、Go 服务更新也不频繁的场景，这笔钱的性价比不高——先用零成本的 Cloud Map 加权路由理解"灰度"这个概念就够了，等以后这个项目真有生产流量、Go 更新频繁到需要平滑切换时，再评估要不要专门为灰度引入 ALB。

### Cloudflare Worker（前端）—— 反而是现成度最高的一个

Cloudflare Workers 自带 **Gradual Deployments**（渐进式部署）：部署新版本时可以直接指定这个版本先吃多少百分比流量，之后在 Dashboard 或用 Wrangler 命令逐步调整比例，Cloudflare 还会基于错误率做自动回滚判断。三块组件里**唯一不需要额外搭基础设施**的一个，因为项目前端本来就托管在 Cloudflare 上。

## Worker 具体实施方案（学习/记录用，暂不落地——账号是 Free plan）

**前提条件：Gradual Deployments 是 Cloudflare Workers Paid plan 才有的功能，Free plan 用不了。** 这个项目的 Cloudflare 账号目前是 Free plan，所以这套方案暂时没法真的实施，先把思路记下来，以后升级套餐了再回来落地。

### 核心机制：Version 和 Deployment 是两个概念

Cloudflare 把 Worker 的部署模型拆成了两层：

- **Version（版本）**：`wrangler versions upload` 上传一份代码，生成一个不可变的 Version，**但不会有任何流量打到它**——纯粹是"准备好了，还没上线"
- **Deployment（部署）**：`wrangler versions deploy` 决定"线上流量现在怎么在多个 Version 之间分配"，可以是 `100% 新版本`（等同于以前的 `wrangler deploy`），也可以是 `10% 新版本 + 90% 老版本` 这种切分

项目现在 [deploy-worker.yml](../../.github/workflows/deploy-worker.yml) 用的是老的 `wrangler deploy`，一步到位直接 100% 切过去，没有中间态。要上灰度，得改成这两步分开。

### 改造思路（三步）

```bash
# 第一步：CI 只上传 Version，不直接切流量，线上还是 100% 老版本
wrangler versions upload --config=apps/web/wrangler.generated.jsonc --message "commit ${SHORT_SHA}"

# 第二步：切一小部分流量观察
wrangler versions deploy <新版本ID>@10 <老版本ID>@90 --config=...

# 第三步：确认没问题后逐步放量到 100%
wrangler versions deploy <新版本ID>@100 --config=...
```

### 关键决策点：第二、三步谁触发、怎么判断"没问题"

Cloudflare 不像 AWS CodeDeploy 那样自带"自动观察指标、自动推进百分比"的控制器，这部分要自己搭。两个档位：

- **方案 A（先做这个，够用）**：CI 推送时自动完成"上传 + 切 10%"，人工看一眼 Cloudflare Dashboard 的错误率图表（或者手动跑一下前端）确认没问题，再手动跑一个 `workflow_dispatch` workflow 把比例推到 100%。简单、可控，不需要额外基础设施。
- **方案 B（以后升级用）**：写个定时任务（类似 Part 7 的对账 Lambda），每隔几分钟自动把百分比往上推，同时盯着一个专门探测前端页面的健康信号，异常就自动把流量打回 100% 老版本。更接近 AWS CodeDeploy 的自动化程度，但工作量明显更大。

### 一个容易被忽略的坑：Session Affinity

灰度期间，同一个用户的连续请求默认可能落在不同版本上，不是"锁定"某个用户始终吃同一个版本。Cloudflare 提供了 sticky session 机制（靠 cookie）能让同一个浏览器在整个灰度窗口期内固定吃同一个版本，避免"这次请求是新版本渲染的页面，下一次 API 调用又是老版本处理"这种前后端契约不一致的情况。如果新老版本之间有 API 字段变化，这个必须开。

## 对比小结

| 组件 | 方案 | 成熟度 | 额外基础设施 | 自动回滚 |
|---|---|---|---|---|
| Worker | Cloudflare Gradual Deployments | 高，原生 | 不需要 | 有（Cloudflare 自己判断错误率） |
| Lambda | Alias + CodeDeploy Canary | 高，原生 | 不需要 | 有（挂现有 CloudWatch Alarm） |
| Go/ECS | Cloud Map 加权路由 | 中，比较原始 | 不需要 | 无，需自己写逻辑 |
| Go/ECS | ALB + CodeDeploy Blue/Green | 高，原生 | 需要新增 ALB | 有 |

## 建议的落地优先级

从 **Lambda** 开始最划算：机制最成熟，而且能直接复用项目里已经建好的 Alarm + SNS 通知链路（[preview-cleanup-flow.md](preview-cleanup-flow.md) 里同一套 `token-query-ops-alerts` Topic）做自动回滚判断，不用另起一套监控。Go 这块因为没有 ALB，成本最高，可以放到后面再评估要不要专门为灰度引入 ALB，还是先用 Cloud Map 加权凑合。

## 还没做的部分

这份文档目前只是讨论/方案对比，三个组件都还没有实际动手实现灰度机制：

- **Worker**：方案已经想清楚了，但账号是 Free plan，Gradual Deployments 用不了，暂时卡住——等升级到 Paid plan 再回来落地
- **Lambda / Go**：还没细化到具体实施步骤，后续真正落地时（CDK 加 Alias/CodeDeploy 配置、workflow 改造等）再回来补充具体代码和验证步骤，参考 Part 6/7 那种"设计 → 代码 → 部署 → 验证"的记录方式
