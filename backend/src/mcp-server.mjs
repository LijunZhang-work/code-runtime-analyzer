import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { API_VERSION, DEFAULT_BACKEND_URL, PRODUCT_VERSION } from './runtime-info.mjs';

/**
 * OpenCode-facing MCP adapter.
 *
 * The adapter deliberately talks to the same HTTP API as the VS Code
 * extension and web workbench.  That keeps the parsing, dictionary validation
 * and stale-data protection in one place instead of creating a second, subtly
 * different implementation for AI clients.
 */
async function connectSharedApi(baseUrl) {
  let response;
  try {
    response = await fetch(`${baseUrl}/health`);
  } catch (error) {
    throw new Error(`无法连接 Code Runtime Analyzer 后台 ${baseUrl}。请先启动已安装的后台系统。`, { cause: error });
  }
  const health = await response.json().catch(() => ({}));
  if (!response.ok || health.product !== 'code-runtime-analyzer' || health.apiVersion !== API_VERSION) {
    throw new Error(`后台版本不兼容：需要 API ${API_VERSION}，当前为 ${health.apiVersion ?? '未知'}。请更新统一安装包。`);
  }
  const registration = await postJson(baseUrl, '/api/integrations/register', {
    clientType: 'mcp',
    clientName: process.env.CODE_RUNTIME_ANALYZER_MCP_CLIENT_NAME || 'OpenCode / AI MCP'
  });
  const heartbeatIntervalMs = Math.max(10_000, Number(registration.heartbeatIntervalMs) || 30_000);
  const heartbeat = setInterval(() => {
    void postJson(baseUrl, '/api/integrations/heartbeat', { clientId: registration.clientId }).catch(() => undefined);
  }, heartbeatIntervalMs);
  heartbeat.unref();
  return {
    baseUrl,
    async close() {
      clearInterval(heartbeat);
      await postJson(baseUrl, '/api/integrations/unregister', { clientId: registration.clientId }).catch(() => undefined);
    }
  };
}

function compactJson(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

function failedTool(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `诊断请求失败：${message}` }],
    isError: true
  };
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error ?? `后端请求失败：${response.status}`);
  return result;
}

const nonEmptyPath = z.string().trim().min(1);
const codeField = z.record(z.string(), z.unknown());
const revisionInput = {
  runRecordId: z.string().min(1).describe('由 load_diagnostic_data 或 list_runs 返回的运行记录 ID'),
  dataRevision: z.string().min(1).describe('由 load_diagnostic_data 返回的数据版本；数据重新加载后必须使用新值')
};

export async function createDiagnosticsMcp({
  baseUrl = (process.env.CODE_RUNTIME_ANALYZER_URL || DEFAULT_BACKEND_URL).replace(/\/$/, '')
} = {}) {
  const api = await connectSharedApi(baseUrl);
  const mcp = new McpServer({ name: 'code-runtime-analyzer', version: PRODUCT_VERSION });

  mcp.registerTool('diagnostics_list_dictionaries', {
    title: '列出字段字典',
    description: '列出本工具包内可选的字段字典。字典属于产品代码仓，可长期保留。'
  }, async () => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/dictionaries/list', {}));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_load_data', {
    title: '加载一次 CSV 回放数据',
    description: '选择一个字段字典和一个包含 CSV 的文件夹。此操作替换当前临时 CSV 会话，并返回 runRecordId 与 dataRevision。',
    inputSchema: {
      dictionaryId: z.string().min(1).describe('字典 ID，例如 product-b'),
      folderPath: nonEmptyPath.describe('本机上包含 CSV 文件的文件夹绝对路径'),
      workspaceRoot: nonEmptyPath.describe('当前产品代码仓根目录绝对路径，用于验证字典中的仓库相对定义路径')
    }
  }, async (input) => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/dictionaries/load-folder', input));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_list_runs', {
    title: '列出当前回放运行记录',
    description: '列出当前已加载 CSV 会话中的运行记录及来源。'
  }, async () => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/runs/list', {}));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_list_replay_times', {
    title: '列出可回放时间点',
    description: '从当前 CSV 会话中返回均匀抽样的时间点，供进一步查询。',
    inputSchema: {
      ...revisionInput,
      limit: z.number().int().min(10).max(200).optional().describe('最多返回多少个时间点，默认 200')
    }
  }, async (input) => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/replay/times', input));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_get_snapshot', {
    title: '读取某个时间点的字段证据',
    description: '读取一个或多个已确认 C/C++ 字段/符号在指定回放时间点的 CSV 证据。codeFields 应来自字典或 diagnostics_list_fields。',
    inputSchema: {
      ...revisionInput,
      requestedTime: z.string().min(1).describe('CSV 中的原始时间值'),
      codeFields: z.array(codeField).min(1).max(100).describe('C/C++ 字段或全局符号身份对象'),
      mode: z.enum(['nearest', 'exact']).optional(),
      toleranceMs: z.number().nonnegative().max(86_400_000).optional()
    }
  }, async (input) => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/evidence/snapshot', input));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_get_series', {
    title: '读取字段时间趋势',
    description: '读取一个已确认字段或符号的时间序列证据；不会猜测没有字典映射的字段。',
    inputSchema: {
      ...revisionInput,
      codeField,
      maxPoints: z.number().int().min(10).max(10_000).optional()
    }
  }, async (input) => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/evidence/series', input));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_list_fields', {
    title: '列出字典已确认的代码字段',
    description: '列出当前运行记录中已确认映射到 CSV 的结构体字段和全局符号。',
    inputSchema: {
      ...revisionInput,
      module: z.string().optional(),
      typeName: z.string().optional()
    }
  }, async (input) => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/mappings/fields', input));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_get_call_graph', {
    title: '分析当前 C/C++ 文件的函数调用链',
    description: '使用该文件所属 compile_commands.json 的 Clang AST 获取同一编译单元内可确认的直接调用关系。虚函数、回调、函数指针不会被当作确定调用。',
    inputSchema: {
      compileCommandsPath: nonEmptyPath.describe('当前代码仓中 compile_commands.json 的绝对路径'),
      filePath: nonEmptyPath.describe('要分析的 .c/.cc/.cpp 文件绝对路径'),
      workspaceRoot: z.string().optional(),
      functionNames: z.array(z.string().min(1)).max(200).optional(),
      focusLine: z.number().int().min(1).optional().describe('未指定 functionNames 时，以该行所在函数作为调用链起点'),
      includeExternal: z.boolean().optional().describe('是否把当前文件外的声明也画为节点；默认否，以保证图在大型工程中可读'),
      maxNodes: z.number().int().min(1).max(400).optional(),
      maxEdges: z.number().int().min(1).max(800).optional()
    }
  }, async (input) => {
    try {
      return compactJson(await postJson(api.baseUrl, '/api/web/call-graph', input));
    } catch (error) {
      return failedTool(error);
    }
  });

  mcp.registerTool('diagnostics_make_vscode_link', {
    title: '生成跳回 VS Code 的函数链接',
    description: '生成通用 vscode:// 函数链接。它适合独立使用，但操作系统无法保证复用哪一个已有 VS Code 窗口；网页工作台不会使用这个链接，而是绑定回发起打开网页的那一个窗口。',
    inputSchema: {
      filePath: nonEmptyPath,
      line: z.number().int().min(1),
      column: z.number().int().min(1).optional(),
      workspaceRoot: z.string().optional()
    }
  }, async ({ filePath, line, column = 1, workspaceRoot }) => {
    const params = new URLSearchParams({ filePath, line: String(line), column: String(column) });
    if (workspaceRoot) params.set('workspaceRoot', workspaceRoot);
    return compactJson({
      uri: `vscode://local.cpp-csv-diagnostics/open-function?${params.toString()}`,
      notice: '这是系统级链接，可能由系统打开其他 VS Code 窗口；网页工作台使用的是当前窗口的专用本地连接。'
    });
  });

  return { mcp, close: () => api.close() };
}

async function main() {
  const { mcp, close } = await createDiagnosticsMcp();
  const shutdown = async () => {
    await mcp.close().catch(() => undefined);
    await close().catch(() => undefined);
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  await mcp.connect(new StdioServerTransport());
}

const isEntrypoint = process.argv[1] && new URL(`file:${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isEntrypoint) {
  main().catch((error) => {
    // stdout belongs exclusively to the JSON-RPC transport.
    process.stderr.write(`C/C++ diagnostics MCP 启动失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
