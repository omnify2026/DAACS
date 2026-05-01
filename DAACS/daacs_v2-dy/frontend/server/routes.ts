import type { Express } from "express";
import { createServer, type Server } from "http";
import { createProxyMiddleware } from "http-proxy-middleware";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // Proxy all /api requests to the Python Backend (DAACS Engine)
  // This resolves the "Split-Brain" architecture by making Node.js a thin gateway.
  const DAACS_API_URL = process.env.DAACS_API_URL || "http://127.0.0.1:8001";
  const DAACS_WS_URL = process.env.DAACS_WS_URL || DAACS_API_URL;

  app.use(
    "/api",
    createProxyMiddleware({
      target: DAACS_API_URL,
      changeOrigin: true,
      // logLevel and onError removed for v3 compatibility
    })
  );

  app.use(
    "/ws",
    createProxyMiddleware({
      target: DAACS_WS_URL,
      changeOrigin: true,
      ws: true,
    })
  );

  console.log(`[Frontend Server] configured as Proxy to ${DAACS_API_URL} (ws: ${DAACS_WS_URL})`);

  return httpServer;
}
