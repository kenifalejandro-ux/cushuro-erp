/** tests/idempotencia-offline-documentos.test.ts
 *
 * Mismo motivo que tests/idempotencia-offline.test.ts (checklists) y
 * idempotencia-offline-iperc.test.ts, aplicado a Documentos: un POST que se
 * commiteó pero cuya respuesta se perdió no debe convertirse en un
 * duplicado al reintentar. Cubre las dos escrituras que participan de
 * offline -- `POST /` (crear el registro) y `POST /:id/versiones` (subir el
 * archivo adjunto, Caso B de ADR-0002 §8) -- editar y el bulk NO
 * participan.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app, crearTenantDePrueba, borrarTenantDePrueba } from "./helpers";
import { closeDatabase, withTenant } from "../src/server/config/database";
import { limpiarIdempotencyKeysVencidas } from "../src/server/services/idempotencyKeysRetention.worker";

describe("idempotencia de escrituras offline (Documentos)", () => {
  let tenantId: string;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  async function contarDocumentosDelTenant(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(`SELECT COUNT(*)::int AS total FROM documentos WHERE tenant_id = $1`, [tenantId])
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces crea UN solo documento y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      nombre_documento: "SOAT camión 12",
      responsable: "Carlos",
      fecha_vencimiento: "2027-01-01",
    };

    const antes = await contarDocumentosDelTenant();

    const primera = await agente.post("/api/erp/documentos").send(cuerpo);
    expect(primera.status).toBe(201);

    // El reintento del dispositivo: byte por byte el mismo envío.
    const reintento = await agente.post("/api/erp/documentos").send(cuerpo);
    // 200 y no 201: esta llamada no creó nada, pero sigue siendo 2xx a
    // propósito -- para la cola del dispositivo es un éxito.
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    expect(await contarDocumentosDelTenant()).toBe(antes + 1);
  });

  it("dos envíos SIMULTÁNEOS con el mismo cliente_uuid tampoco duplican", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      nombre_documento: "Póliza equipo 7",
      responsable: "María",
      fecha_vencimiento: "2027-02-01",
    };

    const antes = await contarDocumentosDelTenant();

    const [a, b] = await Promise.all([
      agente.post("/api/erp/documentos").send(cuerpo),
      agente.post("/api/erp/documentos").send(cuerpo),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(await contarDocumentosDelTenant()).toBe(antes + 1);
  });

  it("cliente_uuid distintos SÍ crean documentos distintos", async () => {
    const antes = await contarDocumentosDelTenant();

    const a = await agente.post("/api/erp/documentos").send({
      cliente_uuid: crypto.randomUUID(),
      nombre_documento: "SOAT camión 15",
      responsable: "Carlos",
      fecha_vencimiento: "2027-03-01",
    });
    const b = await agente.post("/api/erp/documentos").send({
      cliente_uuid: crypto.randomUUID(),
      nombre_documento: "SOAT camión 16",
      responsable: "Carlos",
      fecha_vencimiento: "2027-03-01",
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await contarDocumentosDelTenant()).toBe(antes + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST crea un documento", async () => {
    const antes = await contarDocumentosDelTenant();
    const cuerpo = {
      nombre_documento: "Documento sin idempotencia",
      responsable: "Carlos",
      fecha_vencimiento: "2027-04-01",
    };

    expect((await agente.post("/api/erp/documentos").send(cuerpo)).status).toBe(201);
    expect((await agente.post("/api/erp/documentos").send(cuerpo)).status).toBe(201);

    expect(await contarDocumentosDelTenant()).toBe(antes + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente.post("/api/erp/documentos").send({
      cliente_uuid: "no-soy-un-uuid",
      nombre_documento: "SOAT camión 20",
      responsable: "Carlos",
      fecha_vencimiento: "2027-05-01",
    });
    expect(res.status).toBe(400);
  });

  it("el evento de tiempo real NO se repite en el reintento", async () => {
    const clienteUuid = crypto.randomUUID();
    const cuerpo = {
      cliente_uuid: clienteUuid,
      nombre_documento: "SOAT camión 21",
      responsable: "Carlos",
      fecha_vencimiento: "2027-06-01",
    };

    const primera = await agente.post("/api/erp/documentos").send(cuerpo);
    await agente.post("/api/erp/documentos").send(cuerpo);

    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'documentos.creado' AND tenant_id = $1 AND payload->>'documentoId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });

  it("una clave vencida la borra el worker de retención compartido, y las vigentes quedan", async () => {
    const vigente = crypto.randomUUID();
    await agente.post("/api/erp/documentos").send({
      cliente_uuid: vigente,
      nombre_documento: "SOAT camión 22",
      responsable: "Carlos",
      fecha_vencimiento: "2027-07-01",
    });

    const vencido = crypto.randomUUID();
    await agente.post("/api/erp/documentos").send({
      cliente_uuid: vencido,
      nombre_documento: "SOAT camión 23",
      responsable: "Carlos",
      fecha_vencimiento: "2027-07-01",
    });
    await withTenant(tenantId, (client) =>
      client.query(
        `UPDATE idempotency_keys SET expires_at = now() - interval '1 hour'
         WHERE tenant_id = $1 AND modulo = 'documentos' AND cliente_uuid = $2`,
        [tenantId, vencido]
      )
    );

    await limpiarIdempotencyKeysVencidas();

    const restantes = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT cliente_uuid FROM idempotency_keys WHERE tenant_id = $1 AND modulo = 'documentos'`,
        [tenantId]
      )
    );
    const uuids = restantes.rows.map((f) => f.cliente_uuid);
    expect(uuids).toContain(vigente);
    expect(uuids).not.toContain(vencido);
  });
});

const PDF_DE_PRUEBA = Buffer.from("%PDF-1.4\n%mincoreerp-test\n");

describe("idempotencia de escrituras offline (Documentos: archivo adjunto)", () => {
  let tenantId: string;
  let documentoId: number;
  const password = "ClaveDePrueba123";
  const agente = request.agent(app);

  beforeAll(async () => {
    const creado = await crearTenantDePrueba(password);
    tenantId = creado.tenant.id;
    await agente
      .post("/api/auth/login")
      .send({ tenantSlug: creado.tenant.slug, email: creado.usuario.email, password });

    const doc = await agente.post("/api/erp/documentos").send({
      nombre_documento: "Documento para idempotencia de archivo",
      responsable: "Carlos",
      fecha_vencimiento: "2027-01-01",
    });
    documentoId = doc.body.id;
  });

  afterAll(async () => {
    await borrarTenantDePrueba(tenantId);
  });

  async function contarVersiones(): Promise<number> {
    const res = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM documentos_versiones
         WHERE tenant_id = $1 AND documento_id = $2`,
        [tenantId, documentoId]
      )
    );
    return res.rows[0].total;
  }

  it("el mismo cliente_uuid mandado dos veces sube UNA sola versión y devuelve el mismo id", async () => {
    const clienteUuid = crypto.randomUUID();
    const antes = await contarVersiones();

    const primera = await agente
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .field("cliente_uuid", clienteUuid)
      .attach("archivo", PDF_DE_PRUEBA, { filename: "x.pdf", contentType: "application/pdf" });
    expect(primera.status).toBe(201);

    // El reintento del dispositivo: mismo cliente_uuid, mismo archivo.
    const reintento = await agente
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .field("cliente_uuid", clienteUuid)
      .attach("archivo", PDF_DE_PRUEBA, { filename: "x.pdf", contentType: "application/pdf" });
    // 200 y no 201: esta llamada no creó nada, pero sigue siendo 2xx a
    // propósito -- para la cola del dispositivo es un éxito.
    expect(reintento.status).toBe(200);
    expect(reintento.body.id).toBe(primera.body.id);

    expect(await contarVersiones()).toBe(antes + 1);
  });

  it("cliente_uuid distintos SÍ crean versiones distintas", async () => {
    const antes = await contarVersiones();

    const a = await agente
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .field("cliente_uuid", crypto.randomUUID())
      .attach("archivo", PDF_DE_PRUEBA, { filename: "a.pdf", contentType: "application/pdf" });
    const b = await agente
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .field("cliente_uuid", crypto.randomUUID())
      .attach("archivo", PDF_DE_PRUEBA, { filename: "b.pdf", contentType: "application/pdf" });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
    expect(await contarVersiones()).toBe(antes + 2);
  });

  it("sin cliente_uuid se comporta como siempre: cada POST sube una versión", async () => {
    const antes = await contarVersiones();

    expect(
      (
        await agente
          .post(`/api/erp/documentos/${documentoId}/versiones`)
          .attach("archivo", PDF_DE_PRUEBA, { filename: "c.pdf", contentType: "application/pdf" })
      ).status
    ).toBe(201);
    expect(
      (
        await agente
          .post(`/api/erp/documentos/${documentoId}/versiones`)
          .attach("archivo", PDF_DE_PRUEBA, { filename: "d.pdf", contentType: "application/pdf" })
      ).status
    ).toBe(201);

    expect(await contarVersiones()).toBe(antes + 2);
  });

  it("un cliente_uuid que no es UUID se rechaza con 400, no se guarda como clave basura", async () => {
    const res = await agente
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .field("cliente_uuid", "no-soy-un-uuid")
      .attach("archivo", PDF_DE_PRUEBA, { filename: "e.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
  });

  it("el evento de tiempo real NO se repite en el reintento", async () => {
    const clienteUuid = crypto.randomUUID();

    const primera = await agente
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .field("cliente_uuid", clienteUuid)
      .attach("archivo", PDF_DE_PRUEBA, { filename: "f.pdf", contentType: "application/pdf" });
    await agente
      .post(`/api/erp/documentos/${documentoId}/versiones`)
      .field("cliente_uuid", clienteUuid)
      .attach("archivo", PDF_DE_PRUEBA, { filename: "f.pdf", contentType: "application/pdf" });

    const eventos = await withTenant(tenantId, (client) =>
      client.query(
        `SELECT COUNT(*)::int AS total FROM eventos_tiempo_real
         WHERE tipo = 'documentos.version_subida' AND tenant_id = $1 AND payload->>'versionId' = $2`,
        [tenantId, String(primera.body.id)]
      )
    );
    expect(eventos.rows[0].total).toBe(1);
  });
});

// Un solo cierre de pool para todo el archivo -- closeDatabase() dentro de
// un afterAll de un describe individual rompería el segundo describe (ver
// el mismo comentario en tests/combustible.test.ts).
afterAll(async () => {
  await closeDatabase();
});
