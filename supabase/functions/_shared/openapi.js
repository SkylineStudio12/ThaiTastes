// OpenAPI 3.1 document for ChatGPT Custom GPT Actions, built from the same tool list as the MCP server.
import { TOOLS } from './tools.js';

export function openapi(base) {
  const paths = {};
  for (const t of TOOLS) {
    paths['/api/' + t.name] = { post: {
      operationId: t.name, summary: t.title, description: t.description,
      ...(t.write ? {} : { 'x-openai-isConsequential': false }),
      requestBody: { required: true, content: { 'application/json': { schema: t.input } } },
      responses: {
        200: { description: 'The result. For update_entry and rate_entry, conflict: true means nothing was written.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
        400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' },
        404: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' },
      },
    } };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'ThaiTastes', version: '1.0.0', description: 'Greg and Andra\'s Thailand food journal: read it, log what they ate, and propose dishes and places.' },
    servers: [{ url: base }],
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {},
      responses: { Error: { description: 'What went wrong.', content: { 'application/json': { schema: { type: 'object',
        properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] } } } } },
    },
  };
}
