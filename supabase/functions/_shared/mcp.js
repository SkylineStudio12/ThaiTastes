// MCP over streamable HTTP, stateless: every POST carries one JSON-RPC message (or a batch) and gets JSON back.
// No sessions and no server-initiated messages, so there is no SSE stream; GET answers 405 as the spec allows.
import { TOOLS, TOOL_BY_NAME, INSTRUCTIONS, validate } from './tools.js';
import { json, readBody } from './util.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SERVER_INFO = { name: 'thaitastes', title: 'ThaiTastes', version: '1.0.0' };

const toolList = () => TOOLS.map((t) => ({
  name: t.name, title: t.title, description: t.description, inputSchema: t.input,
  annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: false, idempotentHint: !t.write, openWorldHint: false },
}));

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const toolError = (id, message) => rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });

// Runs one tool for an already hashed token. Shared with the REST path.
export async function runTool(cfg, tokenHash, name, args) {
  const tool = TOOL_BY_NAME.get(name);
  const problems = tool ? validate(tool.input, args ?? {}) : [];
  if (tool && !problems.length) return cfg.rpc('ai_call', { p_token_hash: tokenHash, p_tool: name, p_args: args ?? {} });
  // Refused before reaching the database: still check the token first, so a stranger learns nothing but "401".
  const a = await cfg.rpc('ai_authenticate', { p_token_hash: tokenHash });
  if (!a.ok) return a;
  return { ok: false, error: tool ? { code: 'invalid', message: problems.join('; ') } : { code: 'not_found', message: `Unknown tool ${name}` } };
}

async function handleMessage(cfg, tokenHash, msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Invalid request');
  const { id, method, params } = msg;
  if (id === undefined) return null;                      // a notification: nothing to answer
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case 'ping': return rpcResult(id, {});
    case 'tools/list': return rpcResult(id, { tools: toolList() });
    case 'tools/call': {
      const name = params && params.name;
      if (typeof name !== 'string') return rpcError(id, -32602, 'params.name is required');
      const out = await runTool(cfg, tokenHash, name, params.arguments);
      if (!out.ok) {
        if (out.error.code === 'unauthorized') return { unauthorized: true };
        if (out.error.code === 'not_found' && !TOOL_BY_NAME.has(name)) return rpcError(id, -32602, out.error.message);
        return toolError(id, out.error.message);
      }
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(out.result) }], structuredContent: out.result, isError: false });
    }
    case 'resources/list': return rpcResult(id, { resources: [] });
    case 'prompts/list': return rpcResult(id, { prompts: [] });
    default: return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// `unauthorized()` is the 401 response for a bad token. `refuse(res)` returns `res` only if the token is valid.
// Every message is answered only after the token has been checked: tool calls by ai_call itself, everything else
// (including malformed tool calls, which never reach ai_call) by one up-front check.
const isRealToolCall = (m) => m && typeof m === 'object' && m.jsonrpc === '2.0' && m.method === 'tools/call' && m.id !== undefined
  && m.params && typeof m.params.name === 'string';

export async function mcp(cfg, req, tokenHash, unauthorized, refuse) {
  const { text, tooLarge } = await readBody(req);
  if (tooLarge) return refuse(json(rpcError(null, -32600, 'Request too large'), 413));
  let body; try { body = JSON.parse(text); } catch { return refuse(json(rpcError(null, -32700, 'Parse error'), 400)); }
  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  if (!msgs.length || msgs.length > 20) return refuse(json(rpcError(null, -32600, 'Invalid request'), 400));
  if (!msgs.every(isRealToolCall)) {
    const stop = await refuse(null);
    if (stop) return stop;
  }
  const out = [];
  for (const m of msgs) {
    const r = await handleMessage(cfg, tokenHash, m);
    if (r && r.unauthorized) return unauthorized();
    if (r) out.push(r);
  }
  if (!out.length) return new Response(null, { status: 202 });
  return json(batch ? out : out[0]);
}
