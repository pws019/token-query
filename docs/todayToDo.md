# Today's TODO — AWS Synthetics 巡检任务

目标：给生产环境加一个 AWS CloudWatch Synthetics Canary（心跳巡检），先在控制台点点点跑通，再补一版 CDK 实现，纳入 IaC 管理。

## Part 1 — 控制台点点点

- [x] 1. 打开 CloudWatch 控制台 → Application monitoring → Synthetics Canaries → Create canary
- [x] 2. 选择 blueprint：Heartbeat monitoring
- [x] 3. 填写 Name（如 `token-query-api-heartbeat`），Application or endpoint URL 填 `https://api.doyouadoreme.online/health`
  - 用 `/health` 而不是 `/api/health`：`/health` 挂载在 `/api/*` 网关中间件之外，不受 `X-Internal-Proxy-Token` 校验，canary 不用带任何认证头就能探测（见 [app.lambda.ts](../apps/server/src/app.lambda.ts)）
  - 这个探测顺带会打到 Lambda（`token-query-function`），可以当作保活 ping；`/health` 内部还会顺带探测 Go 服务是否可达（`goService: "ok" | "unreachable"`），不需要再单独给 Go 建一个 canary（Go 服务本身没有公网入口，也不存在冷启动，没有保活必要）
- [x] 4. Take screenshots：**不勾选**（目标是 API 而非可视化页面，截图没有诊断价值，只会多花 S3 存储成本）
- [x] 5. Schedule 设置巡检频率（建议 5 分钟一次，间隔太长保不住 Lambda 热身状态）
- [x] 6. Data retention 设置成功/失败数据保留天数
- [x] 7. 选择或新建 canary 专用 IAM role（默认自动创建）
- [x] 8. 确认 Amazon S3 artifact 存储桶（默认自动创建，用于存运行日志）
- [x] 9. （可选）配置 CloudWatch Alarm，失败时告警
- [x] 10. Create canary，等待首次运行，确认状态为 Passed
- [x] 11. 记录这次创建的资源名（canary name / role arn / s3 bucket），供后续写 CDK 时对齐命名
  - name: token-query-api-heartbeat
  - role arn: arn:aws:iam::707605822527:role/service-role/CloudWatchSyntheticsRole-token-query-api-heart-c9d-489ed01ef234
  - s3 bucket: cw-syn-results-707605822527-us-west-2/canary/us-west-2/token-query-api-heartbeat-c9d-489ed01ef234

## 排查笔记：CloudWatch Alarm 用 `Failed` metric 会假报警

Part 2 CDK 里最初给两个 canary 的 Alarm 配的是：

```ts
metricName: "Failed",
statistic: "Sum",
comparisonOperator: "GreaterThanOrEqualToThreshold",
threshold: 1,
treatMissingData: "breaching",
```

部署后 canary 一直 PASSED，Alarm 却一直是 ALARM。查了 `Failed` metric 过去 3 小时的数据点——**0 个**，而 `SuccessPercent` metric 每次运行都稳定发 100.0。

原因：CloudWatch Synthetics 只在 canary **真的失败**时才会发 `Failed` 这个 metric 的数据点，成功时不发（不是发 0，是压根不发）。`treatMissingData: "breaching"` 又把"没数据"当成"触发阈值"处理，于是每次成功（没有 `Failed` 数据点）反而被判定成报警。

修复：改用 `SuccessPercent`（每次运行都会发数据，成功 100 / 失败 0，不存在缺数据的歧义）：

```ts
metricName: "SuccessPercent",
statistic: "Average",
comparisonOperator: "LessThanThreshold",
threshold: 100,
treatMissingData: "breaching",  // 这里保留合理：真没数据=canary 没跑起来，也该报警
```

这也是 AWS 官方文档给 Synthetics canary 配 Alarm 时的推荐 metric，之后新增类似 Alarm 直接照这个抄，不要再用 `Failed`。

## 排查笔记：查看 canary 运行报告的正确方式

`cw-syn-results-707605822527-us-west-2` 是 Synthetics 自动创建的私有 S3 bucket，存放每次 run 的报告 / HAR / 截图。**不要直接在浏览器打开裸的 S3 HTTPS 直链**（形如
`https://cw-syn-results-707605822527-us-west-2.s3.us-west-2.amazonaws.com/canary/...json`），
这种请求没带任何 AWS 签名，桶是私有的，一定会拿到 S3 的

```xml
<Code>AccessDenied</Code>
<Message>Access Denied</Message>
```

不代表 canary 或被巡检的服务有问题。正确查看方式：

- 控制台：CloudWatch → Synthetics Canaries → 对应 canary → 点进具体某次 run → 直接看 Chrome/Firefox 报告面板（控制台用你登录的 IAM 身份读取，不会 AccessDenied）
- CLI：
  ```bash
  aws s3 cp s3://cw-syn-results-707605822527-us-west-2/canary/us-west-2/<canary-name>-<suffix>/<date>/<run>/<browser>/SyntheticsReport-PASSED.json - --region us-west-2
  ```
  （用本地配置好的 AWS 凭证走 `s3://` 协议，而不是裸 HTTPS URL）

## 排查笔记：API canary 的响应体断言 + report/logging 配置区别

### 为什么从 Heartbeat（page-load）换成 API canary 脚本

默认 Heartbeat blueprint（`pageLoadBlueprint`）只用无头浏览器导航到 URL，检查 HTTP 状态码是 2xx/3xx 就算 PASSED，**不解析响应体**。而 `/health` 被设计成即使 `goService: "unreachable"` 也返回 200（非致命降级），导致"Lambda 正常但 Go 挂了"和"完全健康"在 Heartbeat 模式下无法区分，两者都显示 PASSED。

解决方式：把这个 canary 的脚本换成 **API canary** 风格（`synthetics.executeHttpStep('verifyApiHealth', requestOptions, validateSuccessful, stepConfig)`），在 `validateSuccessful` 回调里手动 `JSON.parse(responseBody)`，分别断言：
- `body.ok === true`
- `body.goService === 'ok'`

断言失败时用 `reject(new Error('具体原因'))`，这个错误信息会直接出现在这次 run 的 `failureReason` 里，一眼就能看出是响应码错误、JSON 格式错误、Lambda 自身不健康、还是 Go 服务不可达，四种情况不再混在一起。

### `report` vs `logging` 配置的区别（两处都要开才能真正"看到"响应体）

canary 脚本里 `syntheticsConfiguration.setConfig({...})` 分两块，容易搞混：

| | `report` | `logging` |
|---|---|---|
| 存到哪 | S3 artifact（`HttpRequestsReport.json` / HAR，控制台 Reports 页渲染的就是这个） | CloudWatch Logs（`/aws/lambda/cwsyn-...` 日志组，Logs 标签页那些行） |
| 用途 | 事后翻查这次 run 具体请求/响应长什么样 | 实时查看/搜索，也是给日后配 metric filter（比如抓 `goService":"unreachable"` 单独告警）用的 |
| 关键字段 | `includeResponseBody` / `includeResponseHeaders`（默认 false，得手动改成 true） | `logResponseBody` / `logResponse`（同样默认 false） |

**两个都得单独设成 `true`**，只改一个不够——只开 `report.includeResponseBody` 但没开 `logging.logResponseBody`，CloudWatch Logs 里还是看不到 body；反过来同理。之前遇到过控制台 `HttpRequestsReport.json` 里 `body` 是空字符串、`headers` 显示 `"Not enabled"` 的情况，就是因为创建时这两块的 body 相关开关都还是 false，改成 true 之后重新跑（用 **Start Dry Run** 手动触发一次，不用等定时调度，也不会误触发 Alarm）就能在控制台看到真实响应体了。

### 关于 S3 直链 AccessDenied 的踩坑，见下一节。

## Part 2 - cdk部署版本

设计决策：不再用"一个 canary 顺带探测两个服务"的复合方案，改成 **Lambda 和 Go 各一个独立 canary**，各自独立断言、独立 Alarm——出问题时能立刻从告警名字知道是 Lambda 挂了还是 Go 挂了，不用再翻 `failureReason` 判断。

- [x] 1. 确认 `aws-cdk-lib` 版本是否包含 `aws-synthetics` 模块（已确认 `2.261.0`，本仓库统一风格用 L1 `CfnCanary` 而不是 L2 `Canary` construct，跟其他 stack 一致）
- [x] 2. 新建 `infra/cdk/lib/monitoring-stack.ts`，接入 `bin/token-query.ts` 的 `CDK_STACK_SCOPE=monitoring`
- [x] 3. 拆分成两个独立 canary
  - [x] 3.1 `token-query-api-heartbeat`（Lambda）：只断言 `body.ok === true`，去掉 `goService` 断言——Lambda 自身健康与否不该被 Go 的状态污染
  - [x] 3.2 新增 `token-query-go-heartbeat`（Go）：直接探测 `http://go.token-query.internal:8080/health`，断言 `body.ok === true`
  - [x] 3.3 Go canary 用独立安全组，并对 foundation 导出的 `go-security-group-id` 补一条入站放行规则（tcp/8080，来源是这个新安全组）
  - [x] 3.4 两个 canary 各自独立 IAM 执行角色 + 独立 CloudWatch Alarm（`token-query-api-heartbeat-failed` / `token-query-go-heartbeat-failed`）
- [x] 4. `cdk synth` 检查模板渲染正确、没有语法/引用错误
- [x] 5. 删除 Part 1 手工创建的 canary（已确认删除，清掉同名资源冲突）
- [x] 6. `cdk diff` / `cdk deploy` 部署 monitoring stack
- [x] 7. 验证两个 canary 都跑出 PASSED，各自的失败信息互不影响
  - `token-query-api-heartbeat`（Lambda）首次运行 PASSED
  - `token-query-go-heartbeat`（Go）首次运行 PASSED（证明新加的安全组入站规则生效，canary 能从 VPC 内部连通 `go.token-query.internal:8080`）
- [x] 8. 更新 `docs/cdk-deploy-commands.md`，补充 monitoring stack 的部署说明

## Part 3 — SNS / SQS / 死信队列操练（业务无关）

目标：在正式往项目里引入 SNS/SQS/DLQ 之前，先在控制台/CLI 里独立操练一遍，摸清楚这几个产品的基本行为——**故意跟 token-query 业务完全无关**，就像学一个新框架先写个 todolist 增删改查一样，练完这部分资源直接删掉，不牵扯"谁是 source of truth"的问题。参考 [docs/knowledge/sns-sqs-dlq.md](knowledge/sns-sqs-dlq.md)。

- [x] 1. 建 SNS Topic + Email 订阅 + 手动 Publish 一条消息
  - 打开 [SNS 控制台](https://console.aws.amazon.com/sns) → 左侧导航 **Topics** → 右上角 **Create topic**
  - Type 选 **Standard**，Name 填 `learning-sns-demo`，其他区域（Encryption/Access policy/Delivery retry 等）全部保持默认 → 拉到最下面点 **Create topic**
  - 创建成功后会自动跳到这个 Topic 的详情页 → 点 **Create subscription**
  - Protocol 选 **Email**，Endpoint 填你自己的邮箱 → **Create subscription**
  - 去邮箱查收一封主题类似 "AWS Notification - Subscription Confirmation" 的邮件，点里面的 **Confirm subscription** 链接（不点这个订阅永远是 Pending，收不到后续消息）
  - 回到 Topic 详情页 → 右上角 **Publish message** → Message body 随便写点内容 → **Publish message**
  - 回邮箱确认收到这条消息
- [x] 2. 建 SQS 队列，手动收发消息，观察 Visibility Timeout
  - 打开 [SQS 控制台](https://console.aws.amazon.com/sqs) → **Create queue**
  - Type 选 **Standard**，Name 填 `learning-sqs-demo`，Configuration 里的 Visibility timeout 可以先改成 **60 秒**方便等待（默认 30 秒也行），其他保持默认 → **Create queue**
  - 进入队列详情页 → 右上角 **Send and receive messages** 按钮，会打开一个左右分栏的页面
  - 左边 "Send message" 面板：Message body 随便写点内容 → **Send message**，重复发个 2-3 条
  - 右边 "Receive messages" 面板：点 **Poll for messages** → 出现消息列表后点开某一条，能看到 `ApproximateReceiveCount` 等属性 —— **先不要点 Delete**
  - 等超过你设的 Visibility timeout 时间（比如等 65 秒）之后，再点一次 **Poll for messages**，应该还能重新拉到刚才那条消息，且 `ApproximateReceiveCount` 变成了 2 —— 这就是"没删除就会被重新投递"的实际效果
- [x] 3. 把 SQS 队列订阅到 SNS Topic 下，practice 一次 fan-out
  - 回到这个 SQS 队列详情页 → 找到 **SNS subscriptions** 标签页（或者叫 "Subscribe to Amazon SNS topic" 的按钮，具体控制台版本可能措辞略有不同）
  - 选择第 1 步建的 `learning-sns-demo` Topic → 确认订阅（控制台会自动帮你把队列的 Access Policy 配好，不用手动改 IAM）
  - 回到 SNS 那个 Topic 详情页 → 再次 **Publish message** 发一条新内容
  - 回邮箱确认收到 + 回 SQS 队列 **Send and receive messages** → **Poll for messages**，确认同一条消息也出现在队列里 —— 一次 Publish，两边都收到
- [x] 4. 给队列配 DLQ + Redrive Policy，故意触发死信
  - 再建一个队列 `learning-sqs-demo-dlq`（步骤同第 2 步的 Create queue，其他配置随意）
  - 回到主队列 `learning-sqs-demo` 详情页 → 右上角 **Edit** → 往下滚找到 **Dead-letter queue** 这个区域
  - 打开 Enabled 开关 → Choose queue 选 `learning-sqs-demo-dlq` → **Maximum receives** 填 `2`（方便快速触发）→ 拉到最下面 **Save**
  - 回到主队列 **Send and receive messages** 页面，发一条新消息，然后反复"Poll for messages → 不删除 → 等 Visibility Timeout 过期 → 再 Poll"这个动作 3 次左右（超过 Maximum receives=2 这个次数）
  - 去 `learning-sqs-demo-dlq` 这个队列的详情页，看 **Messages available** 数量是不是变成 1 了——变了就说明死信转移生效了
- [x] 5. 练一次 "Start DLQ redrive" 人工恢复
  - 打开 `learning-sqs-demo-dlq` 队列详情页 → 找到 **Start DLQ redrive** 按钮（一般跟 "Send and receive messages" 按钮在同一行）
  - Redrive 目标选 **To source queue(s)**（送回原队列），其他速率相关配置保持默认 → **DLQ redrive**
  - 等一下，确认 DLQ 里的消息数量变回 0，主队列 `learning-sqs-demo` 的 Messages available 数量 +1
- [x] 6. 练完清理测试资源
  - SQS 控制台 → 分别勾选 `learning-sqs-demo` 和 `learning-sqs-demo-dlq` → **Delete**（会提示确认，输入 delete 确认）
  - SNS 控制台 → 打开 `learning-sns-demo` Topic 详情页 → **Delete**（会连带删除这个 Topic 下的订阅，不用单独去删订阅）

## Part 4 — SNS 告警通知（CDK 管理）

目标：Part 3 练熟悉之后，用 CDK 把真正给项目用的 SNS Topic 落地，现在的 Alarm 触发了没人知道，得有个真正能通知到人的渠道。

- [ ] 1. 在 `infra/cdk/lib/monitoring-stack.ts` 里新建一个共用的 SNS Topic（例如 `token-query-ops-alerts`），后续所有告警都往这一个 Topic 发，不用每类告警各建一个
- [ ] 2. 给 Topic 加至少一个 Email 订阅（CDK 里订阅创建后依然要去邮箱点确认链接，这一步是异步的、CDK 部署完不代表订阅已生效）
- [ ] 3. 把 `token-query-api-heartbeat-failed` / `token-query-go-heartbeat-failed` 这两个 Alarm 的 `alarmActions` 指向这个 Topic
- [ ] 4. `cdk diff` / `cdk deploy`
- [ ] 5. 手动把某个 canary 停掉（`stop-canary`）或者临时改坏 `HealthCheckUrl` 参数，触发一次真实的 ALARM，确认真的收到邮件通知，再恢复
- [ ] 6. 后续 CodeBuild（`token-query-go-build` / `token-query-db-migrate`）失败通知、GitHub Actions 部署失败通知，评估要不要也接到同一个 Topic（不在本次范围，先记录，之后再排期）

## Part 5 — EventBridge Scheduler 操练（业务无关）

目标：Part 7 的第二层兜底（定时对账）需要用到 EventBridge Scheduler，同样先业务无关地练一遍再落地。

- [ ] 1. 先建一个测试用的目标 Lambda
  - 打开 [Lambda 控制台](https://console.aws.amazon.com/lambda) → **Create function**
  - 选 **Author from scratch**，Function name 填 `learning-eventbridge-demo`，Runtime 选 Node.js（默认最新版即可）→ **Create function**
  - 不用改任何代码——Lambda 每次被调用，不管你代码里有没有写 `console.log`，都会自动产生 START/END/REPORT 这几行日志，足够用来验证"有没有被触发"
- [ ] 2. 建一个每 5 分钟循环触发的 Schedule
  - 打开 [EventBridge 控制台](https://console.aws.amazon.com/events) → 左侧导航栏找 **Scheduler** 分组下的 **Schedules**（跟 EventBridge 的 "Rules" 是两个不同东西，不要点错到 Rules 那边去）→ **Create schedule**
  - Schedule name 填 `learning-scheduler-demo`
  - **Occurrence** 选 **Recurring schedule**
  - **Schedule type** 选 **Rate-based schedule**，填 `5` + `minutes`
  - Flexible time window 保持默认（Off，方便观察准确的触发时间点）→ **Next**
  - **Select target** 页面：Target 类型下拉找 **AWS Lambda → Invoke**，Lambda function 选刚建的 `learning-eventbridge-demo` → **Next**
  - Settings 页面（重试策略等）保持默认 → **Next** → **Create schedule**
- [ ] 3. 等 5-10 分钟，去 CloudWatch Logs 确认按预期频率触发
  - 回 Lambda 控制台 → 打开 `learning-eventbridge-demo` 函数 → **Monitor** 标签页 → **View CloudWatch logs** 按钮
  - 打开对应的 Log group，应该能看到每隔 5 分钟左右出现一次新的 Log stream / 一组 START-END-REPORT 日志
- [ ] 4. 练一下 one-time schedule，对比跟 recurring 的区别
  - 回 EventBridge Scheduler → 再 **Create schedule** 一次，Name 换一个比如 `learning-scheduler-once`
  - **Occurrence** 这次选 **One-time schedule**，Date/time 选当前时间往后推 3-5 分钟
  - Target 同样选 `learning-eventbridge-demo` → 一路 Next 到 **Create schedule**
  - 等到设定的时间点，确认 Lambda 被调用了一次；过了这个时间点之后再回 Schedules 列表看这个 schedule 的状态（应该会显示成已完成/不再触发，不会像 recurring 那样反复跑）
- [ ] 5. 练完删掉测试 Schedule 和测试 Lambda
  - EventBridge Scheduler → Schedules 列表 → 勾选 `learning-scheduler-demo` 和 `learning-scheduler-once` → **Delete**
  - Lambda 控制台 → 打开 `learning-eventbridge-demo` → **Actions → Delete function**

## Part 6 — PR Preview 清理失败兜底（SQS + DLQ，CDK 管理）

目标：`cleanup-lambda-preview.yml` / `cleanup-go-preview.yml` 现在跑 `cdk destroy` 失败了只是显示一次红叉，没人特意去看，preview 资源可能一直挂着持续计费。改造成失败自动进重试队列，重试耗尽进 DLQ 并告警。全部用 CDK 管理（新建 `infra/cdk/lib/preview-cleanup-stack.ts`，跟 monitoring-stack 分开，职责不同）。

设计（细化后）：
1. GitHub Actions 里现有的 `cdk destroy` 步骤**保持不变**，作为第一次尝试，不引入额外复杂度
2. 只有这一步**失败**时（`if: failure()`），加一个步骤把 `{ stackName, previewId }` 发送到新建的 SQS 队列 `token-query-preview-cleanup-queue`
3. 新建 Lambda 消费者（SQS 触发，Event Source Mapping），收到消息后直接调 `cloudformation:DeleteStack`（不在 Lambda 里跑 CDK CLI，太重；直接调 CFN API 就是 `cdk destroy` 底层做的事）
4. 队列配 Redrive Policy，`maxReceiveCount` 设小一点（比如 3，方便验证也够用），配套 DLQ `token-query-preview-cleanup-dlq`
5. DLQ 配 Alarm：`ApproximateNumberOfMessagesVisible > 0`，**`treatMissingData: notBreaching`**（注意这里跟 Part 2 那次坑的方向是反的——DLQ 长期没消息是正常状态，不能当成"缺数据=报警"）
6. DLQ Alarm 挂到 Part 4 建的同一个 SNS Topic 上，复用告警渠道，不用另建

验证策略（不用真的等 `cdk destroy` 自然失败，也不要去手动破坏真实 preview 资源）：
- [ ] 1. 新建 SQS 队列 + DLQ + Redrive Policy（CDK）
- [ ] 2. 新建消费者 Lambda，实现「收到消息 → 校验 payload → 调 DeleteStack → 成功则让 SQS 自动删除消息」
- [ ] 3. **验证测试 A（推荐，完全不碰真实资源）**：手动 `aws sqs send-message` 发一条缺字段/格式错误的消息，让消费者的输入校验直接抛错，观察 `ReceiveCount` 随 Visibility Timeout 重试递增，最终落进 DLQ
- [ ] 4. **验证测试 B（可选，更贴近真实失败）**：找一个已经用不上的测试 preview stack，临时开启 Termination Protection（`aws cloudformation update-termination-protection`），发一条指向它的消息，观察 `DeleteStack` 确定性失败、重试、进 DLQ，验证完记得关掉 Termination Protection
- [ ] 5. 确认 DLQ 有消息时 Alarm 触发、Part 4 的邮箱收到通知
- [ ] 6. 把 `cleanup-lambda-preview.yml` / `cleanup-go-preview.yml` 的失败分支接入实际发送 SQS 消息的步骤
- [ ] 7. 更新 `docs/cdk-deploy-commands.md`，补充这部分资源的部署/清理说明

## Part 7 — Preview 环境被遗忘的问题

问题确认：三个 cleanup workflow（`cleanup-lambda-preview.yml` / `cleanup-go-preview.yml` / `cleanup-worker-preview.yml`）各自按 PR diff 的 `paths` 过滤来决定要不要在 PR 关闭时触发，完全不管"这个 PR 到底手工部署过哪些 preview 环境"。而 `deploy-worker-preview.yml` 支持 `workflow_dispatch` 手动触发——如果一个 PR 只改了 `apps/server/**`，又手动部署了一份 Worker preview 做前端验证，PR 关闭时 `cleanup-worker-preview.yml` 因为路径不匹配根本不会跑，这个 Worker 就被遗忘了。

**第一层修复（已完成）**：去掉三个 cleanup workflow 里 `pull_request: closed` 触发的 `paths` 过滤条件，让它们在 PR 关闭时**无条件全部跑一遍**。每个 cleanup 步骤本身已经有"资源不存在就 skip"的判断，无条件跑只是多花几秒钟，能直接堵住这个遗忘漏洞。

- [x] 1. `cleanup-lambda-preview.yml` 去掉 `paths` 过滤
- [x] 2. `cleanup-go-preview.yml` 去掉 `paths` 过滤
- [x] 3. `cleanup-worker-preview.yml` 去掉 `paths` 过滤

**第二层兜底（依赖 Part 5 操练完成后再落地）**：定时对账（reconciliation）——EventBridge Scheduler 定期（比如每天一次）触发 Lambda，列出所有 `token-query-preview-*` CFN 栈和 `token-query-pr-*` Cloudflare Worker，跟当前仍然 open 的 PR 列表比对，凡是对应 PR 已关闭/合并但资源还在的，就把清理任务塞进 Part 6 的 SQS 队列——复用同一套 SQS+DLQ+Alarm 机制，不用另起一套。

- [ ] 1. 完成 Part 5 的 EventBridge Scheduler 操练
- [ ] 2. 新建对账 Lambda：列出 CFN 栈 + Cloudflare Worker，比对 GitHub open PR 列表（需要 GitHub token 权限）
- [ ] 3. 用 EventBridge Scheduler 定时触发这个 Lambda（比如每天一次）
- [ ] 4. 对账发现的孤儿资源，发消息到 Part 6 的 `token-query-preview-cleanup-queue`，复用同一套清理+DLQ+告警链路
- [ ] 5. 手动制造一个"孤儿资源"场景验证（比如手动 workflow_dispatch 部署一个 Worker preview，然后跳过 cleanup 直接看对账任务能不能在下一次调度里发现并清理）

## 今天的工时预估

涉及 CDK/Lambda 代码的部分，代码由我（Claude）直接生成和部署，你的投入是 **review 代码 + 验收实际效果**（看 diff、确认部署结果、跑验证测试），不是自己写代码的时间；操练类（Part 3/5）是你自己在控制台动手，按实际动手时间估。新增「实际耗时」一栏，做完之后自己填。

| Part | 内容 | 你的角色 | 预估工时（你的投入） | 实际耗时 |
|---|---|---|---|---|
| Part 1 | 控制台点点点建 canary | 动手操练 | 已完成 | |
| Part 2 | CDK 落地两个独立 canary | Review + 验收 | 已完成 | |
| Part 3 | SNS/SQS/DLQ 操练（业务无关） | 动手操练 | 45–60 分钟 | 70分钟 |
| Part 4 | SNS 告警通知落地（CDK） | Review + 验收 | 10–15 分钟（看 diff、确认收到测试告警邮件） | 01:30 |
| Part 5 | EventBridge Scheduler 操练（业务无关） | 动手操练 | 30–45 分钟 | |
| Part 6 | SQS+DLQ 兜底落地（CDK，含消费者 Lambda + workflow 改造 + 双验证） | Review + 验收 | 30–45 分钟（review Lambda/IAM 代码、确认两种验证测试结果、确认 workflow 改动） | |
| Part 7 第一层 | 去掉 3 个 cleanup workflow 的 paths 过滤 | Review | 已完成 | |
| Part 7 第二层 | 定时对账 Lambda + EventBridge Scheduler | Review + 验收 | 20–30 分钟（review 对账逻辑、确认孤儿资源场景验证结果） | |
| **合计（Part 3、5 操练 + Part 4、6、7 第二层 review）** | | | **约 2.5–3.5 小时** | |

备注：操练部分（Part 3/5）之前 Part 1 的实际耗时比预估长不少（来回排查 AccessDenied、report/logging 踩坑），这次 SNS/SQS/EventBridge 概念更简单，但仍可能有没预料到的坑；CDK 部分因为代码由我生成，你的时间主要花在等部署、跑验证、看结果对不对，具体多久取决于验证过程是否顺利。实际耗时填完之后，我们可以对比一下"操练型工时"和"review 型工时"这两种预估方式哪个更准。
