import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

// Plugin to serve and auto-bundle local MathJax resources
function mathjaxLocalPlugin(): Plugin {
  return {
    name: "mathjax-local-plugin",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith("/mathjax/")) {
          const filePath = req.url.split("?")[0].replace("/mathjax/", "");
          const localPublicPath = path.resolve(__dirname, "public", "mathjax", filePath);
          const nodeModulesPath = path.resolve(__dirname, "node_modules", "mathjax", "es5", filePath);
          
          let targetPath = "";
          if (fs.existsSync(localPublicPath)) {
            targetPath = localPublicPath;
          } else if (fs.existsSync(nodeModulesPath)) {
            targetPath = nodeModulesPath;
          }

          if (targetPath) {
            res.setHeader("Content-Type", targetPath.endsWith(".js") ? "application/javascript" : "text/plain");
            return fs.createReadStream(targetPath).pipe(res);
          }
        }
        next();
      });
    },
    buildStart() {
      // Auto-copy MathJax into public/mathjax if node_modules/mathjax is present
      try {
        const mathjaxDir = path.resolve(__dirname, "node_modules", "mathjax", "es5");
        const publicMathjaxDir = path.resolve(__dirname, "public", "mathjax");
        if (fs.existsSync(mathjaxDir)) {
          if (!fs.existsSync(publicMathjaxDir)) {
            fs.mkdirSync(publicMathjaxDir, { recursive: true });
          }
          ["tex-svg.js", "tex-chtml.js"].forEach((file) => {
            const src = path.join(mathjaxDir, file);
            const dst = path.join(publicMathjaxDir, file);
            if (fs.existsSync(src) && !fs.existsSync(dst)) {
              fs.copyFileSync(src, dst);
            }
          });
        }
      } catch {}
    }
  };
}

export default defineConfig(async () => ({
  plugins: [react(), mathjaxLocalPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
