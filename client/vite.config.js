import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc"; // Si ya lo cambiaste, genial; si no, hacelo ahora
import path from "path";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import svgr from "vite-plugin-svgr"; // ← Nueva importación

function manualChunks(id) {
  if (!id.includes("node_modules")) return;

  if (id.includes("/react/") || id.includes("/react-dom/") || id.includes("/scheduler/")) {
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
    svgr({ exportAsDefault: true }), // ⚡ Esto asegura que default export sea componente React
    VitePWA({
      // Registro manual en src/main.tsx vía virtual:pwa-register, no
      // inyectado automáticamente por el plugin.
      injectRegister: null,
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "favicon.svg", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "MinCore ERP",
        short_name: "MinCore",
        lang: "es-PE",
        description:
          "ERP para el sector minero: gestión de repuestos, combustible y documentos de vencimiento",
        theme_color: "#C6FB32",
        background_color: "#0A1014",
        start_url: "/",
        display: "standalone",
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Alcance de esta fase (Grupo 1): solo el app shell. Nada de
        // /api/* entra al precache ni a ninguna regla de runtime caching
        // — ni catálogos, ni nada — eso es Grupo 2. navigateFallback es
        // lo único que podría interceptar una URL no precacheada al
        // navegar offline, así que se excluye /api explícitamente aunque
        // Workbox solo lo aplica a navegaciones de documento, no a los
        // fetch() de apiClient.ts.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    host: true, // 🔥 ESTO ES LA CLAVE
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
