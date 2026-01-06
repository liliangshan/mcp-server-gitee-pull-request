const https = require('https');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

// In-memory log storage
const operationLogs = [];
const MAX_LOGS = 1000;

// Gitee API configuration
// Use scope_ prefix to avoid conflict with system environment variables
const USERNAME = (process.env.scope_username || '').trim();
const PASSWORD = (process.env.scope_password || '').trim();
const CLIENT_ID = (process.env.scope_client_id || '').trim();
const CLIENT_SECRET = (process.env.scope_client_secret || '').trim();
// Scope is hardcoded as per Gitee API requirements
const SCOPE = 'user_info pull_requests enterprises';
const OWNER = process.env.owner || '';
const REPO = process.env.repo || '';
const HEAD_RAW = process.env.head || '';
const BASE_RAW = process.env.base || '';
const ASSIGNEES = process.env.assignees || '';
const TESTERS = process.env.testers || '';
const LABELS_ENV = (process.env.labels || '').trim(); // Optional labels from environment
const AUTO_REVIEW = process.env.AUTO_REVIEW === 'true' || process.env.AUTO_REVIEW === '1';
const AUTO_TEST = process.env.AUTO_TEST === 'true' || process.env.AUTO_TEST === '1';
const AUTO_MERGE = process.env.AUTO_MERGE === 'true' || process.env.AUTO_MERGE === '1';

// Get project name for multi-instance support
const PROJECT_NAME = process.env.PROJECT_NAME || '';

// In-memory access token cache
let cachedAccessToken = null;
let tokenExpiresAt = 0;

// Validate required environment variables
const requiredEnvVars = [
  { key: 'scope_username', name: 'scope_username' },
  { key: 'scope_password', name: 'scope_password' },
  { key: 'scope_client_id', name: 'scope_client_id' },
  { key: 'scope_client_secret', name: 'scope_client_secret' },
  { key: 'owner', name: 'owner' },
  { key: 'repo', name: 'repo' },
  { key: 'head', name: 'head' },
  { key: 'base', name: 'base' }
];
const missingEnvVars = requiredEnvVars.filter(env => !process.env[env.key] || process.env[env.key].trim() === '');

if (missingEnvVars.length > 0) {
  console.error('ERROR: Required environment variables are missing:');
  missingEnvVars.forEach(env => {
    console.error(`  - ${env.name.toUpperCase()}`);
  });
  console.error('Please set all required environment variables before starting the server.');
  process.exit(1);
}

// Format branch name: if it's a simple branch name (e.g., "dev"), format it as "branch (dev)"
// If it's already in "branch (name)" format, keep it as is
const formatBranchName = (branchName) => {
  if (!branchName || typeof branchName !== 'string') {
    return branchName;
  }
  const trimmed = branchName.trim();
  // Check if already in "branch (name)" format
  if (/^branch\s*\([^)]+\)$/i.test(trimmed)) {
    return trimmed;
  }
  // Format as "branch (name)"
  return `branch (${trimmed})`;
};

// Format head and base branch names
const HEAD = formatBranchName(HEAD_RAW);
const BASE = formatBranchName(BASE_RAW);

// Auto-generate REPO_NAME from repo name (use repo for naming)
const REPO_NAME = REPO.replace(/[^a-zA-Z0-9_-]/g, '-');

// Get log directory and filename
const getLogConfig = () => {
  // Default log directory: .setting/ or .setting.<REPO_NAME>/
  let defaultLogDir = './.setting';
  if (REPO_NAME) {
    defaultLogDir = `./.setting.${REPO_NAME}`;
  }
  
  const logDir = process.env.MCP_LOG_DIR || defaultLogDir;
  const logFile = process.env.MCP_LOG_FILE || 'mcp-gitee-pr.log';
  return {
    dir: logDir,
    file: logFile,
    fullPath: path.join(logDir, logFile)
  };
};

// Ensure log directory exists
const ensureLogDir = () => {
  const { dir } = getLogConfig();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Log recording function - record all requests and responses
const logRequest = (method, params, result, error = null) => {
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

  // Record request and response data
  const logLine = `${logEntry.created_at} | ${method} | ${logEntry.params} | ${error || 'SUCCESS'} | RESPONSE: ${logEntry.result || 'null'}\n`;

  try {
    ensureLogDir();
    const { fullPath } = getLogConfig();
    fs.appendFileSync(fullPath, logLine, 'utf8');
  } catch (err) {
    console.error('Failed to write log file:', err.message);
  }
};

// Get access token from Gitee OAuth
const getAccessToken = async () => {
  // Return cached token if still valid (with 5 minutes buffer)
  const now = Date.now();
  if (cachedAccessToken && tokenExpiresAt > now + 5 * 60 * 1000) {
    return cachedAccessToken;
  }

  return new Promise((resolve, reject) => {
    // Use URLSearchParams to properly encode form data
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('username', USERNAME);
    params.append('password', PASSWORD);
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);
    params.append('scope', SCOPE);
    const postData = params.toString();

    // Debug: Log request details (without sensitive data)
    console.error('OAuth token request:', {
      scope_username: USERNAME ? (USERNAME.length > 10 ? USERNAME.substring(0, 10) + '***' : USERNAME) : '(empty)',
      scope_client_id: CLIENT_ID ? CLIENT_ID.substring(0, 8) + '***' : '(empty)',
      scope_scope: SCOPE,
      hasPassword: !!PASSWORD,
      hasClientSecret: !!CLIENT_SECRET,
      postDataLength: postData.length,
      postDataPreview: postData.substring(0, 100) + '...'
    });

    const options = {
      hostname: 'gitee.com',
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'mcp-server-gitee-pull-request/1.0.0'
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
            cachedAccessToken = parsed.access_token;
            // Cache token for expires_in seconds (default to 1 hour if not provided)
            const expiresIn = parsed.expires_in || 3600;
            tokenExpiresAt = now + expiresIn * 1000;
            resolve(parsed.access_token);
          } else {
            // Log error details for debugging
            console.error('OAuth token request failed:', {
              statusCode: res.statusCode,
              error: parsed.error_description || parsed.error || 'Unknown error',
              errorCode: parsed.error,
              response: parsed,
              requestScope: SCOPE,
              requestUsername: USERNAME ? (USERNAME.length > 10 ? USERNAME.substring(0, 10) + '***' : USERNAME) : '(empty)'
            });
            reject({
              statusCode: res.statusCode,
              error: parsed.error_description || parsed.error || 'Unknown error',
              data: parsed
            });
          }
        } catch (err) {
          console.error('Failed to parse OAuth response:', {
            statusCode: res.statusCode,
            error: err.message,
            rawResponse: responseData
          });
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
};

// Make HTTPS request to Gitee API
const makeGiteeRequest = async (method, path, data = null, accessToken = null) => {
  // Get access token if not provided
  const token = accessToken || await getAccessToken();
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'gitee.com',
      port: 443,
      path: `/api/v5${path}${path.includes('?') ? '&' : '?'}access_token=${token}`,
      method: method,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': 'mcp-server-gitee-pull-request/1.0.0'
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        // Check status code first - 200-299 are considered success
        const isSuccess = res.statusCode >= 200 && res.statusCode < 300;
        
        // If response is empty and status is success, return success
        if (isSuccess && (!responseData || responseData.trim() === '')) {
          console.error('Gitee API returned empty response (success):', {
            statusCode: res.statusCode,
            method: options.method,
            path: options.path
          });
          resolve({
            statusCode: res.statusCode,
            data: null
          });
          return;
        }
        
        try {
          const parsed = JSON.parse(responseData);
          if (isSuccess) {
            resolve({
              statusCode: res.statusCode,
              data: parsed
            });
          } else {
            // Log detailed error for debugging
            console.error('Gitee API request failed:', {
              statusCode: res.statusCode,
              path: options.path,
              error: parsed.message || parsed.error || 'Unknown error',
              errorDescription: parsed.error_description,
              fullResponse: parsed
            });
            reject({
              statusCode: res.statusCode,
              error: parsed.error_description || parsed.message || parsed.error || 'Unknown error',
              data: parsed
            });
          }
        } catch (err) {
          // If status code is success (200-299), treat as success even if JSON parsing fails
          if (isSuccess) {
            console.error('Gitee API returned success status but response is not valid JSON:', {
              statusCode: res.statusCode,
              method: options.method,
              path: options.path,
              error: err.message,
              responseLength: responseData.length,
              responseHeaders: res.headers,
              rawResponse: responseData,
              rawResponsePreview: responseData.substring(0, 500) + (responseData.length > 500 ? '...' : '')
            });
            // Still return success since status code indicates success
            resolve({
              statusCode: res.statusCode,
              data: responseData || null,
              rawResponse: responseData
            });
          } else {
            // Log detailed debug information when JSON parsing fails and status is not success
            console.error('Failed to parse JSON response:', {
              statusCode: res.statusCode,
              method: options.method,
              path: options.path,
              error: err.message,
              responseLength: responseData.length,
              responseHeaders: res.headers,
              rawResponse: responseData,
              rawResponsePreview: responseData.substring(0, 500) + (responseData.length > 500 ? '...' : '')
            });
            reject({
              statusCode: res.statusCode,
              error: `Failed to parse response: ${err.message}`,
              rawResponse: responseData,
              responseHeaders: res.headers
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
};

// Review Gitee Pull Request
const reviewGiteePullRequest = async (prNumber, force = false) => {
  if (!prNumber || typeof prNumber !== 'number') {
    throw new Error('Missing or invalid PR number parameter');
  }

  // Build request body
  const requestBody = {
    force: force
  };

  // Make API request
  const apiPath = `/repos/${OWNER}/${REPO}/pulls/${prNumber}/review`;
  
  // Log request body for debugging
  console.error(`Reviewing Pull Request #${prNumber} with request body:`, {
    force: requestBody.force
  });
  
  const response = await makeGiteeRequest('POST', apiPath, requestBody);

  return response;
};

// Test Gitee Pull Request
const testGiteePullRequest = async (prNumber, force = false) => {
  if (!prNumber || typeof prNumber !== 'number') {
    throw new Error('Missing or invalid PR number parameter');
  }

  // Build request body
  const requestBody = {
    force: force
  };

  // Make API request
  const apiPath = `/repos/${OWNER}/${REPO}/pulls/${prNumber}/test`;
  
  // Log request body for debugging
  console.error(`Testing Pull Request #${prNumber} with request body:`, {
    force: requestBody.force
  });
  
  const response = await makeGiteeRequest('POST', apiPath, requestBody);

  return response;
};

// Merge Gitee Pull Request
const mergeGiteePullRequest = async (prNumber) => {
  if (!prNumber || typeof prNumber !== 'number') {
    throw new Error('Missing or invalid PR number parameter');
  }

  // Make API request (PUT method, no request body needed for merge)
  const apiPath = `/repos/${OWNER}/${REPO}/pulls/${prNumber}/merge`;
  
  // Log merge request
  console.error(`Merging Pull Request #${prNumber}...`);
  
  const response = await makeGiteeRequest('PUT', apiPath, null);

  return response;
};

// Create Gitee Pull Request
const createGiteePullRequest = async (params) => {
  const { title, body, draft = false } = params;

  if (!title || typeof title !== 'string' || title.trim() === '') {
    throw new Error('Missing or invalid title parameter');
  }

  // Build request body
  // Use raw head and base values from environment variables (not formatted)
  const requestBody = {
    title: title.trim(),
    head: HEAD_RAW, // Use raw value from environment variable
    base: BASE_RAW, // Use raw value from environment variable
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

  // Process labels: only use environment variable
  if (LABELS_ENV && LABELS_ENV.trim() !== '') {
    // Parse labels: comma-separated string, e.g., "bug,performance"
    // Gitee API expects an array of label names
    const labelArray = LABELS_ENV.split(',').map(s => s.trim()).filter(s => s !== '');
    
    // Validate and filter labels: length 2-20, no special characters
    // Allowed characters: alphanumeric, underscore, Chinese characters
    const validLabels = [];
    for (const label of labelArray) {
      // Check length: 2-20 characters
      if (label.length < 2 || label.length > 20) {
        console.error(`Warning: Invalid label "${label}" (length must be between 2 and 20 characters)`);
        continue;
      }
      
      // Check characters: only alphanumeric, underscore, and Chinese characters allowed
      // Non-special characters means no spaces, punctuation, etc.
      if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(label)) {
        console.error(`Warning: Invalid label "${label}" (contains special characters, only alphanumeric, underscore, and Chinese characters allowed)`);
        continue;
      }
      
      validLabels.push(label);
    }
    
    // Only add labels if we have valid ones
    if (validLabels.length > 0) {
      requestBody.labels = validLabels;
    } else if (labelArray.length > 0) {
      // If labels were provided but none are valid, log warning but don't add labels
      console.error('Warning: No valid labels found after validation, skipping labels parameter');
    }
  }

  // Make API request
  const apiPath = `/repos/${OWNER}/${REPO}/pulls`;
  
  // Log request body for debugging (without sensitive data)
  console.error('Creating Pull Request with request body:', {
    title: requestBody.title,
    head: requestBody.head,
    base: requestBody.base,
    body: requestBody.body ? requestBody.body.substring(0, 50) + '...' : '',
    draft: requestBody.draft,
    labels: requestBody.labels,
    assignees: requestBody.assignees,
    testers: requestBody.testers
  });
  
  const response = await makeGiteeRequest('POST', apiPath, requestBody);

  return response;
};

// 启动日志
console.error('=== MCP Gitee Pull Request Server Starting ===');
console.error(`Time: ${new Date().toISOString()}`);
console.error(`Repository Name (auto-generated from repo): ${REPO_NAME}`);
console.error(`Owner: ${OWNER}`);
console.error(`Repo: ${REPO}`);
console.error(`Head: ${HEAD}`);
console.error(`Base: ${BASE}`);
console.error(`AUTO_REVIEW: ${AUTO_REVIEW}`);
console.error(`AUTO_TEST: ${AUTO_TEST}`);
console.error(`AUTO_MERGE: ${AUTO_MERGE}`);
console.error(`Username (from env.username): ${USERNAME ? (USERNAME.length > 10 ? USERNAME.substring(0, 10) + '***' : USERNAME) : '(not set)'}`);
console.error(`Username length: ${USERNAME.length}`);
console.error(`Client ID: ${CLIENT_ID ? CLIENT_ID.substring(0, 8) + '***' : '(not set)'}`);
console.error(`Scope: ${SCOPE}`);
console.error(`Debug - process.env.scope_username: ${process.env.scope_username ? (process.env.scope_username.length > 10 ? process.env.scope_username.substring(0, 10) + '***' : process.env.scope_username) : '(not set)'}`);
if (PROJECT_NAME) {
  console.error(`Project Name: ${PROJECT_NAME}`);
}
console.error(`Started via: ${process.argv[1]}`);

// 显示日志配置
const logConfig = getLogConfig();
console.error(`Log Directory: ${logConfig.dir}`);
console.error(`Log File: ${logConfig.fullPath}`);
console.error('================================');

// Final MCP Server
class FinalMCPServer {
  constructor() {
    this.name = 'gitee-pull-request-mcp-server';
    this.version = '1.0.4';
    this.initialized = false;
  }

  // Create Gitee Pull Request
  async pr(params) {
    const { title, body, draft } = params;

    try {
      const result = await createGiteePullRequest({ title, body, draft });
      
      // Log operation
      logRequest('pr', { title, body, draft }, result);

      // Auto review if enabled
      let reviewResult = null;
      if (AUTO_REVIEW && result.data && result.data.number) {
        try {
          console.error(`AUTO_REVIEW is enabled, automatically reviewing PR #${result.data.number}...`);
          reviewResult = await reviewGiteePullRequest(result.data.number, false);
          console.error(`✓ Auto review completed for PR #${result.data.number}`);
          logRequest('auto_review', { prNumber: result.data.number, force: false }, reviewResult);
        } catch (reviewErr) {
          console.error(`✗ Auto review failed for PR #${result.data.number}:`, reviewErr.error || reviewErr.message);
          logRequest('auto_review', { prNumber: result.data.number, force: false }, null, reviewErr.error || reviewErr.message);
          // Don't fail the entire operation if review fails, just log the error
        }
      }

      // Auto test if enabled (after review if review was performed)
      let testResult = null;
      if (AUTO_TEST && result.data && result.data.number) {
        try {
          console.error(`AUTO_TEST is enabled, automatically testing PR #${result.data.number}...`);
          testResult = await testGiteePullRequest(result.data.number, false);
          console.error(`✓ Auto test completed for PR #${result.data.number}`);
          logRequest('auto_test', { prNumber: result.data.number, force: false }, testResult);
        } catch (testErr) {
          console.error(`✗ Auto test failed for PR #${result.data.number}:`, testErr.error || testErr.message);
          logRequest('auto_test', { prNumber: result.data.number, force: false }, null, testErr.error || testErr.message);
          // Don't fail the entire operation if test fails, just log the error
        }
      }

      // Auto merge if enabled (after test if test was performed and successful)
      let mergeResult = null;
      if (AUTO_MERGE && result.data && result.data.number) {
        // Only merge if test was successful (testResult exists means test succeeded, even if data is null for 204 responses)
        // Or if AUTO_TEST is false (no test required)
        const shouldMerge = (!AUTO_TEST || testResult !== null);
        if (shouldMerge) {
          try {
            console.error(`AUTO_MERGE is enabled, automatically merging PR #${result.data.number}...`);
            mergeResult = await mergeGiteePullRequest(result.data.number);
            console.error(`✓ Auto merge completed for PR #${result.data.number}`);
            logRequest('auto_merge', { prNumber: result.data.number }, mergeResult);
          } catch (mergeErr) {
            console.error(`✗ Auto merge failed for PR #${result.data.number}:`, mergeErr.error || mergeErr.message);
            logRequest('auto_merge', { prNumber: result.data.number }, null, mergeErr.error || mergeErr.message);
            // Don't fail the entire operation if merge fails, just log the error
          }
        } else {
          console.error(`⚠ AUTO_MERGE is enabled but test failed, skipping merge for PR #${result.data.number}`);
        }
      }

      // Return the complete response object from Gitee API
      const response = {
        success: true,
        pull_request: result.data,
        response: result.data, // Include full response object
        url: result.data.html_url || result.data.url || null,
        number: result.data.number || null,
        message: `🎉 Pull Request created successfully!\n\n📋 **PR Details:**\n• Number: #${result.data.number || 'N/A'}\n• Title: ${result.data.title || title}\n• URL: ${result.data.html_url || result.data.url || 'N/A'}\n\n🔗 **Direct Link:** [View PR #${result.data.number || 'N/A'}](${result.data.html_url || result.data.url || '#'})\n\n💡 **Next Steps:**\n• Review the changes in the PR\n• Request reviews from team members if needed\n• Monitor CI/CD pipeline status\n• Merge when ready (if auto-merge is not enabled)`
      };

      // Include review result if auto review was performed
      if (reviewResult) {
        response.auto_review = {
          success: true,
          review: reviewResult.data,
          message: `Auto review completed for PR #${result.data.number}`
        };
      }

      // Include test result if auto test was performed
      if (testResult) {
        response.auto_test = {
          success: true,
          test: testResult.data,
          message: `Auto test completed for PR #${result.data.number}`
        };
      }

      // Include merge result if auto merge was performed
      if (mergeResult) {
        response.auto_merge = {
          success: true,
          merge: mergeResult.data,
          message: `Auto merge completed for PR #${result.data.number}`
        };
      }

      return response;
    } catch (err) {
      // Log operation error
      logRequest('pr', { title, body, draft }, null, err.error || err.message);
      
      // Return detailed error information including response data
      const errorMessage = `Gitee Pull Request creation failed: ${err.error || err.message}${err.statusCode ? ` (Status: ${err.statusCode})` : ''}`;
      
      // Always return error object with response data if available
      const errorResult = {
        success: false,
        error: errorMessage,
        statusCode: err.statusCode || null,
        message: `Failed to create Pull Request. Error: ${err.error || err.message}`
      };
      
      // Include response data if available
      if (err.data) {
        errorResult.response = err.data;
      }
      
      // Include raw response if available
      if (err.rawResponse) {
        errorResult.rawResponse = err.rawResponse;
      }
      
      return errorResult;
    }
  }

  // Get access token
  async token(params) {
    try {
      const token = await getAccessToken();
      
      // Log operation
      logRequest('token', {}, { success: true, token: token.substring(0, 10) + '...' });

      return {
        success: true,
        access_token: token,
        expires_at: new Date(tokenExpiresAt).toISOString(),
        message: 'Access token retrieved successfully'
      };
    } catch (err) {
      // Log operation error
      logRequest('token', {}, null, err.error || err.message);
      
      throw new Error(`Failed to get access token: ${err.error || err.message}${err.statusCode ? ` (Status: ${err.statusCode})` : ''}`);
    }
  }

  // Get operation logs
  async logs(params) {
    const { limit = 50, offset = 0 } = params || {};

    // Validate parameters
    if (typeof limit !== 'number' || limit < 1 || limit > 1000) {
      throw new Error('Invalid limit parameter. Must be a number between 1 and 1000');
    }

    if (typeof offset !== 'number' || offset < 0) {
      throw new Error('Invalid offset parameter. Must be a non-negative number');
    }

    // Get logs from memory
    const logs = operationLogs.slice(offset, offset + limit);

    return {
      total: operationLogs.length,
      limit,
      offset,
      logs: logs
    };
  }

  // Handle JSON-RPC requests
  async handleRequest(request) {
    let result = null;
    let error = null;
    let method = null;
    let params = null;
    let id = null;

    try {
      // Validate request structure
      if (!request || typeof request !== 'object') {
        throw new Error('Invalid request: request must be an object');
      }

      // Validate JSON-RPC version
      if (request.jsonrpc !== '2.0') {
        throw new Error('Unsupported JSON-RPC version. Only 2.0 is supported.');
      }

      // Extract method, params, and id
      method = request.method;
      params = request.params;
      id = request.id; // Can be undefined for notifications

      // Validate method exists
      if (!method || typeof method !== 'string') {
        throw new Error('Invalid request: method is required and must be a string');
      }

      // Handle initialization
      if (method === 'initialize') {
        if (!this.initialized) {
          this.initialized = true;
        }

        // Build server capabilities
        const serverCapabilities = {
          tools: {
            listChanged: false
          }
        };
        
        // If client supports prompts, we also support it
        if (params?.capabilities?.prompts) {
          serverCapabilities.prompts = {
            listChanged: false
          };
        }
        
        // If client supports resources, we also support it
        if (params?.capabilities?.resources) {
          serverCapabilities.resources = {
            listChanged: false
          };
        }
        
        // If client supports logging, we also support it
        if (params?.capabilities?.logging) {
          serverCapabilities.logging = {
            listChanged: false
          };
        }
        
        // If client supports roots, we also support it
        if (params?.capabilities?.roots) {
          serverCapabilities.roots = {
            listChanged: false
          };
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
        // Build tool name with repository name prefix for multi-instance support
        // REPO_NAME is auto-generated from repo name
        const getToolName = (baseName) => {
          return REPO_NAME ? `${REPO_NAME}_${baseName}` : baseName;
        };
        
        // Build tool description with project name
        const getToolDescription = (baseDescription) => {
          if (PROJECT_NAME) {
            return `[${PROJECT_NAME}] ${baseDescription}`;
          }
          return baseDescription;
        };
        
        // Build tools array
        const tools = [
          {
            name: getToolName('pr'),
            description: getToolDescription(`Create a Pull Request on Gitee for repository "${OWNER}/${REPO}".

IMPORTANT: 
- This tool creates a Pull Request from branch "${HEAD}" to "${BASE}"
- The repository is configured via environment variables (owner, repo, head, base)
- Optional reviewers can be configured via assignees and testers environment variables
${LABELS_ENV ? `- Default labels from environment: ${LABELS_ENV}` : ''}

USAGE: 
Call this tool with the following parameters:
{
  "title": "PR title (required)",
  "body": "PR description (optional)",
  "draft": false (optional, default: false)
}

${LABELS_ENV ? `NOTE: Labels will be automatically added from environment variable: ${LABELS_ENV}` : ''}

NOTE: After creating the PR, the tool will return the PR URL and number. You can share this information with the user.`),
            inputSchema: {
              type: 'object',
              properties: {
                title: {
                  type: 'string',
                  description: 'Pull Request title (required)'
                },
                body: {
                  type: 'string',
                  description: 'Pull Request description/body (optional)'
                },
                draft: {
                  type: 'boolean',
                  description: 'Whether this is a draft PR (optional, default: false)'
                }
              },
              required: ['title']
            }
          },
          {
            name: getToolName('token'),
            description: getToolDescription(`Get Gitee access token using OAuth.

This tool retrieves an access token from Gitee OAuth API using the configured credentials (username, password, client_id, client_secret).

The token is cached in memory and will be automatically refreshed when needed. You can call this tool manually to get a fresh token.

NOTE: The token is automatically used when creating Pull Requests, so you typically don't need to call this tool manually.`),
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: getToolName('logs'),
            description: getToolDescription('Get operation logs'),
            inputSchema: {
              type: 'object',
              properties: {
                limit: {
                  type: 'number',
                  description: 'Limit count, default 50'
                },
                offset: {
                  type: 'number',
                  description: 'Offset, default 0'
                }
              }
            }
          }
        ];

        result = {
          tools: tools,
          environment: {
            REPO_NAME: REPO_NAME, // Auto-generated from repo name
            PROJECT_NAME: PROJECT_NAME || '',
            owner: OWNER,
            repo: REPO,
            head: HEAD,
            base: BASE,
            serverInfo: {
              name: this.name,
              version: this.version
            }
          }
        };
      } else if (method === 'prompts/list') {
        // Return empty prompts list since we don't provide prompts functionality
        result = {
          prompts: []
        };
      } else if (method === 'prompts/call') {
        // Handle prompts call, but we don't provide prompts functionality
        result = {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: 'Unsupported prompts call'
                }
              ]
            }
          ]
        };
      } else if (method === 'resources/list') {
        // Return empty resources list since we don't provide resources functionality
        result = {
          resources: []
        };
      } else if (method === 'resources/read') {
        // Handle resources read, but we don't provide resources functionality
        result = {
          contents: [
            {
              uri: 'error://unsupported',
              text: 'Unsupported resources read'
            }
          ]
        };
      } else if (method === 'logging/list') {
        // Return empty logging list since we don't provide logging functionality
        result = {
          logs: []
        };
      } else if (method === 'logging/read') {
        // Handle logging read, but we don't provide logging functionality
        result = {
          contents: [
            {
              uri: 'error://unsupported',
              text: 'Unsupported logging read'
            }
          ]
        };
      } else if (method === 'roots/list') {
        // Return empty roots list since we don't provide roots functionality
        result = {
          roots: []
        };
      } else if (method === 'roots/read') {
        // Handle roots read, but we don't provide resources functionality
        result = {
          contents: [
            {
              uri: 'error://unsupported',
              text: 'Unsupported roots read'
            }
          ]
        };
      } else if (method === 'tools/call') {
        const { name, arguments: args } = params || {};

        if (!name) {
          throw new Error('Missing tool name');
        }

        // Remove repository name prefix if present to get the actual method name
        // REPO_NAME is auto-generated from repo name
        let actualMethodName = name;
        if (REPO_NAME && name.startsWith(`${REPO_NAME}_`)) {
          actualMethodName = name.substring(REPO_NAME.length + 1);
        }

        // Check if method exists (method names are in snake_case)
        if (!this[actualMethodName]) {
          // List available methods for debugging
          const availableMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(this))
            .filter(m => typeof this[m] === 'function' && m !== 'constructor' && m !== 'handleRequest' && m !== 'start');
          throw new Error(`Unknown tool: ${name}. PROJECT_NAME="${PROJECT_NAME}", actualMethodName="${actualMethodName}". Available methods: ${availableMethods.join(', ')}`);
        }

        const toolResult = await this[actualMethodName](args || {});

        // Tool call results need to be wrapped in content
        // For PR creation, return formatted Markdown content
        if (actualMethodName === 'pr' && toolResult.success) {
          result = {
            content: [
              {
                type: 'text',
                text: toolResult.message
              }
            ]
          };
        } else {
          // For other tools, return JSON format
          result = {
            content: [
              {
                type: 'text',
                text: JSON.stringify(toolResult, null, 2)
              }
            ]
          };
        }
      } else if (method === 'ping') {
        logRequest('ping', {}, { status: 'pong' }, null);
        result = { pong: true };
      } else if (method === 'shutdown') {
        // Handle shutdown request
        result = null;
        // Delay exit to give client time to process response
        setTimeout(() => {
          process.exit(0);
        }, 100);
      } else if (method === 'notifications/initialized') {
        // Handle initialization notification
        logRequest('notifications/initialized', {}, { status: 'initialized' }, null);
      } else if (method === 'notifications/exit') {
        // Handle exit notification
        result = null;
        process.exit(0);
      } else {
        throw new Error(`Unknown method: ${method}`);
      }
    } catch (err) {
      error = err.message;
      // Record error in log
      const safeParams = params || {};
      logRequest(method, safeParams, null, error);
      
      // For notification methods, no response is needed even on error
      if (method === 'notifications/initialized' || method === 'notifications/exit') {
        return null;
      }
      
      // Return error response for other methods
      // Use standard MCP error codes
      let errorCode = -32603; // Internal error
      let errorMessage = err.message;
      
      if (err.message.includes('Server not initialized')) {
        errorCode = -32002; // Server not initialized
      } else if (err.message.includes('Unknown method')) {
        errorCode = -32601; // Method not found
      } else if (err.message.includes('Unsupported JSON-RPC version')) {
        errorCode = -32600; // Invalid Request
      }
      
      return {
        jsonrpc: '2.0',
        id: id !== undefined ? id : null,
        error: {
          code: errorCode,
          message: errorMessage
        }
      };
    } finally {
      // Record all requests to log, ensure parameters are not undefined
      if (!error) {
        const safeParams = params || {};
        logRequest(method, safeParams, result, null);
      }
    }

    // For notification methods, no response is needed
    if (method === 'notifications/initialized' || method === 'notifications/exit') {
      return null;
    }
    
    // shutdown method needs to return response
    if (method === 'shutdown') {
      return {
        jsonrpc: '2.0',
        id: id !== undefined ? id : null,
        result: null
      };
    }

    // Ensure all methods return correct response format
    return {
      jsonrpc: '2.0',
      id: id !== undefined ? id : null,
      result
    };
  }

  // Start server
  async start() {
    console.error('MCP Gitee Pull Request server started');

    // Display log configuration
    const logConfig = getLogConfig();
    console.error(`Log directory: ${logConfig.dir}`);
    console.error(`Log file: ${logConfig.fullPath}`);

    // Pre-fetch access token on startup to validate credentials
    console.error('Pre-fetching access token...');
    try {
      const token = await getAccessToken();
      console.error(`✓ Access token obtained successfully (${token.substring(0, 10)}...)`);
      console.error(`  Token expires at: ${new Date(tokenExpiresAt).toISOString()}`);
    } catch (err) {
      console.error(`✗ Failed to get access token: ${err.error || err.message}`);
      console.error('  Warning: Server will continue to start, but API calls may fail.');
      console.error('  Please check your credentials (username, password, client_id, client_secret).');
    }

    // Listen to stdin
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
              // Send error response instead of crashing the entire server
              // Only send error response if request has an id (not a notification)
              const requestId = request && request.id !== undefined ? request.id : null;
              if (requestId !== null) {
                const errorResponse = {
                  jsonrpc: '2.0',
                  id: requestId,
                  error: {
                    code: -32603,
                    message: `Internal error: ${requestError.message}`
                  }
                };
                console.log(JSON.stringify(errorResponse));
              }
              // For notifications (no id), don't send any response
            }
          }
        }
      } catch (error) {
        console.error('Error processing data:', error.message);
        // Log error but don't exit server
        logRequest('data_processing_error', { error: error.message }, null, error.message);
      }
    });

    // Handle process signals
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

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught exception:', error);
      logRequest('uncaughtException', { error: error.message, stack: error.stack }, null, error.message);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Promise rejection:', reason);
      logRequest('unhandledRejection', { reason: reason.toString(), promise: promise.toString() }, null, reason.toString());
      process.exit(1);
    });

    // Record server startup
    logRequest('server_start', {
      name: this.name,
      version: this.version,
      logDir: logConfig.dir,
      logFile: logConfig.fullPath
    }, { status: 'started' }, null);
  }
}

// Start server
async function main() {
  console.error('Starting MCP Gitee Pull Request server...');
  const server = new FinalMCPServer();
  await server.start();
  console.error('MCP Gitee Pull Request server started successfully');
}

main().catch(error => {
  console.error(error);
  // Write to log
  logRequest('main', { error: error.message, stack: error.stack }, null, error.message);
  process.exit(1);
});

