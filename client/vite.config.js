import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc"; // Si ya lo cambiaste, genial; si no, hacelo ahora
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr"; // ← Nueva importación
import path from "path";

function manualChunks(id) {
  if (!id.includes("node_modules")) return;

  if (
    id.includes("/react/") ||
    id.includes("/react-dom/") ||
    id.includes("/scheduler/")
  ) {
    return "vendor-react";
  }

  if (id.includes("/recharts/")) {
    return "vendor-charts";
  }

  // xlsx solo se importa dinámicamente (carga masiva de repuestos): se deja
  // fuera de vendor-misc para que Rollup le arme su propio chunk on-demand,
  // en vez de agruparlo con código que sí viaja en la carga inicial.
  if (id.includes("/xlsx/")) {
    return;
  }

  return "vendor-misc";
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    svgr({ exportAsDefault: true }) // ⚡ Esto asegura que default export sea componente React
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: true,        // 🔥 ESTO ES LA CLAVE
    port: 5174,
    open: false,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
});