import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopSkillsMetadata = path.resolve(
  webRoot,
  "../desktop/Resources/skills/skills_metadata.json",
);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_PROXY_TARGET || "http://localhost:8001";
  const proxy = {
    "/api": {
      target: proxyTarget,
      changeOrigin: true,
    },
    "/ws": {
      target: proxyTarget,
      changeOrigin: true,
      ws: true,
    },
  };

  return {
    base: "./",
    plugins: [react()],
    resolve: {
      alias: {
        "@daacs/desktop-skills-metadata": desktopSkillsMetadata,
      },
    },
    server: {
      host: "0.0.0.0",
      port: 3001,
      fs: {
        allow: [path.resolve(webRoot, ".."), path.resolve(webRoot, "../desktop")],
      },
      proxy,
    },
    preview: {
      host: "0.0.0.0",
      port: 3001,
      proxy,
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (id.includes("/react") || id.includes("/react-dom") || id.includes("/scheduler")) {
              return "vendor-react";
            }
            if (id.includes("/framer-motion") || id.includes("/motion-dom") || id.includes("/motion-utils")) {
              return "vendor-motion";
            }
            if (id.includes("/lucide-react")) {
              return "vendor-icons";
            }
            return "vendor";
          },
        },
      },
    },
  };
});
