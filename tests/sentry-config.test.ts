/** tests/sentry-config.test.ts
 *
 * config/sentry.ts: la sanitización de eventos antes de mandarlos (misma
 * lista de campos sensibles que ya usa el logger, ver sanitizeLog.ts) y que
 * capturarError() sea un no-op inofensivo cuando SENTRY_DSN no está
 * configurado -- que es el caso en toda esta suite (ver .env.example: vacío
 * por default), así que estos tests corren con Sentry deshabilitado a
 * propósito, igual que en cualquier entorno que no lo haya configurado.
 */
import { describe, it, expect, vi } from "vitest";

// @sentry/node congela sus exports (namespace ESM no configurable) --
// vi.spyOn no puede pisar captureException directo (ver el error real que
// tira: "Cannot redefine property"). vi.mock reemplaza el módulo entero
// ANTES de que se resuelva el import, así que no depende de que el export
// sea configurable.
vi.mock("@sentry/node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sentry/node")>();
  return { ...actual, captureException: vi.fn() };
});

import { filtrarEventoSentry, capturarError, Sentry } from "../src/server/config/sentry";

describe("filtrarEventoSentry", () => {
  it("censura campos sensibles en cualquier profundidad, sin tocar el resto", () => {
    const evento = {
      message: "algo falló",
      request: {
        headers: { authorization: "Bearer abc123", "content-type": "application/json" },
        data: { email: "admin@test.local", password: "hunter2" },
      },
      extra: {
        backupId: "f913473c-...",
        tenantOriginalId: "23cb7503-...",
        token: "eyJhbGciOi...",
      },
    };

    const filtrado = filtrarEventoSentry(evento);

    expect(filtrado.request.headers.authorization).toBe("[redacted]");
    expect(filtrado.request.data.password).toBe("[redacted]");
    expect(filtrado.extra.token).toBe("[redacted]");

    // Lo que no es sensible sobrevive intacto -- si esto también se
    // censurara, el evento en Sentry sería inútil para diagnosticar nada.
    expect(filtrado.message).toBe("algo falló");
    expect(filtrado.request.headers["content-type"]).toBe("application/json");
    expect(filtrado.request.data.email).toBe("admin@test.local");
    expect(filtrado.extra.backupId).toBe("f913473c-...");
    expect(filtrado.extra.tenantOriginalId).toBe("23cb7503-...");
  });
});

describe("capturarError", () => {
  it("sin SENTRY_DSN configurado, no llama a Sentry.captureException ni tira", () => {
    expect(() =>
      capturarError(new Error("falla forzada de prueba"), { worker: "test" })
    ).not.toThrow();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
