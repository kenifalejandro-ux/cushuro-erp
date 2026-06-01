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
    id.includes("/scheduler/") ||
    id.includes("/react-router/") ||
    id.includes("/react-router-dom/")
  ) {
    return "vendor-react";
  }

  if (id.includes("/gsap/")) {
    return "vendor-gsap";
  }

  if (
    id.includes("/three/") ||
    id.includes("/@react-three/") ||
    id.includes("/meshoptimizer/")
  ) {
    return "vendor-three";
  }

  if (id.includes("/framer-motion/") || id.includes("/motion/")) {
    return "vendor-motion";
  }

  if (
    id.includes("/react-slick/") ||
    id.includes("/slick-carousel/") ||
    id.includes("/embla-carousel-react/")
  ) {
    return "vendor-carousel";
  }

  if (id.includes("/chart.js/") || id.includes("/recharts/")) {
    return "vendor-charts";
  }

  if (
    id.includes("/@radix-ui/") ||
    id.includes("/cmdk/") ||
    id.includes("/input-otp/") ||
    id.includes("/sonner/") ||
    id.includes("/vaul/") ||
    id.includes("/react-day-picker/") ||
    id.includes("/react-hook-form/") ||
    id.includes("/class-variance-authority/") ||
    id.includes("/clsx/") ||
    id.includes("/tailwind-merge/")
  ) {
    return "vendor-ui";
  }

  if (
    id.includes("/@fortawesome/") ||
    id.includes("/lucide-react/")
  ) {
    return "vendor-icons";
  }

  if (id.includes("/lodash/")) {
    return "vendor-utils";
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
      "three-examples": path.resolve(__dirname, "node_modules/three/examples/jsm"),
    },
  },
  server: {
    host: true,        // 🔥 ESTO ES LA CLAVE
    port: 5173,
    open: false,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
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