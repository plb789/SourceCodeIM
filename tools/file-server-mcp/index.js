#!/usr/bin/env node
// ===== im-file-server-mcp：文件服务器 REST API → MCP stdio 包装器 =====
// 职责：把自有文件服务器对外提供的 REST API 包装成 MCP 工具，供 im-client 智能体经
//       agent_mcp.json / 插件市场一键安装后调用（stdio 常驻子进程，由客户端 mcp-manager 拉起）。
// 约定（文件服务器需提供的接口，均可经环境变量改路径）：
//   GET {FILE_API_URL}{FILE_API_SEARCH_PATH||/api/search}?q=关键词          → 检索资料（返回文本或 JSON）
//   GET {FILE_API_URL}{FILE_API_FILE_PATH||/api/files}/{id}                 → 获取单个文件详情/内容
//   GET {FILE_API_URL}{FILE_API_LIST_PATH||/api/files}?page=N&size=M        → 分页列出文件
// 环境变量：
//   FILE_API_URL        必填，文件服务器根地址（如 http://192.168.1.100:9000）
//   FILE_API_TOKEN      选填，Bearer 令牌（有值时自动挂 Authorization 头）
//   FILE_API_SEARCH_PATH / FILE_API_FILE_PATH / FILE_API_LIST_PATH  选填，接口路径改写（默认值见上）
// 输出限额：单工具返回 8000 字符封顶（与客户端命令输出限额一致，防止撑爆上下文）
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const TOOL_OUT_MAX_CHARS = 8000; // 单工具返回上限（与 im-client agent-executor 命令输出限额同值）

const BASE_URL = (process.env.FILE_API_URL || '').replace(/\/+$/, ''); // 去尾部斜杠归一
const TOKEN = process.env.FILE_API_TOKEN || '';
const SEARCH_PATH = process.env.FILE_API_SEARCH_PATH || '/api/search';
const FILE_PATH = process.env.FILE_API_FILE_PATH || '/api/files/';
const LIST_PATH = process.env.FILE_API_LIST_PATH || '/api/files';

// callApi 统一请求出口：拼 URL、挂鉴权头、超时与错误归一（返回文本，调用方裁剪）
async function callApi(pathWithQuery) {
    if (!BASE_URL) {
        return '未配置 FILE_API_URL 环境变量：请在 MCP 配置/插件安装表单中填写文件服务器 API 根地址';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, 15000); // 15s 超时，防挂起拖死会话
    try {
        const resp = await fetch(BASE_URL + pathWithQuery, {
            headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
            signal: ctrl.signal
        });
        const text = await resp.text();
        if (!resp.ok) return '文件服务器返回错误 HTTP ' + resp.status + '：' + text.slice(0, 500);
        return text;
    } catch (e) {
        return '文件服务器请求失败：' + (e && e.message ? e.message : String(e));
    } finally {
        clearTimeout(timer);
    }
}

// clip 返回文本裁剪（超限截断并提示）
function clip(text) {
    if (text.length <= TOOL_OUT_MAX_CHARS) return text;
    return text.slice(0, TOOL_OUT_MAX_CHARS) + '\n…（内容超长已截断，可缩小检索范围或分页获取）';
}

const mcp = new McpServer({ name: 'file-server', version: '1.0.0' });

// 工具一：按关键词检索资料
mcp.tool(
    'search_docs',
    '按关键词检索文件服务器中的资料，返回匹配的文件与摘要列表',
    {
        keyword: z.string().describe('检索关键词'),
        limit: z.number().int().min(1).max(50).optional().describe('返回条数上限，默认 10')
    },
    async function (p) {
        const q = '?q=' + encodeURIComponent(p.keyword) + '&limit=' + (p.limit || 10);
        return { content: [{ type: 'text', text: clip(await callApi(SEARCH_PATH + q)) }] };
    }
);

// 工具二：获取单个文件详情/内容（按 id）
mcp.tool(
    'get_file',
    '按文件 id 获取文件服务器中该文件的详情与内容',
    { id: z.string().describe('文件 id（来自 search_docs 结果）') },
    async function (p) {
        return { content: [{ type: 'text', text: clip(await callApi(FILE_PATH + encodeURIComponent(p.id))) }] };
    }
);

// 工具三：分页列出文件清单
mcp.tool(
    'list_files',
    '分页列出文件服务器中的文件清单',
    {
        page: z.number().int().min(1).optional().describe('页码，从 1 开始，默认 1'),
        size: z.number().int().min(1).max(100).optional().describe('每页条数，默认 20')
    },
    async function (p) {
        const q = '?page=' + (p.page || 1) + '&size=' + (p.size || 20);
        return { content: [{ type: 'text', text: clip(await callApi(LIST_PATH + q)) }] };
    }
);

// stdio 常驻：握手与消息全由 SDK 处理，进程由客户端 mcp-manager 管理生命周期
mcp.connect(new StdioServerTransport()).catch(function (e) {
    process.stderr.write('MCP 启动失败：' + (e && e.message ? e.message : String(e)) + '\n');
    process.exit(1);
});
