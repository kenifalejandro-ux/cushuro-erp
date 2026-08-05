import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } from "./helpers";
import { pool, closeDatabase, withTenant } from "../src/server/config/database";

describe("paginación de repuestos", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent.post("/api/auth/login").send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const filas = Array.from({ length: 55 }, (_, i) => ({
      codigo: `PAG-${String(i + 1).padStart(3, "0")}`,
      nombre: `Repuesto paginado ${i + 1}`,
      categoria: "Motor",
      stock: i,
      stock_minimo: 5,
      stock_maximo: 100,
      precio: 10,
    }));
    const bulk = await agent.post("/api/erp/repuestos/bulk").send(filas);
    expect(bulk.status).toBe(201);
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("page=1 trae 50 filas por default y el total correcto", async () => {
    const res = await agent.get("/api/erp/repuestos?page=1");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(50);
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 50, total: 55, totalPages: 2 });
  });

  it("page=2 trae las 5 filas restantes", async () => {
    const res = await agent.get("/api/erp/repuestos?page=2");
    expect(res.body.data).toHaveLength(5);
    expect(res.body.pagination.page).toBe(2);
  });

  it("pageSize nunca supera el tope de 200, aunque se pida más", async () => {
    const res = await agent.get("/api/erp/repuestos?pageSize=99999");
    expect(res.body.pagination.pageSize).toBe(200);
    expect(res.body.data).toHaveLength(55);
  });
});

/** checklists e ipercs (llenados) son las dos únicas tablas particionadas
 *  (migrations/0037) y usan paginación por CURSOR en vez de OFFSET (ver
 *  src/server/shared/utils/pagination.ts) — sin número de página ni total
 *  exacto, solo id + hasMore/nextCursor. */
describe("paginación por cursor de checklists", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);
  let idsDesc: number[] = []; // del más nuevo al más viejo, mismo orden que devuelve la API

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent.post("/api/auth/login").send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const ids = await withTenant(tenantId, async (client) => {
      const equipo = await client.query(
        `INSERT INTO equipos (tenant_id, placa_codigo, tipo) VALUES ($1, $2, 'Camioneta') RETURNING id`,
        [tenantId, idUnico("EQ")]
      );
      const plantilla = await client.query(
        `INSERT INTO checklist_plantillas (tenant_id, nombre) VALUES ($1, 'Plantilla paginación')  RETURNING id`,
        [tenantId]
      );
      const resultado: number[] = [];
      for (let i = 0; i < 55; i++) {
        const fila = await client.query(
          `INSERT INTO checklists (tenant_id, equipo_id, plantilla_id, usuario_id) VALUES ($1, $2, $3, $4) RETURNING id`,
          [tenantId, equipo.rows[0].id, plantilla.rows[0].id, creado.usuario.id]
        );
        resultado.push(fila.rows[0].id);
      }
      return resultado;
    });
    idsDesc = [...ids].reverse();
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  it("sin cursor trae los 50 más nuevos (mayor id primero) y avisa que hay más", async () => {
    const res = await agent.get("/api/erp/checklists?pageSize=50");
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: any) => c.id)).toEqual(idsDesc.slice(0, 50));
    expect(res.body.pagination).toMatchObject({ pageSize: 50, hasMore: true, nextCursor: idsDesc[49] });
    // A diferencia de la paginación por offset, no hay total ni totalPages.
    expect(res.body.pagination.total).toBeUndefined();
  });

  it("con el cursor de la página anterior trae el resto, sin más páginas", async () => {
    const primera = await agent.get("/api/erp/checklists?pageSize=50");
    const segunda = await agent.get(`/api/erp/checklists?pageSize=50&cursor=${primera.body.pagination.nextCursor}`);

    expect(segunda.body.data.map((c: any) => c.id)).toEqual(idsDesc.slice(50, 55));
    expect(segunda.body.pagination).toMatchObject({ pageSize: 50, hasMore: false, nextCursor: null });
  });

  it("pageSize por encima del tope de 200 se recorta, y alcanza para traer todo en una sola página", async () => {
    const res = await agent.get("/api/erp/checklists?pageSize=99999");
    expect(res.body.pagination.pageSize).toBe(200);
    expect(res.body.data).toHaveLength(55);
    expect(res.body.pagination.hasMore).toBe(false);
  });
});

describe("paginación por cursor de IPERC", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agent = request.agent(app);
  let idsDesc: number[] = [];

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agent.post("/api/auth/login").send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const ids = await withTenant(tenantId, async (client) => {
      const resultado: number[] = [];
      for (let i = 0; i < 5; i++) {
        const fila = await client.query(
          `INSERT INTO ipercs (tenant_id, area_frente, usuario_id) VALUES ($1, $2, $3) RETURNING id`,
          [tenantId, `Frente ${i}`, creado.usuario.id]
        );
        resultado.push(fila.rows[0].id);
      }
      return resultado;
    });
    idsDesc = [...ids].reverse();
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
    await closeDatabase();
  });

  it("navega de a 2 con Anterior/Siguiente hasta agotar los 5 registros", async () => {
    const p1 = await agent.get("/api/erp/iperc?pageSize=2");
    expect(p1.body.data.map((i: any) => i.id)).toEqual(idsDesc.slice(0, 2));
    expect(p1.body.pagination).toMatchObject({ hasMore: true, nextCursor: idsDesc[1] });

    const p2 = await agent.get(`/api/erp/iperc?pageSize=2&cursor=${p1.body.pagination.nextCursor}`);
    expect(p2.body.data.map((i: any) => i.id)).toEqual(idsDesc.slice(2, 4));
    expect(p2.body.pagination).toMatchObject({ hasMore: true, nextCursor: idsDesc[3] });

    const p3 = await agent.get(`/api/erp/iperc?pageSize=2&cursor=${p2.body.pagination.nextCursor}`);
    expect(p3.body.data.map((i: any) => i.id)).toEqual(idsDesc.slice(4, 5));
    expect(p3.body.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });
});
