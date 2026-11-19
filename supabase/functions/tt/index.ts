// ThaiTastes AI layer: MCP (/mcp), REST (/api/<tool>) and OAuth for MCP clients. All logic is in ../_shared.
// Deploy: supabase functions deploy tt   (verify_jwt is off in supabase/config.toml; the handler checks tokens itself)
// Secrets: APP_URL (the GitHub Pages address of the app). SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { createHandler } from '../_shared/handler.js';

const url = Deno.env.get('SUPABASE_URL')!;
const appUrl = Deno.env.get('APP_URL');
const sb = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });

const handler = createHandler({
  base: Deno.env.get('TT_PUBLIC_URL') ?? `${url}/functions/v1/tt`,
  appUrl: appUrl ?? '',
  async rpc(name: string, params: Record<string, unknown>) {
    const { data, error } = await sb.rpc(name, params);
    if (error) throw new Error(`${name}: ${error.message}`);
    return data;
  },
});

Deno.serve((req: Request) => {
  if (!appUrl) return new Response('APP_URL is not set. Run: supabase secrets set APP_URL=https://<user>.github.io/<repo>/', { status: 500 });
  return handler(req);
});
