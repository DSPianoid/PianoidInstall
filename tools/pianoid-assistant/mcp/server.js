#!/usr/bin/env node
/**
 * Pianoid MCP server (assistant phase A4): every command-registry command as an MCP tool, plus
 * search_docs. stdio transport.
 *
 *   node mcp/server.js [--source assistant|mcp] [--data-opt-out true]
 *
 * Excluded commands are never listed and denied tools are refused (defence in depth; the assistant
 * service's canUseTool policy is the primary gate). Used by the assistant runtime (the service
 * spawns it through the Agent SDK) and standalone by Claude Code / the orchestrator (.mcp.json),
 * where Claude Code's own permission prompt confirms destructive tools.
 * With `--exec-url` (set by the assistant service, v2 P2) every call goes to the service's
 * permit-gated executor instead of the backend: the service names the undo group, runs the Auto
 * write's level watch and auto-revert, and refuses a call its policy did not just allow.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { INSTALL_ROOT, commandName, loadCommands } from '../lib/registry.js';
import { decide } from '../policy.js';
import { callCommand, compact, listTools, SEARCH_DOCS, shapeResult } from './tools.js';
import { buildIndex, search } from './docsIndex.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

export function createPianoidMcpServer({
  source = 'mcp', commands = loadCommands(),
  docsDir = path.join(INSTALL_ROOT, 'docs'), fetchImpl = fetch, settings = {}, execUrl = null,
} = {}) {
  const byName = new Map(commands.map((c) => [c.name, c]));
  let docs = null;
  const server = new Server({ name: 'pianoid', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools(commands, settings) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const text = (obj, isError = false) => ({
      content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }],
      isError,
    });
    if (name === SEARCH_DOCS.name) {
      if (!docs) docs = buildIndex(docsDir);
      return text(search(docs, String(args.query || ''), Math.min(10, args.limit || 5)));
    }
    const cmd = byName.get(commandName(name));
    if (!cmd) return text({ error: 'unknown_tool', tool: name }, true);
    const verdict = decide({ command: cmd.name, tier: cmd.tier, family: cmd.family, category: cmd.approval_category, settings });
    if (verdict.action === 'deny') return text({ error: 'denied', reason: verdict.reason }, true);
    const res = await callCommand(cmd, args, { source, fetchImpl, execUrl });
    return text(compact(shapeResult(cmd, res)), !res.ok);
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const settings = { dataOptOut: arg('data-opt-out', 'false') === 'true' };
  const server = createPianoidMcpServer({
    source: arg('source', 'mcp'), settings, execUrl: arg('exec-url', null),
  });
  await server.connect(new StdioServerTransport());
}
