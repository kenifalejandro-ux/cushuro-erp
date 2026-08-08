/** tests/sentry-frontend-filter.test.ts
 *
 * Prueba el filtro que corre sobre cada evento del frontend antes de que
 * salga hacia Sentry. Vive acá y no en client/ porque client/ no tiene
 * runner de tests propio — y no hace falta uno: el filtro es una función
 * pura que no toca el SDK ni `import.meta.env`, justamente para poder
 * probarla con el vitest de la raíz sin navegador, sin DSN y sin red.
 * Mismo criterio que tests/sentry-config.test.ts para el backend.
 *
 * Lo que se prueba no es "que la librería funcione", es la promesa que le
 * hacemos al cliente: que un error reportado desde el navegador NO se
 * lleve consigo ni credenciales ni datos de negocio de su tenant.
 */
import { describe, it, expect } from "vitest";

import { censurarCamposSensibles, filtrarEventoSentry } from "../client/src/config/sentryFilter";

describe("filtro de eventos de Sentry (frontend)", () => {
  it("censura credenciales sin importar a qué profundidad estén", () => {
    const evento = {
      contexts: {
        estado: {
          password: "SuperSecreta123",
          accessToken: "eyJhbGciOi...",
          nested: { authorization: "Bearer abc", refresh_token: "xyz" },
        },
      },
    };

    const limpio = censurarCamposSensibles(evento);

    expect(limpio.contexts.estado.password).toBe("[redacted]");
    expect(limpio.contexts.estado.accessToken).toBe("[redacted]");
    expect(limpio.contexts.estado.nested.authorization).toBe("[redacted]");
    expect(limpio.contexts.estado.nested.refresh_token).toBe("[redacted]");
  });

  it("deja intacto lo que sirve para diagnosticar", () => {
    const evento = { mensaje: "fallo al guardar", url: "/api/erp/repuestos", status: 500 };

    const limpio = censurarCamposSensibles(evento);

    expect(limpio.mensaje).toBe("fallo al guardar");
    expect(limpio.url).toBe("/api/erp/repuestos");
    expect(limpio.status).toBe(500);
  });

  it("borra el cuerpo del request: ahí viajan los datos del tenant", () => {
    // El caso real que esto previene: un error al importar un Excel de
    // repuestos mandaría el lote entero del cliente a Sentry, donde lo ve
    // cualquiera con acceso al proyecto. Para diagnosticar alcanza con
    // saber qué request falló.
    const evento = {
      request: {
        url: "/api/erp/repuestos/bulk",
        method: "POST",
        data: [{ codigo: "FILTRO-001", nombre: "Filtro de aceite", precio: 1234.56 }],
      },
    };

    const limpio = filtrarEventoSentry(evento);

    expect(limpio.request).toBeDefined();
    expect(limpio.request!.url).toBe("/api/erp/repuestos/bulk");
    expect(limpio.request!.method).toBe("POST");
    expect("data" in limpio.request!).toBe(false);
  });

  it("no se cuelga con referencias circulares", () => {
    // Los eventos de Sentry las traen seguido (un error cuyo `cause` apunta
    // de vuelta a sí mismo). Sin la guarda, el filtro entraría en loop
    // infinito y colgaría la pestaña del usuario — peor que el error que se
    // está reportando.
    const circular: Record<string, unknown> = { nombre: "evento" };
    circular.self = circular;

    expect(() => censurarCamposSensibles(circular)).not.toThrow();
  });

  it("no rompe con valores que no son objetos", () => {
    expect(censurarCamposSensibles(null)).toBeNull();
    expect(censurarCamposSensibles(undefined)).toBeUndefined();
    expect(censurarCamposSensibles("texto")).toBe("texto");
    expect(censurarCamposSensibles(42)).toBe(42);
  });

  it("censura dentro de arrays, no solo de objetos", () => {
    const evento = { breadcrumbs: [{ password: "abc" }, { url: "/api/erp/equipos" }] };

    const limpio = censurarCamposSensibles(evento);

    expect(limpio.breadcrumbs[0].password).toBe("[redacted]");
    expect(limpio.breadcrumbs[1].url).toBe("/api/erp/equipos");
  });
});
