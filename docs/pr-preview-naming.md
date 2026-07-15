# PR 与分支命名规范

本文档定义 Git 分支、Pull Request 标题和 PR Preview 环境的命名规则。目标是让 GitHub Actions 可以稳定地从分支和 PR 标题中提取唯一的 Preview ID，并据此创建、更新和清理 Cloudflare Worker、Lambda、ECS Service、数据库 schema 等临时资源。

## 核心原则

每个 PR 必须有一个唯一、短小、可自动解析的 Preview ID。

推荐格式：

```text
bug-111
feat-222
fix-333
chore-444
hotfix-555
```

Preview ID 必须满足：

- 只使用小写字母、数字和短横线
- 以任务类型开头，例如 `bug`、`feat`、`fix`、`chore`、`hotfix`
- 任务类型后接 Jira/Bug/Issue 数字 ID
- 不包含空格、下划线、斜杠、中文或特殊符号

## 分支命名

分支名使用：

```text
<type>/<preview-id>-<short-description>
```

示例：

```text
bug/bug-111-login-token-expiry
feat/feat-222-user-profile-page
fix/fix-333-api-timeout
chore/chore-444-update-ci
hotfix/hotfix-555-prod-login-error
```

其中：

- `<type>` 表示变更类型
- `<preview-id>` 是后续自动化系统使用的唯一 ID
- `<short-description>` 是英文短描述，仅用于人类阅读

不推荐：

```text
bug-111
pr-bug-111
feature/login-token-expiry
Bug/BUG-111-login-token-expiry
bug/bug_111_login_token_expiry
```

原因：

- `bug-111` 作为完整分支名缺少类型目录和描述
- `pr-bug-111` 把 PR 生命周期状态写进分支名，不适合作为任务来源 ID
- 没有数字 ID 的分支无法稳定生成 Preview ID
- 大写、下划线和特殊字符不利于 DNS、AWS 资源名和脚本处理

## PR 标题命名

PR 标题必须以同一个 Preview ID 开头：

```text
<preview-id>: <description>
```

示例：

```text
bug-111: 修复登录 token 过期问题
feat-222: 添加用户画像页
fix-333: 修复 API 超时
chore-444: 更新 CI 配置
hotfix-555: 修复生产登录错误
```

GitHub Actions 应校验：

```text
分支名中提取出的 Preview ID == PR 标题开头的 Preview ID
```

例如：

```text
Branch:   bug/bug-111-login-token-expiry
PR title: bug-111: 修复登录 token 过期问题
Result:   通过
```

```text
Branch:   bug/bug-111-login-token-expiry
PR title: bug-222: 修复登录 token 过期问题
Result:   拒绝
```

## 自动化提取规则

从分支名中提取 Preview ID：

```regex
^(bug|feat|fix|chore|hotfix)\/((bug|feat|fix|chore|hotfix)-[0-9]+)-[a-z0-9-]+$
```

从 PR 标题中提取 Preview ID：

```regex
^((bug|feat|fix|chore|hotfix)-[0-9]+):
```

建议校验流程：

```text
1. 从分支名提取 branch_preview_id
2. 从 PR 标题提取 title_preview_id
3. 校验二者非空
4. 校验 branch_preview_id == title_preview_id
5. 校验 preview_id 长度不超过 DNS label 和云资源命名限制
```

## Preview 资源派生命名

假设 Preview ID 是：

```text
bug-111
```

Cloudflare Worker：

```text
token-query-pr-bug-111
```

Preview URL：

```text
https://bug-111.app.doyouadoreme.online
```

Lambda：

```text
token-query-pr-bug-111
```

ECS Service：

```text
token-query-go-pr-bug-111
```

Docker image tag：

```text
bug-111-<commit-sha>
```

Cloud Map service：

```text
go-bug-111
```

PostgreSQL schema：

```text
pr_bug_111
```

## 推荐最终格式

标准开发流程中，建议使用：

```text
Branch:
  bug/bug-111-login-token-expiry

PR title:
  bug-111: 修复登录 token 过期问题

Preview ID:
  bug-111

Preview URL:
  https://bug-111.app.doyouadoreme.online
```

这个规范同时兼顾：

- 人类可读
- GitHub Actions 可解析
- DNS 域名安全
- AWS/Cloudflare 资源命名安全
- PR 关闭后的自动清理可追踪
