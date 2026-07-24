import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, "");
  const webHost = env.WEB_HOST || "127.0.0.1";
  const webPort = Number(env.WEB_PORT) || 5173;
  const apiTarget = `http://${env.SERVER_HOST || "127.0.0.1"}:${env.SERVER_PORT || "3000"}`;

  return {
    envDir: rootDir,
    plugins: [react()],
    server: {
      host: webHost,
      port: webPort,
      strictPort: true,
      allowedHosts: true,
      proxy: {
        "/api": apiTarget,
        "/e": apiTarget,
        "/d": apiTarget,
        "/mcp": apiTarget,
        "/health": apiTarget
      }
    },
    preview: {
      host: webHost,
      strictPort: true,
      allowedHosts: true
    }
  };
});
