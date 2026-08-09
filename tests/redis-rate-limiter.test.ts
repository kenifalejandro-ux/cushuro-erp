/** tests/redis-rate-limiter.test.ts
 *
 * crearLimitadorPorIp/crearLimitador (middleware/redisRateLimiter.ts) — la
 * factory que usan platformTenantRateLimiter.ts,
 * platformAdminLoginRateLimiter.ts, loginEmailRateLimiter.ts y
 * forgotPasswordEmailRateLimiter.ts. No depende de la app ni de Postgres,
 * así que corre siempre, con o sin Redis real disponible (usa Redis si
 * `globalSetup` lo levantó, cae al Map en memoria si no) — el
 * comportamiento observable (dejar pasar hasta el límite, 429 con
 * Retry-After después) tiene que ser el mismo en cualquiera de los dos
 * casos.
 */
import { describe, it, expect, vi } from "vitest";
import { crearLimitadorPorIp, crearLimitador } from "../src/server/middleware/redisRateLimiter";

function fakeReqRes(ip: string, body?: unknown) {
  const req: any = { ip, headers: {}, socket: { remoteAddress: ip }, validatedBody: body };
  const res: any = {
    statusCode: 200,
    setHeader: vi.fn(),
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return { req, res };
}

async function llamar(limitar: ReturnType<typeof crearLimitadorPorIp>, ip: string, body?: unknown) {
  const { req, res } = fakeReqRes(ip, body);
  let siguienteLlamado = false;
  // limitar() ahora pasa por asyncHandler (ver eslint no-misused-promises):
  // Express nunca esperó su promesa, y desde este test tampoco se puede
  // esperar el valor de retorno -- se sincroniza con next()/res.json(),
  // que son los dos puntos donde la lógica async del middleware termina.
  await new Promise<void>((resolve) => {
    const jsonOriginal = res.json.bind(res);
    res.json = (body: unknown) => {
      const resultado = jsonOriginal(body);
      resolve();
      return resultado;
    };
    limitar(req, res, () => {
      siguienteLlamado = true;
      resolve();
    });
  });
  return { siguienteLlamado, res };
}

describe("crearLimitadorPorIp: límite por IP, con o sin Redis real", () => {
  it("deja pasar hasta el límite y después devuelve 429 con Retry-After", async () => {
    const limitar = crearLimitadorPorIp({
      prefijoClave: `test-limite-${Date.now()}`,
      windowMs: 60_000,
      maxRequests: 3,
      mensaje: "límite de prueba",
    });
    const ip = "10.0.0.1";

    for (let i = 0; i < 3; i++) {
      const { siguienteLlamado } = await llamar(limitar, ip);
      expect(siguienteLlamado).toBe(true);
    }

    const { siguienteLlamado, res } = await llamar(limitar, ip);
    expect(siguienteLlamado).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(res.body.message).toBe("límite de prueba");
  });

  it("el límite es por IP: una IP distinta no se ve afectada por la otra", async () => {
    const limitar = crearLimitadorPorIp({
      prefijoClave: `test-porip-${Date.now()}`,
      windowMs: 60_000,
      maxRequests: 1,
      mensaje: "límite de prueba",
    });

    expect((await llamar(limitar, "10.0.0.2")).siguienteLlamado).toBe(true);
    expect((await llamar(limitar, "10.0.0.2")).siguienteLlamado).toBe(false);
    // IP distinta, mismo limitador: no hereda el conteo de la anterior.
    expect((await llamar(limitar, "10.0.0.3")).siguienteLlamado).toBe(true);
  });
});

describe("crearLimitador: clave personalizada (base de loginEmailRateLimiter/forgotPasswordEmailRateLimiter)", () => {
  it("agrupa por lo que devuelve extraerClave, no por IP -- distintas IPs con la misma clave comparten el contador", async () => {
    const limitar = crearLimitador({
      prefijoClave: `test-email-${Date.now()}`,
      windowMs: 60_000,
      maxRequests: 1,
      mensaje: "límite de prueba por email",
      extraerClave: (req: any) => req.validatedBody?.email,
    });

    // Simula un atacante repartiendo intentos contra la MISMA cuenta desde
    // IPs distintas -- exactamente el caso que el rateLimiter genérico
    // (por IP) no cubre y que motivó este limitador.
    expect(
      (await llamar(limitar, "10.0.0.10", { email: "victima@empresa.test" })).siguienteLlamado
    ).toBe(true);
    expect(
      (await llamar(limitar, "10.0.0.11", { email: "victima@empresa.test" })).siguienteLlamado
    ).toBe(false);
  });

  it("una clave distinta (otra cuenta) no se ve afectada por la anterior", async () => {
    const limitar = crearLimitador({
      prefijoClave: `test-email-otra-${Date.now()}`,
      windowMs: 60_000,
      maxRequests: 1,
      mensaje: "límite de prueba por email",
      extraerClave: (req: any) => req.validatedBody?.email,
    });

    expect((await llamar(limitar, "10.0.0.10", { email: "a@empresa.test" })).siguienteLlamado).toBe(
      true
    );
    expect((await llamar(limitar, "10.0.0.10", { email: "a@empresa.test" })).siguienteLlamado).toBe(
      false
    );
    expect((await llamar(limitar, "10.0.0.10", { email: "b@empresa.test" })).siguienteLlamado).toBe(
      true
    );
  });

  it("si extraerClave devuelve undefined (falta el campo), deja pasar sin contar", async () => {
    const limitar = crearLimitador({
      prefijoClave: `test-email-sinclave-${Date.now()}`,
      windowMs: 60_000,
      maxRequests: 1,
      mensaje: "límite de prueba por email",
      extraerClave: (req: any) => req.validatedBody?.email,
    });

    // Sin `email` en el body (ej. un body malformado que igual llegó
    // hasta acá) no hay nada que limitar -- ningún request queda
    // bloqueado por no tener con qué construir una clave.
    for (let i = 0; i < 5; i++) {
      expect((await llamar(limitar, "10.0.0.20", {})).siguienteLlamado).toBe(true);
    }
  });
});
