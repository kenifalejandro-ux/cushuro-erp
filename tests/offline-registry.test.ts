/** tests/offline-registry.test.ts
 *
 * Vigila el punto de duplicación deliberado del Contrato de Módulo: qué
 * escrituras participan del offline se declara DOS veces (una en el
 * registry del backend, otra en el del cliente, porque son dos builds
 * separados — ver client/src/modules/registry.tsx).
 *
 * Que diverjan no rompe nada visible: simplemente el cliente encolaría una
 * ruta que el servidor NO atiende con idempotentInsert(), y el reintento
 * crearía un duplicado. Es exactamente la clase de fallo silencioso que el
 * ADR-0002 vino a eliminar cuando "qué módulos existen" eran 5 listas
 * sueltas — así que se prueba igual que aquello (tests/module-registry.test.ts).
 *
 * Vive en tests/ y no en client/ por el mismo motivo que
 * sentry-frontend-filter.test.ts: client/ no tiene runner propio, y esto
 * es lógica pura sin DOM ni import.meta.env.
 */
import { describe, it, expect } from "vitest";

import { MODULOS } from "../src/modules/registry";
import { ESCRITURAS_OFFLINE } from "../client/src/modules/offlineRegistry";
import { moduloParaEncolar, rutasOfflineDeclaradas } from "../client/src/offline/rutasOffline";

describe("declaración de offline: backend vs cliente", () => {
  it("los dos registries declaran exactamente las mismas escrituras offline", () => {
    const delBackend = MODULOS.flatMap((m) =>
      (m.offline?.escrituras ?? []).map((e) => `${e.metodo} /${m.id}${e.ruta}`)
    ).sort();

    const delCliente = Object.entries(ESCRITURAS_OFFLINE)
      .flatMap(([id, escrituras]) => escrituras.map((e) => `${e.metodo} /${id}${e.ruta}`))
      .sort();

    expect(delCliente).toEqual(delBackend);
  });

  it("todo módulo con offline declarado existe en el registry del backend", () => {
    const idsBackend = new Set(MODULOS.map((m) => m.id));
    for (const ruta of rutasOfflineDeclaradas()) {
      expect(idsBackend).toContain(ruta.moduloId);
    }
  });
});

describe("qué se encola y qué no", () => {
  it("encola el POST de crear checklist", () => {
    expect(moduloParaEncolar("/api/erp/checklists", "POST")).toBe("checklists");
  });

  it("ignora el query string y la barra final", () => {
    expect(moduloParaEncolar("/api/erp/checklists/", "POST")).toBe("checklists");
    expect(moduloParaEncolar("/api/erp/checklists?pageSize=50", "POST")).toBe("checklists");
  });

  it("NO encola lecturas: un GET sin red debe fallar, no quedar pendiente", () => {
    expect(moduloParaEncolar("/api/erp/checklists", "GET")).toBeNull();
  });

  it("NO encola el DELETE de un checklist ni el de una plantilla", () => {
    // Reintentar un borrado a ciegas puede eliminar algo que se recreó
    // entre medio; y las plantillas son configuración de oficina, no
    // trabajo de campo.
    expect(moduloParaEncolar("/api/erp/checklists/12", "DELETE")).toBeNull();
    expect(moduloParaEncolar("/api/erp/checklists/plantillas/3", "DELETE")).toBeNull();
    expect(moduloParaEncolar("/api/erp/checklists/plantillas", "POST")).toBeNull();
  });

  it("NO encola módulos que todavía no declararon offline", () => {
    // Hasta que IPERC y Combustible pasen por idempotentInsert(), encolar
    // sus escrituras duplicaría en el reintento.
    expect(moduloParaEncolar("/api/erp/iperc", "POST")).toBeNull();
    expect(moduloParaEncolar("/api/erp/combustible", "POST")).toBeNull();
    expect(moduloParaEncolar("/api/erp/equipos", "POST")).toBeNull();
  });

  it("NO encola nada de autenticación", () => {
    // Un login o un refresh reintentado horas después no tiene sentido, y
    // el refresh además revoca la sesión si se reusa (auth.service.ts).
    expect(moduloParaEncolar("/api/auth/login", "POST")).toBeNull();
    expect(moduloParaEncolar("/api/auth/refresh", "POST")).toBeNull();
  });

  it("una URL absoluta del mismo endpoint matchea igual que la relativa", () => {
    expect(moduloParaEncolar("https://erp.example.com/api/erp/checklists", "POST")).toBe(
      "checklists"
    );
  });
});
