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
