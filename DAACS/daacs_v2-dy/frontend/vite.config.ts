import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, "");
  const apiPort = env.DAACS_PORT || env.VITE_DAACS_API_PORT || "8001";
  const httpTarget = `http://localhost:${apiPort}`;
  const wsTarget = `ws://localhost:${apiPort}`;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      },
    },
    root: path.resolve(import.meta.dirname, "client"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: {
            // Vendor chunks - heavy libraries loaded on demand
            "vendor-mermaid": ["mermaid"],
            "vendor-monaco": ["@monaco-editor/react", "monaco-editor"],
            "vendor-react": ["react", "react-dom"],
            "vendor-radix": [
              "@radix-ui/react-dialog",
              "@radix-ui/react-dropdown-menu",
              "@radix-ui/react-tabs",
              "@radix-ui/react-tooltip",
              "@radix-ui/react-scroll-area",
            ],
            "vendor-icons": ["lucide-react"],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        // DAACS API proxy
        "/api": {
          target: httpTarget,
          changeOrigin: true,
        },
        // WebSocket proxy for logs
        "/ws": {
          target: wsTarget,
          ws: true,
        },
      },
    },
    preview: {
      port: 5176,
      proxy: {
        "/api": {
          target: httpTarget,
          changeOrigin: true,
        },
        "/ws": {
          target: wsTarget,
          ws: true,
        },
      },
    },
  };
});
