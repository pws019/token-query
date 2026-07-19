# Today's TODO — AWS Synthetics 巡检任务

目标：给生产环境加一个 AWS CloudWatch Synthetics Canary（心跳巡检），先在控制台点点点跑通，再补一版 CDK 实现，纳入 IaC 管理。

## Part 1 — 控制台点点点

- [ ] 1. 打开 CloudWatch 控制台 → Application monitoring → Synthetics Canaries → Create canary
- [ ] 2. 选择 blueprint：Heartbeat monitoring
- [ ] 3. 填写 Name（如 `token-query-api-heartbeat`），Application or endpoint URL 填 `https://api.doyouadoreme.online/health`
  - 用 `/health` 而不是 `/api/health`：`/health` 挂载在 `/api/*` 网关中间件之外，不受 `X-Internal-Proxy-Token` 校验，canary 不用带任何认证头就能探测（见 [app.lambda.ts](../apps/server/src/app.lambda.ts)）
  - 这个探测顺带会打到 Lambda（`token-query-function`），可以当作保活 ping；`/health` 内部还会顺带探测 Go 服务是否可达（`goService: "ok" | "unreachable"`），不需要再单独给 Go 建一个 canary（Go 服务本身没有公网入口，也不存在冷启动，没有保活必要）
- [ ] 4. Take screenshots：**不勾选**（目标是 API 而非可视化页面，截图没有诊断价值，只会多花 S3 存储成本）
- [ ] 5. Schedule 设置巡检频率（建议 5 分钟一次，间隔太长保不住 Lambda 热身状态）
- [ ] 6. Data retention 设置成功/失败数据保留天数
- [ ] 7. 选择或新建 canary 专用 IAM role（默认自动创建）
- [ ] 8. 确认 Amazon S3 artifact 存储桶（默认自动创建，用于存运行日志）
- [ ] 9. （可选）配置 CloudWatch Alarm，失败时告警
- [ ] 10. Create canary，等待首次运行，确认状态为 Passed
- [ ] 11. 记录这次创建的资源名（canary name / role arn / s3 bucket），供后续写 CDK 时对齐命名

## Part 2 — CDK 版本落地

- [ ] 1. 确认 `aws-cdk-lib` 版本是否包含稳定的 `aws-synthetics` 模块（当前 `^2.224.0` 应该已支持 L2 `Canary` construct）
- [ ] 2. 在 `infra/cdk/lib` 下新增/选定 stack 承载 canary 资源（评估是否放进 `foundation-stack.ts` 还是新建 `monitoring-stack.ts`）
- [ ] 3. 用 CDK 复刻控制台里创建的配置：runtime、schedule、handler 脚本、IAM role、S3 artifact 存储、告警
- [ ] 4. `cdk diff` 确认不会跟手工创建的资源冲突（必要时先在控制台删除手工创建的 canary，或者 import 到 CDK 管理）
- [ ] 5. `cdk deploy` 部署，确认 canary 正常跑起来
- [ ] 6. 更新 `docs/cdk-deploy-commands.md`，补充这个新 stack 的部署说明
