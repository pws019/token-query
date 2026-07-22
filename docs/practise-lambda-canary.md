# Today's TODO — Lambda 灰度发布（Canary Deployment）学习与验证

目标：学习并验证 AWS Lambda 的灰度发布机制（Alias 加权路由 + CodeDeploy Canary/Linear 部署策略）。跟 SNS/SQS/EventBridge 那几次一样，**先用一个业务无关的测试 Lambda 练一遍机制**，不直接碰 token-query 项目的真实 Lambda（`token-query-function`），验证清楚了再考虑要不要落地到 `api-stack.ts`。背景讨论见 [docs/knowledge/gradual-rollout-canary-deployment.md](knowledge/gradual-rollout-canary-deployment.md)。

## Part 1 — Lambda Alias + CodeDeploy Canary 操练（业务无关）

### 步骤

- [ ] 1. 建一个测试用 Lambda 函数
  - 打开 [Lambda 控制台](https://console.aws.amazon.com/lambda) → **Create function**
  - **Author from scratch**，Function name 填 `learning-lambda-canary-demo1`，Runtime 选 Node.js（默认最新版）→ **Create function**
  - 选 Node.js 24.x（或当前最新版）时，控制台默认生成的是 `index.mjs`，用的是 **ESM** 写法（`export const handler`），这个是对的，不用改成 CommonJS——改成 `exports.handler` 反而会报错，因为 `.mjs` 文件里没有 `exports` 这个全局变量。把默认代码改成能明确区分版本的返回值就行：
    ```js
    export const handler = async () => {
      return { statusCode: 200, body: "v1" };
    };
    ```
  - 保存（**Deploy** 按钮）
  - **踩坑记录**：如果测试调用时报 `Runtime.UserCodeSyntaxError: Unexpected token 'export'`，大概率是手滑把某个版本的代码改成了 CommonJS 写法（`exports.handler = ...`）却还留在 `.mjs` 文件里，改回 `export const handler` 就好——两种写法混着改最容易出这个错，不是 ESM 本身有问题
- [ ] 2. 发布 Version 1，建一个指向它的 Alias
  - 函数详情页 → **Actions → Publish new version** → Description 填 `v1` → **Publish**，记下这是 Version 1
  - 左侧 **Aliases** 标签页 → **Create alias**，Name 填 `live`，Version 选 **1**，Weighted alias 先不开 → **Save**
  - 这个 `live` alias 现在 100% 指向 Version 1，这是后面灰度要操作的对象
- [ ] 3. 改代码，发布 Version 2（但先不切流量）
  - 回到函数代码（注意要编辑 `$LATEST`，不是某个已发布版本），把 body 改成 `"v2"`（保持跟第 1 步一致的 ESM `export const handler` 写法）→ **Deploy**
  - **Actions → Publish new version** → Description 填 `v2` → **Publish**，记下这是 Version 2
  - 此时 `live` alias 还是 100% 指向 Version 1，Version 2 已经存在但没有任何真实调用流量会打到它
- [ ] 4. 建 CodeDeploy Application + Deployment Group
  - 打开 [CodeDeploy 控制台](https://console.aws.amazon.com/codesuite/codedeploy) → **Applications → Create application**
  - Application name 填 `learning-lambda-canary-app`，Compute platform 选 **AWS Lambda** → **Create application**
  - 进入这个 Application → **Create deployment group**
  - Deployment group name 填 `learning-lambda-canary-dg`
  - Service role：这个字段**不会**自动帮你创建，需要填一个已存在的 role ARN。踩坑记录：托管策略正确的 ARN 是 `arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda`（带 `service-role/` 前缀，不带会报 `NoSuchEntity`）。用 CLI 建：
    ```bash
    aws iam create-role --role-name learning-codedeploy-lambda-role \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codedeploy.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    aws iam attach-role-policy --role-name learning-codedeploy-lambda-role \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSCodeDeployRoleForLambda
    ```
    建好后把 `arn:aws:iam::707605822527:role/learning-codedeploy-lambda-role` 粘到 Service role 输入框里
  - Deployment settings 选 **CodeDeployDefault.LambdaCanary10Percent5Minutes**（先切 10%，观察 5 分钟，再到 100%；也可以选 Linear 系列对比着玩）
  - 先不配 CloudWatch Alarm（下一步单独验证自动回滚时再加）→ **Create deployment group**
- [ ] 5. 用 CodeDeploy 触发一次灰度部署（从 Version 1 灰度切到 Version 2）
  - CodeDeploy 对 Lambda 的部署需要一个 AppSpec（描述"从哪个 alias/version 切到哪个"），最简单的方式是通过 **CLI** 触发，控制台创建 deployment 时需要手动填 AppSpec content，用 CLI 更省事：
    ```bash
    aws deploy create-deployment \
      --application-name learning-lambda-canary-app \
      --deployment-group-name learning-lambda-canary-dg \
      --revision '{
        "revisionType": "AppSpecContent",
        "appSpecContent": {
          "content": "{\"version\":0.0,\"Resources\":[{\"myLambdaFunction\":{\"Type\":\"AWS::Lambda::Function\",\"Properties\":{\"Name\":\"learning-lambda-canary-demo1\",\"Alias\":\"live\",\"CurrentVersion\":\"1\",\"TargetVersion\":\"2\"}}}]}"
        }
      }' \
      --region us-west-2
    ```
  - 这一步会真正开始把 `live` alias 的流量从 Version 1 逐步切到 Version 2
- [ ] 6. 观察灰度过程中的流量分配
  - 部署开始后的 5 分钟观察窗口内，反复调用这个 alias（注意要调 alias 的 ARN，不是 `$LATEST`）：
    ```bash
    for i in $(seq 1 20); do
      aws lambda invoke --function-name learning-lambda-canary-demo1:live --region us-west-2 /tmp/out.json --log-type None
      cat /tmp/out.json
      echo ""
    done
    ```
  - 预期：大概 10% 的调用返回 `"v2"`，其余返回 `"v1"`——这就是加权流量分配的直接证据
  - 也可以在 CodeDeploy 控制台的这次 deployment 详情页看到部署状态从 `InProgress` 逐步推进
  - 等 5 分钟观察窗口过完，deployment 状态应该变成 `Succeeded`，再跑一遍上面的循环调用，应该 100% 都是 `"v2"` 了
- [x] 7. 验证自动回滚（配合 CloudWatch Alarm）—— **已验证通过**：手动把 `learning-lambda-canary-test-alarm` 打成 ALARM 后，部署状态变成 `Stopped`（`errorInformation.code: ALARM_ACTIVE`），CodeDeploy 自动触发了一次回滚部署且 `Succeeded`，`live` alias 确认回到了触发前的版本（`RoutingConfig: null`，100% 单一版本，不再是加权分流状态）
  - **踩坑记录**：Deployment Group 的 Alarm 配置有两层，容易漏掉第二层——(1) 把 alarm 加进 "Roll back when alarm thresholds are met" 这个列表；(2) **还有一个独立的 "Enable alarms" 总开关**（`alarmConfiguration.enabled`），不打开的话即使 alarm 已经关联、状态也真的变成了 ALARM，CodeDeploy 也完全不会检测，部署不会有任何反应。用 CLI 查询能一眼看出来：
    ```bash
    aws deploy get-deployment-group \
      --application-name learning-lambda-canary-app \
      --deployment-group-name learning-lambda-canary-dg \
      --region us-west-2 \
      --query 'deploymentGroupInfo.alarmConfiguration'
    # 如果 "enabled": false，就是这个坑，用下面命令打开：
    aws deploy update-deployment-group \
      --application-name learning-lambda-canary-app \
      --current-deployment-group-name learning-lambda-canary-dg \
      --alarm-configuration '{"enabled":true,"ignorePollAlarmFailure":false,"alarms":[{"name":"learning-lambda-canary-test-alarm"}]}' \
      --region us-west-2
    ```
  - CodeDeploy 检测 Alarm 状态变化不是瞬时的，有几十秒到一分钟的轮询延迟，手动 `set-alarm-state` 之后不用慌，等一下再查部署状态
  - 建一个简单的测试 Alarm——**注意这个 Alarm 的阈值具体设多少完全不重要**，因为我们最终是用 `set-alarm-state` 命令手动强制把它掰成 ALARM 状态来模拟，不会真的等它按指标自然触发，所以表单里那些数字随便填一个能过校验的就行，不用纠结"这个值到底该设多少才合理"：
    1. 打开 [CloudWatch 控制台](https://us-west-2.console.aws.amazon.com/cloudwatch/home?region=us-west-2#alarmsV2:) → 左侧导航 **Alarms → All alarms** → 右上角 **Create alarm**
    2. **Specify metric and conditions** 页面 → 点 **Select metric**
    3. 弹出的浏览器里点 **Lambda** → **By Function Name** → 找到 `learning-lambda-canary-demo1` 这一行 → 勾选 **Errors** 这个 metric → 右下角 **Select metric**
    4. **Metric** 区域：Statistic 选 **Sum**，Period 选 **1 minute**（不用管具体数值，只是走完表单）
    5. **Conditions** 区域：Threshold type 保持 **Static**；"Whenever Errors is..." 选 **Greater/Equal**；"than..." 填 **1**（随便填个能过校验的数字，比如 1）
    6. 拉到最下面 **Additional configuration**：Datapoints to alarm 保持默认 **1 out of 1**；Missing data treatment 选 **Treat missing data as good (not breaching)** → **Next**
    7. **Configure actions** 页面：这一步默认会要求你选/建一个 SNS Topic 发通知——**这个测试 alarm 不需要真的通知任何人**，找页面上 "Remove" 或者把 Notification 这一整块删掉/跳过（不同控制台版本按钮位置略有差异，找类似"移除这个通知动作"的选项）；如果实在跳不过，就先随便选一个已有的 Topic 凑合过去，反正这个 Alarm 只是用来测试、不会真的触发通知 → **Next**
    8. **Add name and description**：Alarm name 填 `learning-lambda-canary-test-alarm` → **Next**
    9. **Preview and create** 页面确认一下配置 → **Create alarm**
  - （如果表单还是觉得麻烦，也可以直接告诉我，我用 CLI `aws cloudwatch put-metric-alarm` 帮你建，跟之前建 IAM role 一样快）
  - 回到 Deployment Group 配置，把这个 Alarm 加到 **Alarm configuration** 里
  - 重新触发一次灰度部署（同第 5 步），部署进行中的时候手动把这个 Alarm 状态改成 `ALARM`：
    ```bash
    aws cloudwatch set-alarm-state --alarm-name <你的测试alarm名> --state-value ALARM --state-reason "manual test" --region us-west-2
    ```
  - 预期：CodeDeploy 检测到 Alarm 变成 ALARM，自动停止部署并把 `live` alias 回滚到 Version 1（不需要人工介入）
  - 这一步是重点——验证的就是"灰度部署能不能被现有告警自动叫停"，这也是以后真要落地到 `token-query-function` 时最有价值的能力（能接现有的 `token-query-api-heartbeat-failed` Alarm）
- [ ] 8. 练完清理测试资源
  - CodeDeploy 控制台 → 删除 Deployment Group → 删除 Application
  - CloudWatch → 删除第 7 步建的测试 Alarm
  - Lambda 控制台 → 删除 `learning-lambda-canary-demo1` 函数（会连带清掉它的 alias 和已发布的 versions）

### 后续验证方式（练完之后自查）

- [ ] 用 `aws lambda get-alias --function-name learning-lambda-canary-demo1 --name live --region us-west-2` 确认部署完成后 alias 确实 100% 指向 Version 2（`FunctionVersion` 字段）
- [ ] 用 `aws deploy get-deployment --deployment-id <deployment-id> --region us-west-2` 查看一次完整部署的状态流转（`Created → InProgress → Succeeded`，或者回滚场景下的 `Stopped`/`Failed` + `rollbackInfo`）
- [ ] 确认自己能讲清楚这几个概念的区别，讲不清楚说明还没吃透：
  - Version 和 Alias 的关系（Version 不可变，Alias 是活动指针，可以加权指向多个 Version）
  - CodeDeploy 的 `LambdaCanary10Percent5Minutes` 和 `LambdaLinear10PercentEvery1Minute` 这两类部署策略的区别
  - 为什么 API Gateway **HTTP API**（项目现在用的）用不上 API Gateway 自己的 canary stage，只能靠 Lambda Alias 加权

## Part 2 — 落地到项目 `api-stack.ts`（CDK 管理）—— 已实现

决定：让生产环境的每次部署都走灰度（不做"手动可选"），因为 CloudFormation 原生就有这个能力，不需要额外的手动步骤——见下文。

### 做了什么（[api-stack.ts](../infra/cdk/lib/api-stack.ts)）

- `apiFunction` 还是保留 `lambda.CfnFunction`（L1），没有切成 L2 —— 因为项目的 VPC 子网/安全组是通过 `AWS::SSM::Parameter::Value<List<...>>` 这种 CfnParameter token 传进来的（个数在 synth 时未知），L2 `lambda.Function` 的 VPC 配置需要具体的 `ec2.ISubnet[]` 对象数组，跟这种 token 列表天然不兼容。改成 L1 手动管理 Version/Alias 反而更贴合现状。
- 通过 `lambda.Function.fromFunctionAttributes(...)` 把这个 L1 `CfnFunction` 包成一个 L2 `IFunction` 引用，再用它建：
  - `lambda.Version`（构造 ID 里拼了一段代码资产哈希 `TokenQueryFunctionVersion${codeAssetHash}`，这样每次代码变化，CloudFormation 会把它当成一个全新的资源来创建，旧 Version 保留不删——这正是 CDK 内置 `Function.currentVersion` 的实现原理，这里是手动复刻了一遍）
  - `lambda.Alias`（名字固定叫 `live`，指向上面的 Version）
- API Gateway 的 Integration 和 Lambda Permission 都从直接指向 `apiFunction` 改成指向 `apiFunctionAlias`（不然流量绕过了 alias，灰度切流量就没意义了）
- 复用了 `monitoring-stack.ts` 里现成的 `token-query-api-heartbeat-failed` Alarm（用 `cloudwatch.Alarm.fromAlarmArn` 跨栈引用，没有新建 Alarm）
- `codedeploy.LambdaDeploymentGroup`：`deploymentConfig` 选了 `CANARY_10PERCENT_10MINUTES`（不是 Part 1 用的 5 分钟）—— 因为 heartbeat canary 是每 5 分钟才跑一次（见 [monitoring-stack.ts](../infra/cdk/lib/monitoring-stack.ts)），5 分钟的观察窗口有可能一次探测都赶不上；10 分钟至少能保证探测跑一两次
- Service Role 没有手动建（不像 Part 1 在 IAM 里手动 `create-role`）——`LambdaDeploymentGroup` 不传 `role` 时会自动建一个绑定 `AWSCodeDeployRoleForLambdaLimited` 托管策略的角色，够用

### 一个重要发现：`deploy-lambda.yml` 完全不用改

CDK 生成的 Alias 资源上带了一个原生 CloudFormation 属性 `UpdatePolicy: CodeDeployLambdaAliasUpdate`（用 `cdk synth` 能直接看到）。这意味着：**只要 Alias 的 `FunctionVersion` 属性在一次 `cdk deploy`/`aws cloudformation update-stack` 里发生变化，CloudFormation 自己就会把这次更新交给 CodeDeploy 去做灰度切流量**，不需要像 Part 1 那样手动拼 AppSpec 再调 `aws deploy create-deployment`。

也就是说：`deploy-lambda.yml` 里原本那句 `cdk deploy "$CDK_STACK_NAME" ...` 不用加任何新命令——每次 push 到 main 触发部署时，这句命令本身就会：
1. 更新 Lambda 代码 → 触发新 Version 资源创建
2. Alias 的 `FunctionVersion` 属性变化 → CloudFormation 识别到 `UpdatePolicy`，把控制权交给 CodeDeploy
3. `cdk deploy` 这个 GitHub Actions 步骤会一直等到灰度 + 观察期跑完（10 分钟 canary 配置下，整个 stack update 会多花 10+ 分钟才返回，这是预期行为，不是卡住）
4. 如果观察期内 `token-query-api-heartbeat-failed` 变成 ALARM，CodeDeploy 自动回滚 Alias，CloudFormation stack update 相应地标记失败——不需要人工介入

### 验证方式（下次真正 push 一次代码变更到 `apps/server` 时做）

- [ ] `cdk diff token-query-api` 确认能看到 Version（新增）+ Alias（属性更新）的变更
- [ ] 部署跑起来后，`aws deploy list-deployments --application-name token-query-api --deployment-group-name token-query-api-dg` 能看到一次新的 deployment，状态从 `InProgress` 到 `Succeeded`
- [ ] 部署过程中 `aws lambda get-alias --function-name token-query-function --name live` 能看到 `RoutingConfig` 里短暂出现两个 Version 的加权分配，观察期结束后变回单一 Version（100% 新版本）、`RoutingConfig: null`
- [ ] （可选，破坏性测试）故意让 `/health` 在观察期内返回失败，验证 heartbeat Alarm 触发后 CodeDeploy 真的会自动回滚——注意这个会真实影响生产流量，建议只在确认没有真实用户访问的时段做，或者先在这次验证里跳过，等以后有信心了再单独找时间测

### 还没做 / 明确不做的部分

- 没有区分 preview 环境要不要走灰度——preview Lambda（`preview-api-stack.ts`）生命周期本来就很短（PR 一关就销毁），灰度对它没有意义，没有改动那个栈
- 没有改 `deploy-lambda.yml`（如上所述，原生机制已经够用，不需要改）
