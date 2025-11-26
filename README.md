# MCP Gitee Pull Request Server

A MCP server for creating Pull Requests on Gitee with multiple instance support.

## Features

- ✅ Create Pull Requests on Gitee via API
- ✅ Multiple instance support with repository name isolation
- ✅ Configurable reviewers (assignees and testers)
- ✅ Label support with validation
- ✅ Draft PR support
- ✅ Operation logging
- ✅ Error handling and recovery

## Installation

### Global Installation (Recommended)
```bash
npm install -g @liangshanli/mcp-server-gitee-pull-request
```

### Local Installation
```bash
npm install @liangshanli/mcp-server-gitee-pull-request
```

### From Source
```bash
git clone https://github.com/liliangshan/mcp-server-gitee-pull-request.git
cd mcp-server-gitee-pull-request
npm install
```

## Configuration

Set environment variables:

```bash
# Required: Gitee account credentials (with scope_ prefix to avoid system env conflicts)
export scope_username="your-email@example.com"
export scope_password="your-password"

# Required: OAuth application credentials
# Create an OAuth application at: https://gitee.com/oauth/applications
export scope_client_id="your_client_id"
export scope_client_secret="your_client_secret"

# Note: OAuth scope is hardcoded as "user_info pull_requests enterprises"

# Required: Repository owner (organization or user path)
export owner="your-username-or-org"

# Required: Repository name
export repo="your-repo-name"

# Required: Source branch (the branch to merge from)
# You can input just the branch name (e.g., "dev") and it will be auto-formatted to "branch (dev)"
export head="dev"

# Required: Target branch (the branch to merge into)
# You can input just the branch name (e.g., "main") and it will be auto-formatted to "branch (main)"
export base="main"

# Optional: Reviewers (comma-separated usernames)
export assignees="username1,username2"

# Optional: Testers (comma-separated usernames)
# Note: This option is invalid if reviewers are assigned in repository settings
export testers="tester1,tester2"

# Optional: Default labels (comma-separated)
# Each label must be 2-20 characters and contain only alphanumeric characters, underscores, or Chinese characters
# Example: "bug,performance,enhancement"
# If labels are provided in the tool call, they will override this environment variable
export labels="bug,performance"

# Optional: Project name for multi-instance support
# REPO_NAME is auto-generated from repo name
export PROJECT_NAME="custom-mgit"
```

### Getting OAuth Application Credentials

1. Go to [Gitee OAuth Applications](https://gitee.com/oauth/applications) to create your application
2. Click "创建应用" (Create Application)
3. Fill in the application details:
   - Application Name: Your application name
   - Application URL: Your application URL (can be any valid URL)
   - Application Description: Description of your application
4. After creation, you'll get `client_id` and `client_secret`
5. Set them as environment variables along with your Gitee account credentials

**Note:** The access token is automatically obtained using OAuth when needed. You can also use the `token` tool to manually retrieve a token.

## Usage

### 1. Direct Run (Global Installation)
```bash
mcp-server-gitee-pull-request
```

### 2. Using npx (Recommended)
```bash
npx @liangshanli/mcp-server-gitee-pull-request
```

### 3. Direct Start (Source Installation)
```bash
npm start
```

### 4. Managed Start (Recommended for Production)
```bash
npm run start-managed
```

## IDE Configuration

### Cursor / VS Code

Add to your MCP settings (`.cursor/mcp.json` or VS Code settings):

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

### Multiple Instance Configuration

You can run multiple instances for different repositories. The `REPO_NAME` is auto-generated from `repo` name. Use `PROJECT_NAME` to distinguish different instances:

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

## Available Tools

### `pr`

Create a Pull Request on Gitee.

**Parameters:**
- `title` (required): Pull Request title
- `body` (optional): Pull Request description/body
- `draft` (optional): Whether this is a draft PR (default: `false`)

**Note:** Labels can be configured via the `labels` environment variable. If set, they will be automatically added to all Pull Requests created by this tool.

**Example:**
```json
{
  "title": "Add new feature",
  "body": "This PR adds a new feature to improve performance.",
  "labels": "enhancement,performance",
  "draft": false
}
```

**Response:**
```json
{
  "success": true,
  "pull_request": {
    "id": 12345,
    "number": 42,
    "title": "Add new feature",
    "html_url": "https://gitee.com/owner/repo/pulls/42",
    ...
  },
  "url": "https://gitee.com/owner/repo/pulls/42",
  "number": 42,
  "message": "Pull Request created successfully. PR #42: Add new feature"
}
```

### `token`

Get Gitee access token using OAuth.

This tool retrieves an access token from Gitee OAuth API using the configured credentials. The token is cached in memory and will be automatically refreshed when needed.

**Parameters:** None

**Example:**
```json
{}
```

**Response:**
```json
{
  "success": true,
  "access_token": "your_access_token_here",
  "expires_at": "2025-11-26T12:00:00.000Z",
  "message": "Access token retrieved successfully"
}
```

**Note:** The token is automatically used when creating Pull Requests, so you typically don't need to call this tool manually.

### `logs`

Get operation logs for debugging and monitoring.

**Parameters:**
- `limit` (optional): Limit count, default 50, max 1000
- `offset` (optional): Offset, default 0

**Example:**
```json
{
  "limit": 10,
  "offset": 0
}
```

## Multiple Instance Support

This server supports multiple instances through the `REPO_NAME` which is automatically generated from `repo` name. Tool names are prefixed with the repository name to avoid conflicts.

**Note:** `PROJECT_NAME` is optional and only used for tool description branding. It does not affect tool naming.

**Example:**
- With `repo="mcp-server-gitee-pull-request"`: Tool name is `mcp-server-gitee-pull-request_pr`
- With `repo="my-project"`: Tool name is `my-project_pr`

This allows you to run multiple instances for different repositories simultaneously.

## Logging

All operations are logged to files for debugging and monitoring:

- **Log Directory**: `.setting/` or `.setting.<REPO_NAME>/` (configurable via `MCP_LOG_DIR`)
- **Log File**: `mcp-gitee-pr.log` (configurable via `MCP_LOG_FILE`)

Logs include:
- Request parameters
- Response data
- Error messages
- Timestamps

## API Reference

This server uses the Gitee API v5:

- **Endpoint**: `POST https://gitee.com/api/v5/repos/{owner}/{repo}/pulls`
- **Content-Type**: `application/json;charset=UTF-8`
- **Authentication**: Access token via query parameter

For more information, see [Gitee API Documentation](https://gitee.com/api/v5/swagger#/postV5ReposOwnerRepoPulls).

## Error Handling

The server handles various error scenarios:

- **Missing required parameters**: Returns clear error messages
- **Invalid labels**: Validates label format (2-20 chars, alphanumeric/underscore/Chinese only)
- **API errors**: Returns Gitee API error messages with status codes
- **Network errors**: Handles connection failures gracefully

## Troubleshooting

### Common Issues

1. **401 Unauthorized**: Check your `access_token` is valid and has required scopes
2. **404 Not Found**: Verify `owner` and `repo` are correct
3. **422 Unprocessable Entity**: Check branch names (`head` and `base`) exist and are valid
4. **Invalid labels**: Ensure labels are 2-20 characters and contain only allowed characters

### Debug Mode

Enable detailed logging by checking the log files in `.setting/` directory.

## License

MIT

## Author

liliangshan

## Repository

https://github.com/liliangshan/mcp-server-gitee-pull-request
