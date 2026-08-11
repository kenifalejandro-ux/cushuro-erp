import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15000,
    hookTimeout: 15000,
    globalSetup: ["tests/global-setup.redis.ts"],
    // Fuerza los drivers de storage a "local" en toda la suite -- ver el
    // comentario del archivo: sin esto, una máquina con R2 configurado
    // (lo normal para quien opera producción) escribe en el bucket real.
    setupFiles: ["tests/setup.storage.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      // Piso real de hoy (2026-08-05): statements 65.73%, branches 55.39%,
      // functions 69.81%, lines 66.84% -- estos umbrales quedan un poco por
      // debajo para no romper CI por una fluctuación mínima, pero sí cortar
      // si un PR baja el coverage de verdad (código nuevo sin tests).
      thresholds: {
        statements: 65,
        branches: 55,
        functions: 69,
        lines: 66,
      },
    },
  },
});
