/** tests/auditoria-mutaciones.test.ts
 *
 * Test de humo: que las mutaciones principales de cada módulo de negocio
 * dejen AL MENOS una fila en platform_audit_log. No valida `detalle` ni el
 * nombre exacto de la `accion` -- eso es criterio humano por caso (ver
 * docs/adr/0002-contrato-de-modulo.md, sección "Fuera de alcance": no hay
 * lint ni test que exija llamar registrarAuditoria(), queda a criterio de
 * quien escribe el controller). Esto solo prueba "¿pasó algo?", que es lo
 * único que se puede verificar sin ese criterio.
 *
 * repuestos, combustible y documentos NO auditan ninguna mutación hoy
 * (confirmado leyendo sus controllers: cero llamadas a registrarAuditoria)
 * -- a propósito, este archivo lo REPORTA con it.todo() en vez de forzar
 * el comportamiento agregando auditoría por su cuenta. Un it.todo() queda
 * visible en la salida de `npm test` como pendiente, sin romper el build.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";

afterAll(async () => {
  await closeDatabase();
});

async function filasDeAuditoria(tenantId: string): Promise<number> {
  const result = await pool.query(`SELECT count(*) FROM platform_audit_log WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return Number(result.rows[0].count);
}

describe("auditoría de mutaciones: equipos, checklists e iperc SÍ dejan rastro", () => {
  it("crear un equipo genera al menos una fila en platform_audit_log", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/login")
        .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

      const filasAntes = await filasDeAuditoria(creado.tenant.id);

      const res = await agent
        .post("/api/erp/equipos")
        .send({ placa_codigo: "AUD-001", tipo: "Camión" });
      expect(res.status).toBe(201);

      expect(await filasDeAuditoria(creado.tenant.id)).toBeGreaterThan(filasAntes);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("crear un checklist genera al menos una fila en platform_audit_log", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/login")
        .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

      const equipo = await agent
        .post("/api/erp/equipos")
        .send({ placa_codigo: "AUD-002", tipo: "Camión" });
      const plantilla = await agent
        .post("/api/erp/checklists/plantillas")
        .send({ nombre: "Plantilla auditoría", items: [{ descripcion: "Frenos" }] });

      const filasAntes = await filasDeAuditoria(creado.tenant.id);

      const res = await agent.post("/api/erp/checklists").send({
        equipo_id: equipo.body.id,
        plantilla_id: plantilla.body.id,
        items: [{ descripcion: "Frenos", estado: "bien" }],
      });
      expect(res.status).toBe(201);

      expect(await filasDeAuditoria(creado.tenant.id)).toBeGreaterThan(filasAntes);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("crear un IPERC genera al menos una fila en platform_audit_log", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/login")
        .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

      const filasAntes = await filasDeAuditoria(creado.tenant.id);

      const res = await agent.post("/api/erp/iperc").send({
        area_frente: "Frente auditoría",
        items: [
          {
            etapa_actividad: "Traslado",
            peligro: "Terreno irregular",
            riesgo: "Caída",
            probabilidad: 2,
            severidad: 2,
            medidas_control: "EPP",
          },
        ],
      });
      expect(res.status).toBe(201);

      expect(await filasDeAuditoria(creado.tenant.id)).toBeGreaterThan(filasAntes);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });
});

describe("auditoría de mutaciones: huecos conocidos, reportados sin forzar el comportamiento", () => {
  it.todo(
    "repuestos: POST/PUT/DELETE no llaman registrarAuditoria hoy (verificado leyendo repuestos.controller.ts) -- pendiente decidir si se agrega"
  );
  it.todo(
    "combustible: PUT /:id/nivel no llama registrarAuditoria hoy (verificado leyendo combustible.controller.ts) -- pendiente decidir si se agrega"
  );
  it.todo(
    "documentos: POST/PUT/DELETE/bulk no llaman registrarAuditoria hoy (verificado leyendo documentos.controller.ts) -- pendiente decidir si se agrega"
  );

  // Prueba negativa de control: confirma que el hueco es real HOY, no una
  // suposición -- si algún día alguien agrega auditoría a repuestos, este
  // test empieza a fallar y avisa que hay que borrar el it.todo() de
  // arriba y sumarlo a la descripción "SÍ dejan rastro".
  it("repuestos: control -- crear uno NO deja fila en platform_audit_log (hueco conocido, no deseado)", async () => {
    const password = "ClaveDePrueba123";
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = request.agent(app);
      await agent
        .post("/api/auth/login")
        .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

      const filasAntes = await filasDeAuditoria(creado.tenant.id);
      const res = await agent.post("/api/erp/repuestos").send({
        codigo: "AUD-REP-001",
        nombre: "Filtro de prueba",
        categoria: "General",
        stock: 1,
        stock_minimo: 1,
        stock_maximo: 10,
        precio: 10,
      });
      expect(res.status).toBe(201);

      expect(await filasDeAuditoria(creado.tenant.id)).toBe(filasAntes);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });
});
