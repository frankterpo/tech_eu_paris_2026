import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Orchestrator } from './orchestrator';
import { PersistenceManager } from './persistence';
import { toolRouter } from './tool-routes';
import { createMcpServer } from './mcp-server';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── MCP Streamable HTTP endpoint ─────────────────────────────────────
// Following Alpic template: new McpServer per request (stateless, warm-start safe)
app.post('/mcp', async (req: Request, res: Response) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close();
    });

    const server = createMcpServer();
    await server.connect(transport);

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] Error handling request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      });
    }
  }
});

app.get('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    }),
  );
});

app.delete('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed.',
      },
      id: null,
    }),
  );
});

// ── DSL endpoints — serve agent YAMLs for Dify "Import from URL" ────
const DSL_DIR = path.join(__dirname, '../../dify-workflows');

app.get('/dsl/:name', (req: Request, res: Response) => {
  const name = String(req.params.name).replace(/[^a-z0-9_\-]/gi, '');
  const filePath = path.join(DSL_DIR, `${name}.yml`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `DSL not found: ${name}` });
  }
  res.setHeader('Content-Type', 'application/x-yaml');
  res.setHeader('Content-Disposition', `inline; filename="${name}.yml"`);
  fs.createReadStream(filePath).pipe(res);
});

// List all available DSLs
app.get('/dsl', (_req: Request, res: Response) => {
  const files = fs.readdirSync(DSL_DIR).filter(f => f.endsWith('.yml'));
  const baseUrl = `${_req.protocol}://${_req.get('host')}`;
  res.json(files.map(f => ({
    name: f.replace('.yml', ''),
    url: `${baseUrl}/dsl/${f.replace('.yml', '')}`
  })));
});

// Tool API routes — exposed for Dify Agent tool calls
app.use('/api/tools', toolRouter);

// POST /api/deals — create a new deal session
app.post('/api/deals', async (req: Request, res: Response) => {
  try {
    const dealId = await Orchestrator.createDeal(req.body);
    res.json({ dealId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/deals/:id/run — trigger simulation
app.post('/api/deals/:id/run', async (req: Request, res: Response) => {
  const id = String(req.params.id);

  if (!Orchestrator.dealExists(id)) {
    return res.status(404).json({ error: 'Deal not found' });
  }

  // Trigger simulation in background, respond immediately
  Orchestrator.runSimulation(id).catch(err => {
    console.error(`Simulation error for deal ${id}:`, err.message);
  });
  res.json({ status: 'started', dealId: id });
});

// GET /api/deals/:id/state — fetch current canonical state
app.get('/api/deals/:id/state', (req: Request, res: Response) => {
  const state = PersistenceManager.getState(String(req.params.id));
  if (!state) return res.status(404).json({ error: 'Deal not found' });
  res.json(state);
});

// GET /api/deals/:id/stream — SSE event stream
app.get('/api/deals/:id/stream', (req: Request, res: Response) => {
  const id = String(req.params.id);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  Orchestrator.addStream(id, res);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

process.on('SIGINT', async () => {
  console.log('Server shutdown complete');
  process.exit(0);
});
