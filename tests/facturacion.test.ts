/** tests/facturacion.test.ts
 *
 * Comprobante de pago que el tenant descarga desde su propio panel
 * (migración 0041 + src/server/services/facturacion.service.ts). No hay
 * todavía ningún flujo que genere `cobros`/`facturas` reales (falta el
 * adapter de Culqi y el webhook) -- este test inserta las filas a mano,
 * simulando el estado que dejaría un cobro exitoso.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { pool, closeDatabase } from "../src/server/config/database";

afterAll(async () => {
  await closeDatabase();
});

async function loginComoTenant(slug: string, email: string, password: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ tenantSlug: slug, email, password });
  expect(res.status).toBe(200);
  return agent;
}

async function crearCobroYFactura(tenantId: string, monto = "200.00") {
  const cobro = await pool.query(
    `INSERT INTO cobros (tenant_id, tipo, descripcion, moneda, monto, estado)
     VALUES ($1, 'suscripcion', NULL, 'PEN', $2, 'exitoso')
     RETURNING id`,
    [tenantId, monto]
  );
  const cobroId = cobro.rows[0].id;
  const factura = await pool.query(
    `INSERT INTO facturas (tenant_id, cobro_id) VALUES ($1, $2) RETURNING id`,
    [tenantId, cobroId]
  );
  return { cobroId, facturaId: factura.rows[0].id as string };
}

describe("GET /api/facturacion/comprobantes", () => {
  const password = "ClaveDePrueba123";

  it("sin sesión: 401", async () => {
    const res = await request(app).get("/api/facturacion/comprobantes");
    expect(res.status).toBe(401);
  });

  it("tenant sin cobros todavía: lista vacía, no 404 ni 500", async () => {
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = await loginComoTenant(creado.tenant.slug, creado.usuario.email, password);
      const res = await agent.get("/api/facturacion/comprobantes");
      expect(res.status).toBe(200);
      expect(res.body.comprobantes).toEqual([]);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("lista el comprobante de un cobro exitoso, sin necesidad de haberlo descargado antes", async () => {
    const creado = await crearTenantDePrueba(password);
    try {
      await crearCobroYFactura(creado.tenant.id, "349.00");
      const agent = await loginComoTenant(creado.tenant.slug, creado.usuario.email, password);

      const res = await agent.get("/api/facturacion/comprobantes");
      expect(res.status).toBe(200);
      expect(res.body.comprobantes).toHaveLength(1);
      expect(res.body.comprobantes[0]).toMatchObject({
        numero: null, // todavía no se descargó, no tiene número asignado
        concepto: "Suscripción de plan",
        monto: "349.00",
        moneda: "PEN",
      });
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("un tenant NUNCA ve el comprobante de otro tenant", async () => {
    const propio = await crearTenantDePrueba(password);
    const ajeno = await crearTenantDePrueba(password);
    try {
      await crearCobroYFactura(ajeno.tenant.id);
      const agent = await loginComoTenant(propio.tenant.slug, propio.usuario.email, password);

      const res = await agent.get("/api/facturacion/comprobantes");
      expect(res.status).toBe(200);
      expect(res.body.comprobantes).toEqual([]);
    } finally {
      await borrarTenantDePrueba(propio.tenant.id);
      await borrarTenantDePrueba(ajeno.tenant.id);
    }
  });
});

describe("GET /api/facturacion/comprobantes/:id/pdf", () => {
  const password = "ClaveDePrueba123";

  it("descarga el PDF y le asigna número la primera vez; la segunda descarga reusa el mismo número", async () => {
    const creado = await crearTenantDePrueba(password);
    try {
      const { facturaId } = await crearCobroYFactura(creado.tenant.id);
      const agent = await loginComoTenant(creado.tenant.slug, creado.usuario.email, password);

      const primera = await agent.get(`/api/facturacion/comprobantes/${facturaId}/pdf`);
      expect(primera.status).toBe(200);
      expect(primera.headers["content-type"]).toBe("application/pdf");
      expect(primera.body.length).toBeGreaterThan(0);

      const fila = await pool.query(
        `SELECT comprobante_numero, comprobante_tipo FROM facturas WHERE id = $1`,
        [facturaId]
      );
      expect(fila.rows[0].comprobante_tipo).toBe("comprobante_pago");
      const numeroAsignado = fila.rows[0].comprobante_numero;
      expect(numeroAsignado).toMatch(/^CP-\d{4}-[0-9A-F]{8}$/);

      const segunda = await agent.get(`/api/facturacion/comprobantes/${facturaId}/pdf`);
      expect(segunda.status).toBe(200);
      const filaDespues = await pool.query(
        `SELECT comprobante_numero FROM facturas WHERE id = $1`,
        [facturaId]
      );
      expect(filaDespues.rows[0].comprobante_numero).toBe(numeroAsignado);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });

  it("un tenant no puede descargar el comprobante de otro tenant: 404", async () => {
    const propio = await crearTenantDePrueba(password);
    const ajeno = await crearTenantDePrueba(password);
    try {
      const { facturaId } = await crearCobroYFactura(ajeno.tenant.id);
      const agent = await loginComoTenant(propio.tenant.slug, propio.usuario.email, password);

      const res = await agent.get(`/api/facturacion/comprobantes/${facturaId}/pdf`);
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(propio.tenant.id);
      await borrarTenantDePrueba(ajeno.tenant.id);
    }
  });

  it("comprobante inexistente: 404", async () => {
    const creado = await crearTenantDePrueba(password);
    try {
      const agent = await loginComoTenant(creado.tenant.slug, creado.usuario.email, password);
      const res = await agent.get(
        `/api/facturacion/comprobantes/00000000-0000-4000-8000-000000000000/pdf`
      );
      expect(res.status).toBe(404);
    } finally {
      await borrarTenantDePrueba(creado.tenant.id);
    }
  });
});
