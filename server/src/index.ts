import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { Request, Response, Express } from "express";
import fs from "node:fs";
import { mcp } from "./middleware.js";
import server from "./server.js";
import { Orchestrator } from "./orchestrator.js";
import { PersistenceManager } from "./persistence.js";
import { toolRouter } from "./tool-routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, "../../.env") });

const app = express() as Express;
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ── MCP endpoint (Skybridge middleware) ──────────────────────────────
app.use(mcp(server));

// ── Dev: Skybridge DevTools + Vite HMR ──────────────────────────────
const env = process.env.NODE_ENV || "development";

if (env !== "production") {
  try {
    const { devtoolsStaticServer } = await import("@skybridge/devtools");
    const { widgetsDevServer } = await import("skybridge/server");
    app.use(await devtoolsStaticServer());
    app.use(await widgetsDevServer());
  } catch (e) {
    console.warn("[Dev] Skybridge DevTools not available:", (e as Error).message);
  }
}

// ── Production: serve widget assets ─────────────────────────────────
if (env === "production") {
  app.use("/assets", cors());
  app.use("/assets", express.static(path.join(__dirname, "assets")));
}

// ── DSL endpoints — serve agent YAMLs for Dify ──────────────────────
const DSL_DIR = path.join(__dirname, "../../dify-workflows");

app.get("/dsl/:name", (req: Request, res: Response) => {
  const name = String(req.params.name).replace(/[^a-z0-9_\-]/gi, "");
  const filePath = path.join(DSL_DIR, `${name}.yml`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `DSL not found: ${name}` });
  }
  res.setHeader("Content-Type", "application/x-yaml");
  res.setHeader("Content-Disposition", `inline; filename="${name}.yml"`);
  fs.createReadStream(filePath).pipe(res);
});

app.get("/dsl", (_req: Request, res: Response) => {
  if (!fs.existsSync(DSL_DIR)) return res.json([]);
  const files = fs.readdirSync(DSL_DIR).filter((f) => f.endsWith(".yml"));
  const baseUrl = `${_req.protocol}://${_req.get("host")}`;
  res.json(files.map((f) => ({ name: f.replace(".yml", ""), url: `${baseUrl}/dsl/${f.replace(".yml", "")}` })));
});

// ── REST API routes (Dify compatibility) ─────────────────────────────
app.use("/api/tools", toolRouter);

app.post("/api/deals", async (req: Request, res: Response) => {
  try {
    const dealId = await Orchestrator.createDeal(req.body);
    res.json({ dealId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/deals/:id/run", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!Orchestrator.dealExists(id)) return res.status(404).json({ error: "Deal not found" });
  Orchestrator.runSimulation(id).catch((err) => console.error(`Sim error: ${err.message}`));
  res.json({ status: "started", dealId: id });
});

app.get("/api/deals/:id/state", (req: Request, res: Response) => {
  const state = PersistenceManager.getState(String(req.params.id));
  if (!state) return res.status(404).json({ error: "Deal not found" });
  res.json(state);
});

app.get("/api/deals/:id/stream", (req: Request, res: Response) => {
  const id = String(req.params.id);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  Orchestrator.addStream(id, res);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

process.on("SIGINT", async () => {
  console.log("Server shutdown complete");
  process.exit(0);
});
