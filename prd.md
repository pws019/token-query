# GitHub Token 个人信息功能简版 PRD

## 1. 功能目标

实现一个独立的“个人信息”页面，用户输入自己的 GitHub Personal Access Token 后，可以查询 GitHub 当前账户信息，并通过 Drizzle 将查询结果保存到 PostgreSQL 数据库中。同时提供删除按钮，可以删除数据库中已保存的 GitHub 用户信息。

本功能只做最小 MVP，不做登录、不做 OAuth、不做多用户系统。

## 2. 页面路径

新增页面：

```text
/profile
```

页面名称：

```text
个人信息
```

## 3. 页面元素

页面需要包含：

1. 标题：个人信息
2. GitHub Token 输入框
3. 查询按钮
4. 删除按钮
5. 查询结果展示区域
6. 返回首页按钮，可选

页面结构示例：

```text
个人信息

GitHub Token:
[请输入 GitHub Token]

[查询] [删除]

查询结果：
头像
GitHub ID
用户名 login
昵称 name
个人主页 htmlUrl
简介 bio
公开仓库数 publicRepos
粉丝数 followers
关注数 following
```

## 4. 用户交互

### 4.1 查询 GitHub 个人信息

用户输入 GitHub Token 后，点击“查询”。

前端请求：

```http
POST /api/github/profile
```

请求体：

```json
{
  "token": "github_personal_access_token"
}
```

后端逻辑：

1. 接收 token。
2. 如果 token 为空，返回错误。
3. 使用 token 请求 GitHub API：

```http
GET https://api.github.com/user
```

请求头：

```http
Authorization: Bearer {token}
Accept: application/vnd.github+json
```

4. 从 GitHub 返回结果中提取个人信息。
5. 使用 Drizzle 将信息保存到数据库。
6. 如果数据库中已经存在同一个 githubId，则更新该记录。
7. 返回保存后的 profile 给前端。
8. 前端展示 profile 信息。

### 4.2 删除 GitHub 个人信息

用户点击“删除”。

前端请求：

```http
DELETE /api/github/profile
```

后端逻辑：

1. 删除 `github_profiles` 表中的已保存数据。
2. 返回 `{ "success": true }`。
3. 前端清空展示区域。

MVP 阶段只需要支持保存和删除一条 GitHub Profile 数据。

## 5. 数据库设计

使用 PostgreSQL + Drizzle。

新增表：

```ts
export const githubProfiles = pgTable('github_profiles', {
  id: serial('id').primaryKey(),
  githubId: integer('github_id').notNull().unique(),
  login: text('login').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  htmlUrl: text('html_url'),
  bio: text('bio'),
  publicRepos: integer('public_repos').default(0).notNull(),
  followers: integer('followers').default(0).notNull(),
  following: integer('following').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})
```

字段说明：

| 字段          | 说明           |
| ----------- | ------------ |
| id          | 本地数据库主键      |
| githubId    | GitHub 用户 ID |
| login       | GitHub 用户名   |
| name        | GitHub 昵称    |
| avatarUrl   | 头像地址         |
| htmlUrl     | GitHub 个人主页  |
| bio         | 个人简介         |
| publicRepos | 公开仓库数量       |
| followers   | 粉丝数          |
| following   | 关注数          |
| createdAt   | 创建时间         |
| updatedAt   | 更新时间         |

## 6. API 设计

### 6.1 查询并保存 GitHub Profile

```http
POST /api/github/profile
```

请求体：

```json
{
  "token": "github_personal_access_token"
}
```

成功返回：

```json
{
  "profile": {
    "githubId": 123456,
    "login": "octocat",
    "name": "The Octocat",
    "avatarUrl": "https://github.com/images/error/octocat_happy.gif",
    "htmlUrl": "https://github.com/octocat",
    "bio": "GitHub mascot",
    "publicRepos": 8,
    "followers": 999,
    "following": 9
  }
}
```

失败返回：

```json
{
  "error": "GitHub information query failed. Please check your token."
}
```

### 6.2 删除 GitHub Profile

```http
DELETE /api/github/profile
```

成功返回：

```json
{
  "success": true
}
```

失败返回：

```json
{
  "error": "Delete failed. Please try again."
}
```

## 7. 前端状态

### 7.1 初始状态

页面初始不展示用户信息，只展示 Token 输入框和按钮。

### 7.2 查询中

点击查询后：

* 查询按钮进入 loading 状态。
* 禁止重复点击。
* 请求完成后恢复按钮状态。

### 7.3 查询成功

展示 GitHub 用户信息：

* 头像
* GitHub ID
* 用户名
* 昵称
* 个人主页
* 简介
* 公开仓库数量
* 粉丝数
* 关注数

### 7.4 查询失败

展示错误提示：

```text
GitHub information query failed. Please check your token.
```

### 7.5 删除成功

* 清空用户信息展示区域。
* 展示提示：

```text
Deleted successfully.
```

## 8. 技术要求

后端：

* 使用 Hono 实现接口。
* 使用 fetch 请求 GitHub API。
* 使用 Drizzle 操作 PostgreSQL。
* 不要把 GitHub Token 保存到数据库。
* 不要把 GitHub Token 打印到日志。

前端：

* 实现 `/profile` 页面。
* 提供 token 输入框。
* 调用查询接口。
* 调用删除接口。
* 展示查询结果。
* 展示基础 loading 和 error 状态。

数据库：

* 使用 Drizzle 创建 `github_profiles` 表。
* 支持插入、更新和删除 GitHub Profile。
* 查询接口使用 upsert 逻辑，避免重复插入同一个 GitHub 用户。

## 9. MVP 不做内容

本功能不做：

* GitHub OAuth 登录
* 多用户系统
* 用户注册登录
* Token 持久化保存
* GitHub 仓库列表
* GitHub 组织信息
* 多条 Profile 管理
* 权限系统
* 复杂 UI 美化

## 10. 验收标准

1. 可以打开 `/profile` 页面。
2. 页面有 GitHub Token 输入框。
3. 输入有效 GitHub Token 后，点击查询，可以成功获取 GitHub 个人信息。
4. 查询成功后，GitHub 信息写入 PostgreSQL 数据库。
5. 查询成功后，页面展示 GitHub 个人信息。
6. 再次查询同一个 GitHub 账号时，不重复插入，而是更新已有记录。
7. 点击删除按钮后，数据库中的 GitHub Profile 被删除。
8. 删除成功后，页面清空展示内容。
9. Token 不保存到数据库。
10. Token 不输出到日志。

## 11. 一句话版本

实现一个 `/profile` 页面：用户输入 GitHub Token，点击查询后调用 GitHub `/user` API 获取个人信息，并用 Drizzle 保存到 PostgreSQL；点击删除后删除数据库中的这条 GitHub 用户信息。


## teset
add something
