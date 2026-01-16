const https = require('https');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

const operationLogs = [];
const MAX_LOGS = 1000;

const TOOL_PREFIX = process.env.TOOL_PREFIX || '';
const LANGUAGE = process.env.LANGUAGE || 'en';

const parseMultiInstance = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return []; }
  }
  return [];
};

const MULTI_INSTANCE = parseMultiInstance(process.env.MULTI_INSTANCE);

let CUSTOM_LOG_DIR = null;

const getLogConfig = (repoName = '') => {
  const logDir = process.env.LOG_DIR || CUSTOM_LOG_DIR;
  if (!logDir) {
    throw new Error('LOG_DIR not configured. Please call set_log_dir tool to set the log directory.');
  }

  const prefix = TOOL_PREFIX ? `${TOOL_PREFIX}.` : '';
  const logFile = `mcp-gitee-pr${repoName ? `.${repoName}` : ''}.log`;

  return {
    dir: logDir,
    file: `${prefix}${logFile}`,
    fullPath: path.join(logDir, `${prefix}${logFile}`)
  };
};

const ensureLogDir = (repoName = '') => {
  const { dir } = getLogConfig(repoName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const logRequest = (method, params, result, error = null, repoName = '') => {
  const logEntry = {
    id: Date.now(),
    method,
    params: JSON.stringify(params),
    result: result ? JSON.stringify(result) : null,
    error: error ? error.toString() : null,
    created_at: new Date().toISOString()
  };

  operationLogs.unshift(logEntry);
  if (operationLogs.length > MAX_LOGS) {
    operationLogs.splice(MAX_LOGS);
  }

  const logLine = `${logEntry.created_at} | ${method} | ${logEntry.params} | ${error || 'SUCCESS'} | RESPONSE: ${logEntry.result || 'null'}\n`;

  try {
    ensureLogDir(repoName);
    const { fullPath } = getLogConfig(repoName);
    fs.appendFileSync(fullPath, logLine, 'utf8');
  } catch (err) {
    console.error('Failed to write log file:', err.message);
  }
};

class FinalMCPServer {
  constructor() {
    this.name = 'mcp-gitee-pr-server-multi';
    this.version = '1.0.0';
    this.initialized = false;

    // Cache access tokens for each instance
    this.tokenCache = {};
  }

  // Get credentials for a specific instance
  getInstanceCredentials(instance) {
    return {
      username: instance.USERNAME || process.env.USERNAME || '',
      password: instance.PASSWORD || process.env.PASSWORD || '',
      clientId: instance.CLIENT_ID || process.env.CLIENT_ID || '',
      clientSecret: instance.CLIENT_SECRET || process.env.CLIENT_SECRET || '',
      scope: instance.SCOPE || 'user_info pull_requests enterprises'
    };
  }

  // Get access token for a specific instance
  async getAccessToken(instance, repoName) {
    const cacheKey = repoName;
    const now = Date.now();
    const cached = this.tokenCache[cacheKey];

    // Return cached token if still valid (with 5 minutes buffer)
    if (cached && cached.expiresAt > now + 5 * 60 * 1000) {
      return cached.token;
    }

    const credentials = this.getInstanceCredentials(instance);

    return new Promise((resolve, reject) => {
      const params = new URLSearchParams();
      params.append('grant_type', 'password');
      params.append('username', credentials.username);
      params.append('password', credentials.password);
      params.append('client_id', credentials.clientId);
      params.append('client_secret', credentials.clientSecret);
      params.append('scope', credentials.scope);
      const postData = params.toString();

      const options = {
        hostname: 'gitee.com',
        port: 443,
        path: '/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
          'User-Agent': 'mcp-server-gitee-pr-multi/1.0.0'
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(responseData);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const token = parsed.access_token;
              const expiresIn = parsed.expires_in || 3600;
              this.tokenCache[cacheKey] = {
                token: token,
                expiresAt: now + expiresIn * 1000
              };
              resolve(token);
            } else {
              reject({
                statusCode: res.statusCode,
                error: parsed.error_description || parsed.error || 'Unknown error',
                data: parsed
              });
            }
          } catch (err) {
            reject({
              statusCode: res.statusCode,
              error: `Failed to parse response: ${err.message}`,
              rawResponse: responseData
            });
          }
        });
      });

      req.on('error', (err) => {
        reject({
          statusCode: 0,
          error: `Request failed: ${err.message}`
        });
      });

      req.write(postData);
      req.end();
    });
  }

  // Make HTTPS request to Gitee API
  async makeGiteeRequest(instance, repoName, method, path, data = null) {
    const token = await this.getAccessToken(instance, repoName);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'gitee.com',
        port: 443,
        path: `/api/v5${path}${path.includes('?') ? '&' : '?'}access_token=${token}`,
        method: method,
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'User-Agent': 'mcp-server-gitee-pr-multi/1.0.0'
        }
      };

      const req = https.request(options, (res) => {
        let responseData = '';

        res.on('data', (chunk) => {
          responseData += chunk;
        });

        res.on('end', () => {
          const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

          if (isSuccess && (!responseData || responseData.trim() === '')) {
            resolve({ statusCode: res.statusCode, data: null });
            return;
          }

          try {
            const parsed = JSON.parse(responseData);
            if (isSuccess) {
              resolve({ statusCode: res.statusCode, data: parsed });
            } else {
              reject({
                statusCode: res.statusCode,
                error: parsed.error_description || parsed.message || parsed.error || 'Unknown error',
                data: parsed
              });
            }
          } catch (err) {
            if (isSuccess) {
              resolve({ statusCode: res.statusCode, data: responseData || null, rawResponse: responseData });
            } else {
              reject({
                statusCode: res.statusCode,
                error: `Failed to parse response: ${err.message}`,
                rawResponse: responseData
              });
            }
          }
        });
      });

      req.on('error', (err) => {
        reject({
          statusCode: 0,
          error: `Request failed: ${err.message}`
        });
      });

      if (data) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  // Format branch name
  formatBranchName(branchName) {
    if (!branchName || typeof branchName !== 'string') {
      return branchName;
    }
    const trimmed = branchName.trim();
    if (/^branch\s*\([^)]+\)$/i.test(trimmed)) {
      return trimmed;
    }
    return `branch (${trimmed})`;
  }

  // PR tool
  async pr(params, toolContext = {}) {
    const { title, body, draft } = params;
    const { REPO_NAME, PROJECT_PATH, OWNER, REPO, HEAD_RAW, BASE_RAW, ASSIGNEES, TESTERS, LABELS_ENV, AUTO_REVIEW, AUTO_TEST, AUTO_MERGE } = toolContext;

    if (!title || typeof title !== 'string' || title.trim() === '') {
      throw new Error('Missing or invalid title parameter');
    }

    // Find the instance configuration
    const instance = MULTI_INSTANCE.find(i => i.REPO_NAME === REPO_NAME);
    if (!instance) {
      throw new Error(`Repository not found: ${REPO_NAME}`);
    }

    // Build request body
    const HEAD = this.formatBranchName(HEAD_RAW);
    const BASE = this.formatBranchName(BASE_RAW);

    const requestBody = {
      title: title.trim(),
      head: HEAD_RAW,
      base: BASE_RAW,
      body: body || '',
      draft: draft === true || draft === 'true' || draft === 'false' ? (draft === true || draft === 'true') : false
    };

    // Add optional fields
    if (ASSIGNEES && ASSIGNEES.trim() !== '') {
      requestBody.assignees = ASSIGNEES.split(',').map(s => s.trim()).filter(s => s !== '');
    }

    if (TESTERS && TESTERS.trim() !== '') {
      requestBody.testers = TESTERS.split(',').map(s => s.trim()).filter(s => s !== '');
    }

    // Process labels
    if (LABELS_ENV && LABELS_ENV.trim() !== '') {
      const labelArray = LABELS_ENV.split(',').map(s => s.trim()).filter(s => s !== '');
      const validLabels = [];
      for (const label of labelArray) {
        if (label.length < 2 || label.length > 20) {
          console.error(`Warning: Invalid label "${label}" (length must be between 2 and 20 characters)`);
          continue;
        }
        if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(label)) {
          console.error(`Warning: Invalid label "${label}" (contains special characters)`);
          continue;
        }
        validLabels.push(label);
      }
      if (validLabels.length > 0) {
        requestBody.labels = validLabels;
      }
    }

    try {
      const apiPath = `/repos/${OWNER}/${REPO}/pulls`;
      const result = await this.makeGiteeRequest(instance, REPO_NAME, 'POST', apiPath, requestBody);

      // Auto review if enabled
      let reviewResult = null;
      if (AUTO_REVIEW && result.data && result.data.number) {
        try {
          const reviewApiPath = `/repos/${OWNER}/${REPO}/pulls/${result.data.number}/review`;
          reviewResult = await this.makeGiteeRequest(instance, REPO_NAME, 'POST', reviewApiPath, { force: false });
        } catch (reviewErr) {
          console.error(`Auto review failed: ${reviewErr.error || reviewErr.message}`);
        }
      }

      // Auto test if enabled
      let testResult = null;
      if (AUTO_TEST && result.data && result.data.number) {
        try {
          const testApiPath = `/repos/${OWNER}/${REPO}/pulls/${result.data.number}/test`;
          testResult = await this.makeGiteeRequest(instance, REPO_NAME, 'POST', testApiPath, { force: false });
        } catch (testErr) {
          console.error(`Auto test failed: ${testErr.error || testErr.message}`);
        }
      }

      // Auto merge if enabled
      let mergeResult = null;
      if (AUTO_MERGE && result.data && result.data.number) {
        const shouldMerge = (!AUTO_TEST || testResult !== null);
        if (shouldMerge) {
          try {
            const mergeApiPath = `/repos/${OWNER}/${REPO}/pulls/${result.data.number}/merge`;
            mergeResult = await this.makeGiteeRequest(instance, REPO_NAME, 'PUT', mergeApiPath, null);
          } catch (mergeErr) {
            console.error(`Auto merge failed: ${mergeErr.error || mergeErr.message}`);
          }
        }
      }

      logRequest('pr', { title, body, draft, repo: REPO_NAME }, result, null, REPO_NAME);

      return {
        success: true,
        pull_request: result.data,
        response: result.data,
        url: result.data.html_url || result.data.url || null,
        number: result.data.number || null,
        message: `Pull Request created successfully!\n\nPR Details:\n- Number: #${result.data.number || 'N/A'}\n- Title: ${result.data.title || title}\n- URL: ${result.data.html_url || result.data.url || 'N/A'}`
      };
    } catch (err) {
      logRequest('pr', { title, body, draft, repo: REPO_NAME }, null, err.error || err.message, REPO_NAME);
      return {
        success: false,
        error: `Gitee Pull Request creation failed: ${err.error || err.message}${err.statusCode ? ` (Status: ${err.statusCode})` : ''}`,
        statusCode: err.statusCode || null,
        message: `Failed to create Pull Request. Error: ${err.error || err.message}`
      };
    }
  }

  // Token tool
  async token(params, toolContext = {}) {
    const { REPO_NAME } = toolContext;

    const instance = MULTI_INSTANCE.find(i => i.REPO_NAME === REPO_NAME);
    if (!instance) {
      throw new Error(`Repository not found: ${REPO_NAME}`);
    }

    try {
      const token = await this.getAccessToken(instance, REPO_NAME);
      logRequest('token', { repo: REPO_NAME }, { success: true, token: token.substring(0, 10) + '...' }, null, REPO_NAME);
      return {
        success: true,
        access_token: token,
        message: 'Access token retrieved successfully'
      };
    } catch (err) {
      logRequest('token', { repo: REPO_NAME }, null, err.error || err.message, REPO_NAME);
      throw new Error(`Failed to get access token: ${err.error || err.message}${err.statusCode ? ` (Status: ${err.statusCode})` : ''}`);
    }
  }

  // Logs tool
  async logs(params, toolContext = {}) {
    const { limit = 50, offset = 0 } = params || {};

    if (typeof limit !== 'number' || limit < 1 || limit > 1000) {
      throw new Error('Invalid limit parameter. Must be a number between 1 and 1000');
    }

    if (typeof offset !== 'number' || offset < 0) {
      throw new Error('Invalid offset parameter. Must be a non-negative number');
    }

    const logs = operationLogs.slice(offset, offset + limit);

    return {
      total: operationLogs.length,
      limit,
      offset,
      logs: logs
    };
  }

  // Set log directory
  async set_log_dir(params, toolContext = {}) {
    const { log_dir } = params;

    if (!log_dir || typeof log_dir !== 'string') {
      throw new Error('log_dir parameter must be a non-empty string');
    }

    const resolvedPath = path.resolve(log_dir);

    if (!fs.existsSync(resolvedPath)) {
      fs.mkdirSync(resolvedPath, { recursive: true });
    }

    CUSTOM_LOG_DIR = resolvedPath;

    return {
      success: true,
      log_dir: resolvedPath,
      message: `Log directory set to: ${resolvedPath}`
    };
  }

  async handleRequest(request) {
    let result = null;
    let error = null;
    let method = null;
    let params = null;
    let id = null;

    try {
      if (!request || typeof request !== 'object') {
        throw new Error('Invalid request: request must be an object');
      }

      if (request.jsonrpc !== '2.0') {
        throw new Error('Unsupported JSON-RPC version. Only 2.0 is supported.');
      }

      method = request.method;
      params = request.params;
      id = request.id;

      if (!method || typeof method !== 'string') {
        throw new Error('Invalid request: method is required and must be a string');
      }

      if (method === 'initialize') {
        if (!this.initialized) {
          this.initialized = true;
        }

        const serverCapabilities = {
          tools: { listChanged: false }
        };

        if (params?.capabilities?.prompts) {
          serverCapabilities.prompts = { listChanged: false };
        }
        if (params?.capabilities?.resources) {
          serverCapabilities.resources = { listChanged: false };
        }
        if (params?.capabilities?.logging) {
          serverCapabilities.logging = { listChanged: false };
        }
        if (params?.capabilities?.roots) {
          serverCapabilities.roots = { listChanged: false };
        }

        result = {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: serverCapabilities,
          serverInfo: {
            name: this.name,
            version: this.version
          }
        };
      } else if (method === 'tools/list') {
        const getToolName = (baseName) => {
          return TOOL_PREFIX ? `${TOOL_PREFIX}_${baseName}` : baseName;
        };

        const getToolDescription = (baseDescription) => {
          if (PROJECT_NAME) {
            return `[${PROJECT_NAME}] ${baseDescription}`;
          }
          return baseDescription;
        };

        const getRepoEnum = () => {
          return MULTI_INSTANCE.length > 0 ? MULTI_INSTANCE.map(i => i.REPO_NAME) : [];
        };

        const tools = [
          {
            name: getToolName('pr'),
            description: getToolDescription(`Create a Pull Request on Gitee.

Available repositories:
${MULTI_INSTANCE.map(i => `  - ${i.REPO_NAME}: ${i.OWNER}/${i.REPO} (${i.HEAD} -> ${i.BASE})`).join('\n')}

NOTE: Each repository must be configured with owner, repo, head, and base parameters in MULTI_INSTANCE.`),
            inputSchema: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'Pull Request title (required)' },
                body: { type: 'string', description: 'Pull Request description/body (optional)' },
                draft: { type: 'boolean', description: 'Whether this is a draft PR (optional, default: false)' },
                repo: {
                  type: 'string',
                  description: `Repository name, required. Available values: ${getRepoEnum().join(', ')}`,
                  enum: getRepoEnum()
                }
              },
              required: ['title', 'repo']
            }
          },
          {
            name: getToolName('token'),
            description: getToolDescription(`Get Gitee access token for a specific repository.

Available repositories:
${MULTI_INSTANCE.map(i => `  - ${i.REPO_NAME}: ${i.OWNER}/${i.REPO}`).join('\n')}`),
            inputSchema: {
              type: 'object',
              properties: {
                repo: {
                  type: 'string',
                  description: `Repository name, required. Available values: ${getRepoEnum().join(', ')}`,
                  enum: getRepoEnum()
                }
              },
              required: ['repo']
            }
          },
          {
            name: getToolName('logs'),
            description: getToolDescription('Get operation logs'),
            inputSchema: {
              type: 'object',
              properties: {
                limit: { type: 'number', description: 'Limit count, default 50' },
                offset: { type: 'number', description: 'Offset, default 0' }
              }
            }
          }
        ];

        if (!process.env.LOG_DIR) {
          tools.push({
            name: getToolName('set_log_dir'),
            description: `Set the log directory path for storing operation logs.

This tool is required when LOG_DIR environment variable is not set.

Example: {"log_dir": "./logs"}`,
            inputSchema: {
              type: 'object',
              properties: {
                log_dir: {
                  type: 'string',
                  description: 'Absolute path to the log directory (e.g., "D:/logs" or "/var/logs")'
                }
              },
              required: ['log_dir']
            }
          });
        }

        result = {
          tools: tools,
          environment: {
            TOOL_PREFIX: TOOL_PREFIX,
            LANGUAGE: LANGUAGE,
            multi_instance: MULTI_INSTANCE,
            repo_list: MULTI_INSTANCE.map(i => ({
              repo_name: i.REPO_NAME || '',
              owner: i.OWNER || '',
              repo: i.REPO || '',
              head: i.HEAD || '',
              base: i.BASE || ''
            })),
            serverInfo: {
              name: this.name,
              version: this.version
            }
          }
        };
      } else if (method === 'prompts/list') {
        result = { prompts: [] };
      } else if (method === 'prompts/call') {
        result = {
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Unsupported prompts call' }] }]
        };
      } else if (method === 'resources/list') {
        result = { resources: [] };
      } else if (method === 'resources/read') {
        result = { contents: [{ uri: 'error://unsupported', text: 'Unsupported resources read' }] };
      } else if (method === 'logging/list') {
        result = { logs: [] };
      } else if (method === 'logging/read') {
        result = { contents: [{ uri: 'error://unsupported', text: 'Unsupported logging read' }] };
      } else if (method === 'roots/list') {
        result = { roots: [] };
      } else if (method === 'roots/read') {
        result = { contents: [{ uri: 'error://unsupported', text: 'Unsupported roots read' }] };
      } else if (method === 'tools/call') {
        const { name, arguments: args } = params || {};

        if (!name) {
          throw new Error('Missing tool name');
        }

        let actualMethodName = name;
        if (TOOL_PREFIX && name.startsWith(`${TOOL_PREFIX}_`)) {
          actualMethodName = name.substring(TOOL_PREFIX.length + 1);
        }

        if (!this[actualMethodName]) {
          throw new Error(`Unknown tool: ${name}`);
        }

        let toolContext = {};
        if (args && args.repo && MULTI_INSTANCE.length > 0) {
          const targetInstance = MULTI_INSTANCE.find(i => i.REPO_NAME === args.repo);
          if (targetInstance) {
            toolContext = {
              PROJECT_PATH: targetInstance.PROJECT_PATH || '',
              REPO_NAME: targetInstance.REPO_NAME || '',
              OWNER: targetInstance.OWNER || '',
              REPO: targetInstance.REPO || '',
              HEAD_RAW: targetInstance.HEAD || '',
              BASE_RAW: targetInstance.BASE || '',
              ASSIGNEES: targetInstance.ASSIGNEES || '',
              TESTERS: targetInstance.TESTERS || '',
              LABELS_ENV: targetInstance.LABELS_ENV || '',
              AUTO_REVIEW: targetInstance.AUTO_REVIEW || false,
              AUTO_TEST: targetInstance.AUTO_TEST || false,
              AUTO_MERGE: targetInstance.AUTO_MERGE || false
            };
          } else {
            throw new Error(`Repository not found: ${args.repo}`);
          }
        }

        const toolResult = await this[actualMethodName](args || {}, toolContext);

        if (actualMethodName === 'pr' && toolResult.success) {
          result = {
            content: [{ type: 'text', text: toolResult.message }]
          };
        } else {
          result = {
            content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }]
          };
        }
      } else if (method === 'ping') {
        logRequest('ping', {}, { status: 'pong' }, null);
        result = { pong: true };
      } else if (method === 'shutdown') {
        result = null;
        setTimeout(() => { process.exit(0); }, 100);
      } else if (method === 'notifications/initialized') {
        logRequest('notifications/initialized', {}, { status: 'initialized' }, null);
      } else if (method === 'notifications/exit') {
        result = null;
        process.exit(0);
      } else {
        throw new Error(`Unknown method: ${method}`);
      }
    } catch (err) {
      error = err.message;
      const safeParams = params || {};
      logRequest(method, safeParams, null, error);

      if (method === 'notifications/initialized' || method === 'notifications/exit') {
        return null;
      }

      let errorCode = -32603;
      let errorMessage = err.message;

      if (err.message.includes('Server not initialized')) {
        errorCode = -32002;
      } else if (err.message.includes('Unknown method')) {
        errorCode = -32601;
      } else if (err.message.includes('Unsupported JSON-RPC version')) {
        errorCode = -32600;
      }

      return {
        jsonrpc: '2.0',
        id: id !== undefined ? id : null,
        error: { code: errorCode, message: errorMessage }
      };
    } finally {
      if (!error) {
        const safeParams = params || {};
        logRequest(method, safeParams, result, null);
      }
    }

    if (method === 'notifications/initialized' || method === 'notifications/exit') {
      return null;
    }

    if (method === 'shutdown') {
      return { jsonrpc: '2.0', id: id !== undefined ? id : null, result: null };
    }

    return {
      jsonrpc: '2.0',
      id: id !== undefined ? id : null,
      result
    };
  }

  async start() {
    console.error('================================');
    console.error(`Time: ${new Date().toISOString()}`);
    console.error(`Language: ${LANGUAGE}`);
    console.error(`Tool Prefix: ${TOOL_PREFIX || '(none)'}`);
    console.error(`Multi Instance: ${MULTI_INSTANCE.length} instance(s)`);
    if (MULTI_INSTANCE.length > 0) {
      console.error('Instances:');
      MULTI_INSTANCE.forEach((instance, index) => {
        console.error(`  ${index + 1}. ${instance.REPO_NAME}: ${instance.OWNER}/${instance.REPO} (${instance.HEAD || '?'} -> ${instance.BASE || '?'})`);
      });
    }
    console.error('================================');

    process.stdin.setEncoding('utf8');

    process.stdin.on('data', async (data) => {
      try {
        const lines = data.toString().trim().split('\n');

        for (const line of lines) {
          if (line.trim()) {
            try {
              const request = JSON.parse(line);
              const response = await this.handleRequest(request);
              if (response) {
                console.log(JSON.stringify(response));
              }
            } catch (requestError) {
              console.error('Error processing individual request:', requestError.message);
              const errorResponse = {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32603, message: `Internal error: ${requestError.message}` }
              };
              console.log(JSON.stringify(errorResponse));
            }
          }
        }
      } catch (error) {
        console.error('Error processing data:', error.message);
        logRequest('data_processing_error', { error: error.message }, null, error.message);
      }
    });

    process.on('SIGTERM', async () => {
      console.error('Received SIGTERM signal, shutting down server...');
      logRequest('SIGTERM', { signal: 'SIGTERM' }, { status: 'shutting_down' }, null);
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      console.error('Received SIGINT signal, shutting down server...');
      logRequest('SIGINT', { signal: 'SIGINT' }, { status: 'shutting_down' }, null);
      process.exit(0);
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      logRequest('uncaughtException', { error: error.message, stack: error.stack }, null, error.message);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Promise rejection:', reason);
      logRequest('unhandledRejection', { reason: reason.toString() }, null, reason.toString());
      process.exit(1);
    });
  }
}

async function main() {
  console.error('================================');
  console.error('MCP Gitee PR Multi-Instance Server Starting');
  console.error(`Time: ${new Date().toISOString()}`);
  console.error(`Language: ${LANGUAGE}`);
  console.error(`Tool Prefix: ${TOOL_PREFIX || '(none)'}`);
  console.error(`Multi Instance: ${MULTI_INSTANCE.length} instance(s)`);
  if (MULTI_INSTANCE.length > 0) {
    console.error('Instances:');
    MULTI_INSTANCE.forEach((instance, index) => {
      console.error(`  ${index + 1}. ${instance.REPO_NAME}: ${instance.OWNER}/${instance.REPO} (${instance.HEAD || '?'} -> ${instance.BASE || '?'})`);
    });
  }
  console.error('================================');

  const server = new FinalMCPServer();
  await server.start();
  console.error('MCP Gitee PR Multi-Instance server started successfully');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
