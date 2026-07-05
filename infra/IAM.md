# IAM 角色与权限清单

本项目部署链路涉及两个 IAM 角色，现在都由 **`infra/iam-template.yaml`** 这个独立的 CloudFormation stack（`token-query-iam`）管理——跟 `network`/`db` 一样，**只手动部署，不接入任何自动触发的 GitHub Actions 流水线**（原因见该文件顶部的 Description：这个 stack 定义的是流水线自己跑代码时用的权限，不能让流水线依赖自己去更新自己）。

```
GitHub Actions (OIDC)
        │  assume role
        ▼
github-actions-token-query-deploy-role   ← 部署角色：跑 sam/cloudformation 命令的身份
        │  iam:PassRole
        ▼
token-query-function-role-qsx6aji9       ← Lambda 执行角色：Lambda 函数运行时的身份
```

两个角色职责完全不同，不要混：**部署角色**是"CI 用来调用 AWS API 建资源"的身份；**执行角色**是"Lambda 函数运行起来之后，代码本身访问其他 AWS 服务（如果有）"的身份。

`AWS_DEPLOY_ROLE_ARN`（GitHub Secret）指向的就是部署角色的 ARN——GitHub 那边只需要存这一个 ARN 字符串，角色本身的定义、信任关系、权限策略全部在 `infra/iam-template.yaml` 里维护，见 [DEPLOYMENT.md](DEPLOYMENT.md) 第一节。

---

## 一、现状：`token-query-iam` stack 管什么

```bash
aws cloudformation list-stack-resources --stack-name token-query-iam --region us-west-2
```

当前 5 个资源：

| 逻辑 ID | 类型 | 对应真实资源 |
|---|---|---|
| `GitHubOidcProvider` | `AWS::IAM::OIDCProvider` | `token.actions.githubusercontent.com` |
| `DeployRole` | `AWS::IAM::Role` | `github-actions-token-query-deploy-role` |
| `DeployRoleLambdaDeployPolicy` | `AWS::IAM::RolePolicy` | inline policy `token-query-lambda-deploy-policy` |
| `DeployRoleSamDeployPolicy` | `AWS::IAM::RolePolicy` | inline policy `token-query-sam-deploy-policy`（**已合并**，见下） |
| `LambdaExecutionRole` | `AWS::IAM::Role` | `token-query-function-role-qsx6aji9` |

部署角色上现在**只有 2 个 inline policy**（`token-query-lambda-deploy-policy` + `token-query-sam-deploy-policy`）。原来因为边踩坑边补权限、临时手动打过 7 个 `-patch`/`-patch2`~`-patch7` 补丁策略，等这套流程跑通、确认权限齐全之后，已经把这 7 个的内容全部合并进 `token-query-sam-deploy-policy` 一个策略里，并把旧的 7 个从角色上删掉了——**这 7 个补丁策略的历史记录见第三节**，方便以后遇到类似报错时知道对应哪条权限，但账号里已经不存在这 7 个了，不要再照着单独创建。

`iam-template.yaml` 是通过 **import** 把这两个已经存在的角色接管进来的（不是从零新建），所以 ARN 全程没变过——这也是为什么这次"改造成 IaC"没有触发任何 GitHub Secrets/Cloudflare 同步（角色名字、ARN 都没变）。

---

## 二、GitHub OIDC Provider（一次性账号级配置，已在 stack 里）

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 22ff89586561fc2d52f77491e9f1eff1b80be33e
```

> Thumbprint 是 GitHub OIDC 服务器证书链的指纹，证书轮换会变，不用长期硬编码信任这个值——真要重新生成，`openssl` 现查一下就行。这是全新账号才需要跑的命令，当前账号已经在 stack 里管理了。

---

## 三、历史记录：曾经存在过的 7 个补丁策略

仅供排查问题时参考"哪次报错对应补了哪条权限"，账号里已经不存在了（已合并进 `token-query-sam-deploy-policy`）：

| 策略名（已删除） | 当时解决的问题 |
|---|---|
| `token-query-sam-deploy-policy-patch` | 补 S3 bucket 的 PublicAccessBlock/BucketPolicy/Delete 权限；补 `token-query-function` 这个具体函数名的 AddPermission/RemovePermission/TagResource；补对应日志组权限 |
| `token-query-sam-deploy-policy-patch2` | 补 `cloudformation:GetTemplateSummary`（SAM 模板含 Transform 时必须） |
| `token-query-sam-deploy-policy-patch3` | 补 `iam:PassRole`（部署角色要把 Lambda 执行角色"传"给 Lambda 服务） |
| `token-query-sam-deploy-policy-patch4` | 补读取 `/token-query/network/*` SSM 参数的权限 |
| `token-query-sam-deploy-policy-patch5` | 补读取 `/token-query/db/*` SSM 参数的权限 |
| `token-query-sam-deploy-policy-patch6` | 补 `token-query-function` 这个具体函数名的 `CreateFunction`/`DeleteFunction`（从零创建/彻底删除 stack 时才会用到，import 场景不需要） |
| `token-query-sam-deploy-policy-patch7` | 补 `apigateway:TagResource`/`UntagResource`（打标签是独立 action，不归 GET/POST/PUT/PATCH/DELETE 管）；补 `token-query-function` 日志组的 `logs:DeleteLogGroup` |

现在这 9 条权限语句全部都在 `infra/iam-template.yaml` 的 `DeployRoleSamDeployPolicy` 资源里，直接看那个文件就是最新真实状态，不用再对照这张表拼权限。

---

## 四、⚠️ 如果以后 IAM 角色被真正"重新创建"（ARN/名字变了），要同步改的地方

只要还是用 **import** 方式管理（现在就是这样），角色名字、ARN 永远不变，下面这些都不用动。**只有**在某天角色被彻底删除重建（比如 `token-query-iam` 这个 stack 本身也走一次"删掉重建"的完整性测试）时，才需要挨个检查：

| 变了什么 | 要同步改的地方 |
|---|---|
| **部署角色 ARN 变了**（`github-actions-token-query-deploy-role` 重建） | GitHub 仓库 Secrets 里的 `AWS_DEPLOY_ROLE_ARN` 改成新 ARN |
| **Lambda 执行角色 ARN 变了**（`token-query-function-role-*` 重建，注意重建的话默认会带一个新的随机后缀） | GitHub 仓库 Variables 里的 `LAMBDA_EXECUTION_ROLE_ARN` 改成新 ARN；`infra/samconfig.toml` 里 `parameter_overrides` 那行的 `LambdaExecutionRoleArn` 也要同步改（本地手动部署用） |
| **GitHub OIDC Provider 被删了重建** | 一般不会变（同一个 URL/ClientId 生成的 Provider ARN 是固定的 `arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`），但 Thumbprint 可能需要重新查一次 |

另外两个**不属于 IAM，但同样"资源重建后地址会变"**的同步点，一起记在这（都是这次全流程测试踩出来的）：

| 变了什么 | 要同步改的地方 |
|---|---|
| **Aurora 集群被删了重建** | endpoint 域名会变——不用手动同步，`db-template.yaml` 会自动发布到 SSM `/token-query/db/cluster-endpoint`，`api` 层自动读取 |
| **`token-query-api` stack 被删了重建**（HTTP API 是全新的 ApiId，自定义域名的 regional target 也会变） | **Cloudflare 那边要手动同步两处**：① `api.doyouadoreme.online` 这条 CNAME 记录，改成新的 `ApiGatewayDomainName`（查法：`aws apigatewayv2 get-domain-name --domain-name api.doyouadoreme.online --region us-west-2 --query 'DomainNameConfigurations[0].ApiGatewayDomainName'`）；② Cloudflare Worker 里手工维护的 `LAMBDA_API_ORIGIN` 环境变量，同步成新的 API 地址 |

---

## 五、快速核对当前配置（诊断用）

```bash
# stack 管的资源列表
aws cloudformation list-stack-resources --stack-name token-query-iam --region us-west-2

# 部署角色信任策略 + inline policy 列表
aws iam get-role --role-name github-actions-token-query-deploy-role --query 'Role.AssumeRolePolicyDocument'
aws iam list-role-policies --role-name github-actions-token-query-deploy-role

# 看某一条 policy 的具体内容（现在应该只有这两个）
aws iam get-role-policy --role-name github-actions-token-query-deploy-role --policy-name token-query-lambda-deploy-policy
aws iam get-role-policy --role-name github-actions-token-query-deploy-role --policy-name token-query-sam-deploy-policy

# Lambda 执行角色挂了哪些托管策略
aws iam list-attached-role-policies --role-name token-query-function-role-qsx6aji9
```

---

## 六、变更这个 stack 的正确姿势

跟 `network`/`db` 一样，**永远先出 change set 预览再执行**，尤其这个 stack 改的是权限，风险更高：

```bash
aws cloudformation create-change-set \
  --stack-name token-query-iam \
  --change-set-name my-change \
  --region us-west-2 \
  --capabilities CAPABILITY_NAMED_IAM \
  --template-body file://infra/iam-template.yaml

aws cloudformation describe-change-set \
  --stack-name token-query-iam --change-set-name my-change --region us-west-2

aws cloudformation execute-change-set \
  --stack-name token-query-iam --change-set-name my-change --region us-west-2
```
