// MCP server exposing the web tools over any transport. Tool behavior lives in
// the WebToolCore; this module only lists tools, validates arguments at the
// boundary, forwards cancellation, and maps results to MCP content.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOL_DEFINITIONS, validateMcpToolArguments } from "./mcp-tool-definitions.ts";
import type {
	FetchContentCallParams,
	GetSearchContentCallParams,
	SourceCheckCallParams,
	WebSearchCallParams,
	XSearchCallParams,
	WebToolCore,
	WebToolResult,
} from "./web-tool-contract.ts";

export interface McpServerInfo {
	name: string;
	version: string;
}

type ToolRunner = (core: WebToolCore, args: Record<string, unknown>, signal: AbortSignal) => Promise<WebToolResult>;
type ToolInputSchema = { type: "object"; [key: string]: unknown };

// SAFETY: validateMcpToolArguments checks each matching schema before a runner receives args.
const TOOL_RUNNERS: Record<string, ToolRunner> = {
	x_search: (core, args, signal) => core.xSearch(args as unknown as XSearchCallParams, signal),
	web_search: (core, args, signal) => core.webSearch(args as WebSearchCallParams, signal),
	fetch_content: (core, args, signal) => core.fetchContent(args as FetchContentCallParams, signal),
	get_search_content: (core, args, signal) => core.getSearchContent(args as unknown as GetSearchContentCallParams, signal),
	source_check: (core, args, signal) => core.sourceCheck(args as unknown as SourceCheckCallParams, signal),
};

function errorResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// details stays off the wire: clients such as Codex show the model structuredContent
// instead of content, and details holds host metadata rather than the results.
function toCallToolResult(result: WebToolResult): CallToolResult {
	return { content: result.content, ...(result.isError && { isError: true }) };
}

/** Serves selected tools; the default preserves the four original tools. */
export function createMcpServer(core: WebToolCore, info: McpServerInfo, enabledTools?: readonly string[]): Server {
	const server = new Server(info, { capabilities: { tools: {} } });
	const tools = MCP_TOOL_DEFINITIONS.filter((tool) => enabledTools ? enabledTools.includes(tool.name) : tool.name !== "x_search");

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as ToolInputSchema,
			annotations: tool.annotations,
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const { name } = request.params;
		const tool = tools.find((candidate) => candidate.name === name);
		const run = TOOL_RUNNERS[name];
		if (!tool || !run) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);

		const args = request.params.arguments ?? {};
		const problems = validateMcpToolArguments(tool, args);
		if (problems.length > 0) return errorResult(`Invalid arguments for ${name}:\n- ${problems.join("\n- ")}`);

		try {
			return toCallToolResult(await run(core, args, extra.signal));
		} catch (error) {
			return errorResult(error instanceof Error ? error.message : String(error));
		}
	});

	return server;
}
