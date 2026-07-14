# Token Query AWS 部署手册

本项目的 AWS 基础设施分成四层独立的 CloudFormation stack。`iam` 和 `network` 互相独立、没有依赖关系，但 `api` 层同时依赖这两者 + `db`：

```
token-query-iam ──────────────┐  发布 SSM 参数（/token-query/iam/...）
                               │
token-query-network            │  发布 SSM 参数（/token-query/network/...）
        │                      │
        ▼                      │
token-query-db                 │  发布 SSM 参数（/token-query/db/...）
        │                      │
        ▼                      ▼
        └──────────────► token-query-api   ← 唯一接入 GitHub Actions 自动部署的一层
```

- `iam`、`network`、`db` **只手动部署**，不接入任何自动触发的 CI 流水线。`iam` 尤其特殊——它定义的是流水线自己跑代码时用的权限，绝不能让流水线依赖自己去更新自己（细节见 [IAM.md](IAM.md)）。
- `api` 层由 `.github/workflows/deploy-lambda-api.yml` 自动部署，push 到 `main` 分支或手动 `workflow_dispatch` 都会触发。
- 四层之间不用手填 ID/ARN 传参——`api` 层通过 CloudFormation 的 `AWS::SSM::Parameter::Value<...>` 类型，在**每次部署时**实时读取 `iam`/`network`/`db` 发布到 SSM Parameter Store 的最新值（Lambda 执行角色 ARN、VpcId、子网、安全组、Aurora endpoint）。改了其中任何一层之后，下次部署 `api` 层会自动读到新值，不需要手动同步。
- `iam` 层里的两个角色是通过 **import** 现有角色管理的，角色 ARN 通常不变；只有角色被真正删除重建（ARN/名字变了）才需要人工介入，见 [IAM.md](IAM.md) 第四节。
- **`api` 层每次重建（删了重新建）之后，有一处 AWS 之外的地方必须手动同步：Cloudflare**，见第三节末尾。这是目前唯一没有被 SSM 自动联动覆盖的环节，因为 Cloudflare 配置不在 AWS 账号里。

---

## 一、GitHub 仓库需要配置的内容

路径：仓库 Settings → Secrets and variables → Actions

> `AWS_DEPLOY_ROLE_ARN` 指向的那个 IAM 角色本身（信任策略、权限策略）是在 AWS 那边配置的，不是 GitHub 上的东西——角色的创建命令、完整权限清单见 [IAM.md](IAM.md)。

### Secrets（敏感值，必须配置）

| 名称 | 说明 |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | GitHub OIDC 用来 assume 的部署角色 ARN |
| `DB_PASSWORD` | Aurora 主密码。**必须**和你手动部署 `db-template.yaml` 时传的 `DbMasterPassword` 参数值一致 |
| `INTERNAL_PROXY_TOKEN` | 和 Cloudflare Worker 共享的密钥 |
| `ADMIN_MIGRATION_TOKEN` | 可选，数据库初始化用的临时管理 token，用完可以清空 |

> 不需要再配置 `DATABASE_URL`——它由 workflow 在部署时用 `DB_PASSWORD` + 从 SSM 实时读到的 Aurora endpoint 现拼出来。

### Variables（非敏感，都有默认值兜底，一般不用改）

| 名称 | 默认值 |
|---|---|
| `AWS_REGION` | `us-west-2` |
| `SAM_STACK_NAME` | `token-query-api` |
| `CORS_ORIGIN` | `https://app.doyouadoreme.online` |
| `PRIVATE_SUBNET_IDS_SSM_PARAM` | `/token-query/network/private-subnet-ids` |
| `LAMBDA_SECURITY_GROUP_ID_SSM_PARAM` | `/token-query/network/lambda-security-group-id` |
| `LAMBDA_EXECUTION_ROLE_ARN_SSM_PARAM` | `/token-query/iam/lambda-execution-role-arn` |
| `CERTIFICATE_ARN` | 现有 ACM 证书 ARN（ACM 证书不支持 CloudFormation 管理，纯引用） |

---

## 二、正向部署（从零开始）

顺序：**iam → network → db → api**。`iam` 和 `network` 互不依赖，谁先谁后都行，但都要在 `db`/`api` 之前。

### 第 1 步：IAM 层（手动，CLI）

```bash
cd /Users/whitesmith/Projects/token-query

aws cloudformation validate-template \
  --template-body file://infra/iam-template.yaml \
  --region us-west-2

aws cloudformation create-stack \
  --stack-name token-query-iam \
  --region us-west-2 \
  --template-body file://infra/iam-template.yaml \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation describe-stacks \
  --stack-name token-query-iam --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

> 如果 `token-query-function-role-qsx6aji9`/`github-actions-token-query-deploy-role` 这两个角色已经存在（比如手动建过），这一步要走 **import** 而不是 `create-stack`，否则会因为角色名冲突报错。import 的完整流程和 resources-to-import 清单见 [IAM.md](IAM.md)。全新账号、角色确实不存在的话，直接 `create-stack` 就行。

### 第 2 步：网络层（手动，CLI）

```bash
aws cloudformation create-stack \
  --stack-name token-query-network \
  --region us-west-2 \
  --template-body file://infra/network-template.yaml

# 轮询进度，直到 CREATE_COMPLETE（NAT Gateway 较慢，预计 2-5 分钟）
aws cloudformation describe-stacks \
  --stack-name token-query-network --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### 第 3 步：数据库层（手动，CLI）

必须等网络层 `CREATE_COMPLETE` 之后再做。`DbMasterPassword` 自己定一个密码，记住它——之后要填进 GitHub Secrets 的 `DB_PASSWORD`。

```bash
aws cloudformation create-stack \
  --stack-name token-query-db \
  --region us-west-2 \
  --template-body file://infra/db-template.yaml \
  --parameters ParameterKey=DbMasterPassword,ParameterValue='<你的密码>'

# Aurora Serverless v2 建集群较慢，预计 5-10 分钟
aws cloudformation describe-stacks \
  --stack-name token-query-db --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### 第 4 步：API 层（自动，GitHub Actions）

1. 确认上面第一节列的 Secrets/Variables 都配置好了（尤其 `DB_PASSWORD` 要跟第 3 步的密码一致）。
2. 去仓库 Actions 页面，找到 `Deploy AWS Lambda API`，点击 `Run workflow`（或者 push 一次触碰到 `apps/server/**`/`infra/template.yaml` 的改动，会自动触发）。
3. 跑完之后确认：

```bash
aws cloudformation describe-stacks \
  --stack-name token-query-api --region us-west-2 \
  --query 'Stacks[0].Outputs' --output table

curl -i https://<ApiEndpoint 或 CustomDomainUrl 输出值>/
```

4. **⚠️ 同步 Cloudflare（AWS 之外的手动步骤，SSM 联动覆盖不到）**——见第三节末尾"重建 API 层后必须同步的 Cloudflare 配置"。只要 `token-query-api` 是全新创建（不是 update），这一步永远要做，因为 API Gateway 给自定义域名分配的 regional target 每次重建都会变。

### 本地手动部署 API 层（不走 CI 的备选方案）

```bash
pnpm --filter server build
cd infra
sam build
sam deploy   # 用 samconfig.toml 里的默认值；DbPassword/InternalProxyToken 等敏感参数会提示你手动输入
```

---

## 三、反向卸载（从有到无）

**删除顺序必须是 api → db → network → iam**（跟创建顺序完全反过来）。`api` 依赖 `network`/`db`/`iam` 三者，必须最先删；`db` 依赖 `network`，要在它之前删；`iam` 谁都不依赖，放最后删（或者干脆不删，反正没人依赖它了也不影响别的层继续跑）。反过来删会因为 VPC 还有依赖（Lambda 的 ENI、Aurora 用的子网/安全组）而删除失败。

> ⚠️ 四层模板里所有资源的 `DeletionPolicy` 都是 `Delete`（`iam` 层的两个角色除外，还是 `Retain`，因为角色删了要重建比较麻烦，且没有"占资源费"的问题，不着急清）。`network`/`db`/`api` 里 Aurora 的 `DeletionProtection` 也是关闭状态——意味着删 db stack 就是真删，Aurora 没有最终快照，数据永久丢失。确认真的要删再执行。

### 第 1 步：删 API 层

```bash
aws cloudformation delete-stack --stack-name token-query-api --region us-west-2

aws cloudformation describe-stacks \
  --stack-name token-query-api --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
# 目标：命令报 "Stack ... does not exist"，说明删干净了
```

### 第 2 步：删数据库层

等第 1 步确认删完（stack 不存在）之后：

```bash
aws cloudformation delete-stack --stack-name token-query-db --region us-west-2

aws cloudformation describe-stacks \
  --stack-name token-query-db --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### 第 3 步：删网络层

```bash
aws cloudformation delete-stack --stack-name token-query-network --region us-west-2

aws cloudformation describe-stacks \
  --stack-name token-query-network --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

### 第 4 步：删 IAM 层（一般不需要，除非要测试整套完整性）

```bash
aws cloudformation delete-stack --stack-name token-query-iam --region us-west-2

aws cloudformation describe-stacks \
  --stack-name token-query-iam --region us-west-2 \
  --query 'Stacks[0].StackStatus' --output text
```

> 两个角色的 `DeletionPolicy` 是 `Retain`，删这个 stack 不会真的删掉 `github-actions-token-query-deploy-role`/`token-query-function-role-qsx6aji9` 这两个 IAM 角色本身，只是取消托管。真要连角色一起删干净，得再手动 `aws iam delete-role`（删之前先把角色上的 inline policy 和 attach 的 managed policy 卸干净，IAM 不允许删除还挂着策略的角色）。

---

## 四、重建 API 层后必须同步的 Cloudflare 配置

`token-query-api` 只要是**全新创建**（`create-stack`，不是 `update-stack`），下面两处 Cloudflare 配置就必须手动同步，SSM 联动覆盖不到这里（Cloudflare 不在 AWS 账号里，CloudFormation 管不到）：

### 1. `api.doyouadoreme.online` 的 CNAME 记录

API Gateway 每次重建自定义域名映射，分配的 regional target 域名都会变。查新值：

```bash
aws apigatewayv2 get-domain-name \
  --domain-name api.doyouadoreme.online --region us-west-2 \
  --query 'DomainNameConfigurations[0].ApiGatewayDomainName' --output text
```

去 Cloudflare 控制台，把 `api.doyouadoreme.online` 这条 CNAME 记录的目标值改成上面查出来的新值。

### 2. Cloudflare Worker 里的 `LAMBDA_API_ORIGIN`（GitHub Variable，部署 Worker 时写入）

这个变量**必须填 AWS 裸的 `ApiEndpoint`**（`https://<api-id>.execute-api.us-west-2.amazonaws.com`），**不能填自定义域名** `https://api.doyouadoreme.online`。

原因：`api.doyouadoreme.online` 在 Cloudflare 那边是代理状态（橙云）。Worker 内部用 `fetch()` 请求**同一个 Cloudflare 账号下、同样被代理的域名**时，Cloudflare 会当成潜在的自引用死循环直接拦截报错——这是 Cloudflare 的既定限制，不是配置错误。所以自定义域名 + ACM 证书这条通路，是留给外部直接访问 API 用的（比如手动测试），跟 Worker 内部代理用的地址是两回事，不要混。

`token-query-api` 每次重建（`create-stack`，不是 `update-stack`），`ApiEndpoint` 的 `<api-id>` 都会变，查新值：

```bash
aws apigatewayv2 get-apis --region us-west-2 \
  --query "Items[?Name=='token-query-http-api'].ApiEndpoint" --output text
```

查到之后去 GitHub 仓库 Variables 里把 `LAMBDA_API_ORIGIN` 改成这个值，然后重新跑一次 `Deploy Cloudflare Worker` 这个 workflow（改 Variable 本身不会自动重新部署，需要手动触发）。

验证两处都同步好了：

```bash
curl -i https://api.doyouadoreme.online/api/health   # 走 Cloudflare 代理，验证 CNAME
curl -i https://app.doyouadoreme.online/             # 验证 Worker 代理链路（走前端实际调一次接口更准）
```

### （可选）连 SAM 的托管 bucket 一起清

`aws-sam-cli-managed-default` 是 SAM CLI 自己建的托管 S3 bucket（存部署产物），跟业务三层无关。如果想彻底清空账户：

```bash
# S3 bucket 开了版本控制，得先清空所有版本才能删 bucket，否则 delete-stack 会报 "bucket not empty"
BUCKET=$(aws cloudformation describe-stack-resources \
  --stack-name aws-sam-cli-managed-default --region us-west-2 \
  --logical-resource-id SamCliSourceBucket \
  --query 'StackResources[0].PhysicalResourceId' --output text)

aws s3api list-object-versions --bucket "$BUCKET" --region us-west-2 --output json > /tmp/versions.json
python3 -c "
import json
data = json.load(open('/tmp/versions.json'))
objects = [{'Key': v['Key'], 'VersionId': v['VersionId']} for v in (data.get('Versions') or [])]
objects += [{'Key': m['Key'], 'VersionId': m['VersionId']} for m in (data.get('DeleteMarkers') or [])]
print(json.dumps({'Objects': objects, 'Quiet': True}))
" > /tmp/delete-payload.json
aws s3api delete-objects --bucket "$BUCKET" --region us-west-2 --delete file:///tmp/delete-payload.json

aws cloudformation delete-stack --stack-name aws-sam-cli-managed-default --region us-west-2
```

删完这个之后，下次 `sam deploy --resolve-s3` 会自动重新创建它，不需要手动干预。

---

## 五、变更已部署的 iam/network/db 层（不是从零建，是改配置）

`iam`/`network`/`db` 这三层严禁 blind apply——永远先出 change set 预览，确认 diff 没问题再执行：

```bash
aws cloudformation create-change-set \
  --stack-name token-query-db \
  --change-set-name my-change \
  --region us-west-2 \
  --template-body file://infra/db-template.yaml

aws cloudformation describe-change-set \
  --stack-name token-query-db --change-set-name my-change --region us-west-2

# 确认没问题再执行
aws cloudformation execute-change-set \
  --stack-name token-query-db --change-set-name my-change --region us-west-2
```

`network`/`iam` 层同理，把 `token-query-db` 换成 `token-query-network`/`token-query-iam`（`iam` 层记得加 `--capabilities CAPABILITY_NAMED_IAM`）。

---

## 六、常见坑（踩过的记录一下）

- **CloudFormation 对"只改 Parameter 类型/Default、不带任何资源属性变化"的更新会直接拒绝**（报 `No updates are to be performed`）。这种改动要跟一个真实的资源变更（哪怕是加个新资源）捆在一起才能推得动。
- **`DeletionPolicy` 只是纯属性变更，CloudFormation 会正常识别成 `Modify`**，不受上面那条限制，可以单独更新生效。
- **`ApiMapping` 删除时如果跟它绑定的 Stage 并行删，会报错**"Please remove all base path mappings"——模板里已经加了 `DependsOn: TokenQueryHttpApiApiGatewayDefaultStage` 来强制顺序，正常不会再遇到。
- **SAM 托管 S3 bucket 开了版本控制**，`delete-stack` 删不掉非空 bucket，得先清空所有对象版本（见上面第三节的可选步骤）。
- **`AWS::SSM::Parameter::Value<...>` 类型的参数需要 `ssm:GetParameters`/`ssm:GetParameter` 权限**，且要精确到具体的 SSM 参数路径前缀，不然会报 AccessDenied。
- **ACM 证书本身不支持 CloudFormation import**，只能用 ARN 引用，不放进任何 stack 管理。
- **部署角色的 IAM policy 是照"接管已有资源（import）"这个场景配的，不等于"从零创建/删除"需要的权限**：只给了具体函数名 `token-query-function` 的 `UpdateFunctionCode`/`AddPermission`/`TagResource` 等，没给 `CreateFunction`/`DeleteFunction`。如果 stack 是从零 `create-stack`（不是 import 出来的），第一次部署会在这一步报 AccessDenied 卡住，stack 进入 `ROLLBACK_COMPLETE`。修法：给部署角色补上对应资源名的 `lambda:CreateFunction`/`lambda:DeleteFunction`，然后 `delete-stack` 清掉这个空壳 stack（`ROLLBACK_COMPLETE` 状态下没有任何真实资源残留，可以直接删）重新创建。
- **`ROLLBACK_COMPLETE` 状态的 stack 不能直接 `update`/`create-change-set`**，必须先 `delete-stack` 再重新 `create-stack`。
- **`AWS::IAM::Role`/`AWS::IAM::RolePolicy`/`AWS::IAM::OIDCProvider` 都支持 CloudFormation import**，可以把手动维护的角色纳入 IaC 管理。
- **合并/精简多个 `DeletionPolicy: Retain` 的资源时，不用严格按"先改 Delete 再移除"两步走**：直接把要合并掉的资源从模板里删掉，CloudFormation 会因为 `Retain` 只是取消托管（不会删真实资源），旧的和新合并的会短暂同时存在（权限是并集，不冲突）；然后直接用对应服务的原生 API（比如 `aws iam delete-role-policy`）把这些已经不被任何 stack 管理的旧资源手动清掉，比在 CFN 里来回折腾两次 change set 更省事。
- **`apigateway:TagResource`/`UntagResource` 是独立的 IAM action**，不归 `apigateway:GET`/`POST`/`PUT`/`PATCH`/`DELETE` 这几个"动词"权限管——SAM 给 HttpApi Stage 打 stack 标签时会调用它，缺了会在 `CREATE_FAILED` 里看到 `apigateway:TagResource ... AccessDenied`。
- **`logs:DeleteLogGroup` 跟 `CreateLogGroup`/`PutRetentionPolicy`/`TagResource` 是分开粒度的权限**，容易补权限时漏掉这一个——直到某次 rollback 需要删日志组才会暴露出来（`ROLLBACK_FAILED`）。补权限时記得把某个资源的增删改查动作一次性配全，不要只补当时报错的那一个。
- **Cloudflare Worker 不能 `fetch()` 同一个账号下、同样被代理（橙云）的域名**——会被 Cloudflare 当成潜在死循环直接拦截报错。这就是为什么 `LAMBDA_API_ORIGIN` 必须填 AWS 裸的 `ApiEndpoint`，不能填 `api.doyouadoreme.online` 这个自定义域名，哪怕它看起来"更正式"。自定义域名 + ACM 证书这条通路是留给外部直接调用的，跟 Worker 内部代理走的地址是两回事。
