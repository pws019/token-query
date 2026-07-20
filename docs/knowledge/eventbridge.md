# EventBridge 必知知识

跟 [sns-sqs-dlq.md](sns-sqs-dlq.md) 一样，这份文档是通用 AWS 知识，不绑定项目具体资源，文末结合项目里 Part 7（PR preview 定时对账）的场景举例。

## 一句话理解 EventBridge

**EventBridge 是一个"事件总线"服务，核心工作是把"发生了什么事"路由到"谁该处理这件事"**——但 AWS 把好几个概念都塞进了 "EventBridge" 这个大品牌下面，容易搞混，先把家族成员分清楚：

| 子服务 | 解决的问题 | 触发方式 |
|---|---|---|
| **EventBridge Rules**（配合 Event Bus） | 内容驱动的事件路由——"某种事件发生时，转发给谁" | 按事件内容匹配（Event Pattern） |
| **EventBridge Scheduler** | 纯粹的定时任务——"到点了就触发一次" | 时间驱动（rate/cron/一次性） |
| **EventBridge Pipes** | 把一个事件源直接接到一个目标，中间可选做过滤/转换/富化 | 数据流水线式的点对点连接 |

**控制台左侧导航栏这三个是三个平级的入口，不是一个东西的三个标签页**——这也是我们之前建 Scheduler 时特意提醒过的"别点成 Rules"这个坑的根源：两个入口长得像、都在 EventBridge 这个产品下面，但配置界面和适用场景完全不同。

## EventBridge Rules（事件驱动路由）

- **Event Bus**：事件的"总线"，默认有一个 `default` bus，也可以建自定义 bus。AWS 服务的事件（比如 EC2 状态变化、S3 对象创建）自动进 `default` bus；自己的应用要发事件，用 `PutEvents` API 发到指定的 bus。
- **Event 的标准结构**：一条事件是一段 JSON，核心字段是 `source`（谁发的，比如 `aws.ec2` 或自定义的 `myapp.orders`）、`detail-type`（这条事件的"类型名"，作用上有点像我们之前吐槽过的 `eventName`）、`detail`（具体数据）、还有 `time`/`region`/`account` 等元信息。
- **Rule + Event Pattern**：Rule 定义"什么样的事件我要"，用 Event Pattern（一段 JSON，描述要匹配的字段和值）去匹配总线上流过的事件，匹配上就转发给 Rule 绑定的 Target（可以是 Lambda、SQS、SNS、Step Functions、Kinesis 等，一个 Rule 最多能挂多个 Target）。
- Event Pattern 支持不少匹配语法（精确匹配、前缀匹配 `prefix`、数值范围、`anything-but` 排除匹配等），比字符串相等复杂得多，这是 EventBridge 跟 SNS Filter Policy 类似又更强大的地方。

## EventBridge Scheduler（定时触发，我们已经练过的这个）

- **Schedule**：一个具体的定时任务，两种模式：
  - **Recurring schedule**：`rate(...)` 或 `cron(...)` 表达式，周期性触发
  - **One-time schedule**：指定一个具体时间点，只触发一次，触发完这个 schedule 就完成了，不会反复触发
- **Schedule Group**：Schedule 的分组容器，默认有个 `default` group，方便按项目/用途归类管理，不是必须用。
- **Flexible time window**：可以给 schedule 设置一个"抖动窗口"（比如允许在计划时间后 15 分钟内的任意时刻触发），用来避免大量 schedule 约定在同一秒触发造成"惊群效应"（thundering herd），生产环境如果同类 schedule 很多，这个值得打开。
- **Target 需要执行角色**：Scheduler 触发 Target（比如 Lambda）需要一个有权限 `InvokeFunction` 的 IAM Role，这个角色是 Scheduler 自己扮演去调用你的 Target，不是 Target 自己的执行角色——两个角色概念不要搞混。

## 失败重试和 DLQ——EventBridge 也有，别以为只有 SQS 才有

Rule 的 Target 和 Scheduler 的 Target，调用失败时都有**默认的重试机制**（默认会重试到 24 小时 / 185 次，取决于哪个先到），重试耗尽之后：

- 如果配了 **DLQ（还是一个普通 SQS 队列）**，失败的事件会被送进去，跟我们在 [sns-sqs-dlq.md](sns-sqs-dlq.md) 里讲的 DLQ 是同一个概念、同一套排查思路
- 如果没配 DLQ，事件重试耗尽后**直接丢弃，什么记录都不留**——生产环境的 Rule/Schedule，只要 Target 是关键路径，都应该配上 DLQ，这跟 SNS 订阅要配 DLQ 是一模一样的道理

## 常见误区 / 容易踩的坑

1. **把 Rules 和 Scheduler 搞混** —— 控制台左侧导航栏两个平级入口，长得像但完全是两套东西，点错了地方会发现根本没有你想要的"定时"选项（Rules 里定时是通过一种特殊的 "schedule expression" 类型的 Rule 实现的旧方式，Scheduler 是更新、更推荐的定时专用服务）。
2. **Event Pattern 匹配不上，Rule 静默不触发** —— 没有报错提示，只是这条事件"路过"总线但没被任何 Rule 认领，调试时容易怀疑 Lambda 没触发是权限问题，其实是 Pattern 写错了没匹配上。建议先用 EventBridge 控制台的 "Sample event" / Pattern 测试功能对一下，再上生产。
3. **忘记给 Target 配 DLQ** —— 跟 SNS 一样，默认失败重试耗尽就丢弃，事后想查都查不到。
4. **Scheduler 的执行角色权限给漏了** —— 只给了 Target（比如 Lambda）本身的执行角色权限，忘了给 Scheduler 自己调用这个 Target 所需的 `InvokeFunction` 权限，会导致 Schedule 触发了但 Target 压根没被调用，控制台上能看到调用失败记录。
5. **One-time schedule 触发完以为还会再触发** —— 只会触发一次，触发完状态会变成完成/不再触发，如果需求其实是"重复执行"，用错类型会造成"怎么只跑了一次"的困惑（我们之前专门对比练过这个区别）。

## 跟这个项目相关的例子

Part 7 的第二层兜底方案：用 EventBridge **Scheduler**（不是 Rules，因为这是纯定时任务，不是响应某个事件）每天定时触发一个"对账" Lambda，列出所有 preview 资源，跟当前 open 的 PR 列表比对，把发现的孤儿资源清理任务丢进 SQS 队列。这里要注意：

- 这个 Schedule 需要一个能 `lambda:InvokeFunction` 这个对账 Lambda 的执行角色
- 建议给这个 Schedule 也配一个 DLQ（复用现有的 preview-cleanup 相关的 SNS 通知渠道），万一对账 Lambda 本身调用失败（比如 GitHub API 限流），不能让这次对账"静默漏跑"而没人知道
