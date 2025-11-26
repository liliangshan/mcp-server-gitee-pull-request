# MCP Gitee Pull Request 服务器

一个支持多实例的 Gitee Pull Request 创建 MCP 服务器。

## 功能特性

- ✅ 通过 API 在 Gitee 上创建 Pull Request
- ✅ 支持多实例，通过仓库名称隔离
- ✅ 可配置审查人员（assignees 和 testers）
- ✅ 支持标签并验证格式
- ✅ 支持草稿 PR
- ✅ 操作日志记录
- ✅ 错误处理和恢复

## 安装

### 全局安装（推荐）
```bash
npm install -g @liangshanli/mcp-server-gitee-pull-request
```

### 本地安装
```bash
npm install @liangshanli/mcp-server-gitee-pull-request
```

### 从源码安装
```bash
git clone https://github.com/liliangshan/mcp-server-gitee-pull-request.git
cd mcp-server-gitee-pull-request
npm install
```

## 配置

设置环境变量：

```bash
# 必需：Gitee 账号凭证（使用 scope_ 前缀避免与系统环境变量冲突）
export scope_username="your-email@example.com"
export scope_password="your-password"

# 必需：OAuth 应用凭证
# 在以下地址创建 OAuth 应用：https://gitee.com/oauth/applications
export scope_client_id="your_client_id"
export scope_client_secret="your_client_secret"

# 注意：OAuth 权限范围已硬编码为 "user_info pull_requests enterprises"

# 必需：仓库所属空间地址（企业、组织或个人的地址path）
export owner="your-username-or-org"

# 必需：仓库路径(path)
export repo="your-repo-name"

# 必需：Pull Request 提交的源分支（要合并的分支）
# 可以只输入分支名（如 "dev"），会自动格式化为 "branch (dev)"
export head="dev"

# 必需：Pull Request 提交目标分支的名称（合并到的分支）
# 可以只输入分支名（如 "main"），会自动格式化为 "branch (main)"
export base="main"

# 可选：审查人员username，可多个，半角逗号分隔
export assignees="username1,username2"

# 可选：测试人员username，可多个，半角逗号分隔
# 注意：当仓库代码审查设置中已设置【指派测试人员】则此选项无效
export testers="tester1,tester2"

# 可选：默认标签（用逗号分开的标签）
# 每个标签名称要求长度在 2-20 之间且非特殊字符（仅支持字母、数字、下划线、中文）
# 示例："bug,performance,enhancement"
# 如果在工具调用时提供了 labels 参数，将覆盖此环境变量
export labels="bug,performance"

# 可选：项目名称（用于多实例支持）
# REPO_NAME 会自动从 repo 仓库名生成
export PROJECT_NAME="custom-mgit"
```

### 获取 OAuth 应用凭证

1. 访问 [Gitee OAuth 应用](https://gitee.com/oauth/applications) 创建您的应用
2. 点击"创建应用"
3. 填写应用信息：
   - 应用名称：您的应用名称
   - 应用主页：您的应用 URL（可以是任何有效的 URL）
   - 应用描述：应用的描述
4. 创建后，您将获得 `client_id` 和 `client_secret`
5. 将它们与您的 Gitee 账号凭证一起设置为环境变量

**注意：** 访问令牌会在需要时通过 OAuth 自动获取。您也可以使用 `token` 工具手动获取令牌。

## 使用方法

### 1. 直接运行（全局安装）
```bash
mcp-server-gitee-pull-request
```

### 2. 使用 npx（推荐）
```bash
npx @liangshanli/mcp-server-gitee-pull-request
```

### 3. 直接启动（源码安装）
```bash
npm start
```

### 4. 托管启动（生产环境推荐）
```bash
npm run start-managed
```

## IDE 配置

### Cursor / VS Code

添加到 MCP 设置（`.cursor/mcp.json` 或 VS Code 设置）：

```json
{
  "mcpServers": {
    "gitee-pr": {
      "command": "npx",
      "args": [
        "-y",
        "@liangshanli/mcp-server-gitee-pull-request"
      ],
      "env": {
        "scope_username": "your-email@example.com",
        "scope_password": "your-password",
        "scope_client_id": "your_client_id",
        "scope_client_secret": "your_client_secret",
        "owner": "your-username-or-org",
        "repo": "your-repo-name",
        "head": "dev",
        "base": "main",
        "assignees": "username1,username2",
        "testers": "tester1,tester2",
        "labels": "bug,performance",
        "PROJECT_NAME": "custom-mgit"
      }
    }
  }
}
```

### 多实例配置

您可以为不同的仓库运行多个实例。`REPO_NAME` 会自动从 `repo` 仓库名生成。使用 `PROJECT_NAME` 来区分不同的实例：

```json
{
  "mcpServers": {
    "gitee-pr-repo1": {
      "command": "npx",
      "args": ["-y", "@liangshanli/mcp-server-gitee-pull-request"],
      "env": {
        "scope_username": "your-email@example.com",
        "scope_password": "your-password",
        "scope_client_id": "your_client_id",
        "scope_client_secret": "your_client_secret",
        "owner": "org1",
        "repo": "repo1",
        "head": "dev",
        "base": "main",
        "PROJECT_NAME": "custom-mgit"
      }
    },
    "gitee-pr-repo2": {
      "command": "npx",
      "args": ["-y", "@liangshanli/mcp-server-gitee-pull-request"],
      "env": {
        "scope_username": "your-email@example.com",
        "scope_password": "your-password",
        "scope_client_id": "your_client_id",
        "scope_client_secret": "your_client_secret",
        "owner": "org2",
        "repo": "repo2",
        "head": "dev",
        "base": "master",
        "PROJECT_NAME": "custom-mgit"
      }
    }
  }
}
```

## 可用工具

### `pr`

在 Gitee 上创建 Pull Request。

**参数：**
- `title`（必需）：Pull Request 标题
- `body`（可选）：Pull Request 描述/正文
- `draft`（可选）：是否为草稿 PR（默认：`false`）

**注意：** 标签可以通过 `labels` 环境变量配置。如果设置了，将自动添加到该工具创建的所有 Pull Request 中。

**示例：**
```json
{
  "title": "添加新功能",
  "body": "此 PR 添加了一个新功能以提升性能。",
  "labels": "enhancement,performance",
  "draft": false
}
```

**响应：**
```json
{
  "success": true,
  "pull_request": {
    "id": 12345,
    "number": 42,
    "title": "添加新功能",
    "html_url": "https://gitee.com/owner/repo/pulls/42",
    ...
  },
  "url": "https://gitee.com/owner/repo/pulls/42",
  "number": 42,
  "message": "Pull Request created successfully. PR #42: 添加新功能"
}
```

### `logs`

获取操作日志用于调试和监控。

**参数：**
- `limit`（可选）：限制数量，默认 50，最大 1000
- `offset`（可选）：偏移量，默认 0

**示例：**
```json
{
  "limit": 10,
  "offset": 0
}
```

## 多实例支持

此服务器通过 `REPO_NAME` 支持多实例，`REPO_NAME` 会自动从 `repo` 仓库名生成。工具名称会以仓库名称作为前缀，避免冲突。

**注意：** `PROJECT_NAME` 是可选的，仅用于工具描述的品牌标识，不影响工具命名。

**示例：**
- 设置 `repo="mcp-server-gitee-pull-request"`：工具名称为 `mcp-server-gitee-pull-request_pr`
- 设置 `repo="my-project"`：工具名称为 `my-project_pr`

这允许您同时为不同的仓库运行多个实例。

## 日志记录

所有操作都会记录到文件中，用于调试和监控：

- **日志目录**：`.setting/` 或 `.setting.<REPO_NAME>/`（可通过 `MCP_LOG_DIR` 配置）
- **日志文件**：`mcp-gitee-pr.log`（可通过 `MCP_LOG_FILE` 配置）

日志包括：
- 请求参数
- 响应数据
- 错误消息
- 时间戳

## API 参考

此服务器使用 Gitee API v5：

- **端点**：`POST https://gitee.com/api/v5/repos/{owner}/{repo}/pulls`
- **Content-Type**：`application/json;charset=UTF-8`
- **认证**：通过查询参数传递访问令牌

更多信息，请参阅 [Gitee API 文档](https://gitee.com/api/v5/swagger#/postV5ReposOwnerRepoPulls)。

## 错误处理

服务器处理各种错误场景：

- **缺少必需参数**：返回清晰的错误消息
- **无效标签**：验证标签格式（2-20 个字符，仅允许字母数字/下划线/中文）
- **API 错误**：返回 Gitee API 错误消息和状态码
- **网络错误**：优雅处理连接失败

## 故障排除

### 常见问题

1. **401 未授权**：检查您的 `access_token` 是否有效且具有所需权限
2. **404 未找到**：验证 `owner` 和 `repo` 是否正确
3. **422 无法处理的实体**：检查分支名称（`head` 和 `base`）是否存在且有效
4. **无效标签**：确保标签为 2-20 个字符且仅包含允许的字符

### 调试模式

通过检查 `.setting/` 目录中的日志文件来启用详细日志记录。

## 许可证

MIT

## 作者

liliangshan

## 仓库

https://github.com/liliangshan/mcp-server-gitee-pull-request

