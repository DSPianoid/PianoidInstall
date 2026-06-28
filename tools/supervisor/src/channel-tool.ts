/**
 * The in-process SUPERVISOR CHANNEL TOOL — `mcp__supervisor_channel__reply`.
 *
 * The orchestrator skill is built around "message the user via the channel reply
 * tool". Under the supervisor the production telegram plugin is excluded (the
 * supervisor owns the channel), so we give the hosted session a REAL reply tool
 * that maps directly to `supervisor.sendOutbound(operator, { text })`. This is an
 * in-process SDK MCP server (`createSdkMcpServer` + `tool`), wired as an
 * `options.mcpServers` entry named `supervisor_channel` → the tool is exposed as
 * `mcp__supervisor_channel__reply`.
 *
 * Concern (P2): expose the reply (+ optional status) tool ONLY; the actual send is
 * the injected `replyFn` (the supervisor's bound outbound). The SDK glue is behind
 * a dynamic import so this file type-checks / loads without the optional SDK + zod.
 *
 * De-dup (team-lead decision): for the orchestrator profile the reply tool is the
 * DELIBERATE channel-out — the supervisor suppresses the auto-outbound of the
 * identical assistant text (see SessionProfile.suppressAutoOutbound) so the user
 * doesn't get double messages.
 */

/** The send function the tool calls (the supervisor's bound sendOutbound for the operator). */
export type ChannelReplyFn = (text: string) => Promise<{ ok: boolean }>;

/** A built SDK MCP server config (loose — the SDK's McpSdkServerConfigWithInstance). */
export type SupervisorChannelServer = Record<string, unknown>;

export const SUPERVISOR_CHANNEL_SERVER_NAME = 'supervisor_channel';
export const SUPERVISOR_CHANNEL_REPLY_TOOL = 'mcp__supervisor_channel__reply';

/**
 * Build the in-process channel MCP server. Returns the SDK server config to drop
 * into `options.mcpServers[SUPERVISOR_CHANNEL_SERVER_NAME]`, or null if the SDK is
 * not installed (the session still runs; assistant-text auto-outbound is the
 * fallback path). `replyFn` is the bound supervisor outbound.
 *
 * The SDK + zod are resolved via dynamic import so this module is import-safe
 * without them (tests exercise `replyFn` directly via {@link makeReplyHandler}).
 */
export async function buildSupervisorChannelServer(replyFn: ChannelReplyFn): Promise<SupervisorChannelServer | null> {
  const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
  let sdk: { tool?: unknown; createSdkMcpServer?: unknown };
  let zod: { string: () => { describe: (d: string) => unknown } };
  try {
    sdk = (await dynamicImport('@anthropic-ai/claude-agent-sdk')) as typeof sdk;
    const zodMod = (await dynamicImport('zod')) as { z?: typeof zod } & typeof zod;
    zod = zodMod.z ?? zodMod; // support both `import { z }` and namespace default
  } catch {
    return null; // SDK/zod absent → no in-process tool (auto-outbound fallback)
  }
  const tool = sdk.tool as (
    name: string,
    description: string,
    schema: unknown,
    handler: (args: { text: string }, extra: unknown) => Promise<unknown>,
  ) => unknown;
  const createSdkMcpServer = sdk.createSdkMcpServer as (opts: {
    name: string;
    version?: string;
    tools?: unknown[];
  }) => SupervisorChannelServer;

  const replyTool = tool(
    'reply',
    'Send a message to the user over the supervisor channel (replaces the telegram reply tool, which is not available here).',
    { text: zod.string().describe('The message text to send to the user.') },
    makeReplyHandler(replyFn),
  );

  return createSdkMcpServer({ name: SUPERVISOR_CHANNEL_SERVER_NAME, version: '0.1.0', tools: [replyTool] });
}

/**
 * The tool handler (SDK-agnostic, directly unit-testable): send the text over the
 * channel and return an MCP CallToolResult. Exported so tests verify the mapping
 * to `replyFn` + the result shape without the SDK.
 */
export function makeReplyHandler(replyFn: ChannelReplyFn) {
  return async (args: { text: string }): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> => {
    const text = String(args?.text ?? '');
    if (!text.trim()) {
      return { content: [{ type: 'text', text: 'reply: empty text ignored' }], isError: true };
    }
    try {
      const r = await replyFn(text);
      return { content: [{ type: 'text', text: r.ok ? 'sent' : 'send failed' }], isError: !r.ok };
    } catch (err) {
      return { content: [{ type: 'text', text: `send error: ${String(err)}` }], isError: true };
    }
  };
}
