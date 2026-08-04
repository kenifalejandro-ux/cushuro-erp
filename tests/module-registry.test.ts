/** tests/module-registry.test.ts
 *
 * Parte del Contrato de Módulo (docs/adr/0002-contrato-de-modulo.md):
 * src/modules/registry.ts es la fuente de verdad en código de qué módulos
 * existen, pero el enum `modulo_erp` de Postgres (migrations/0008 en
 * adelante) sigue siendo una lista aparte a propósito — da un CHECK real
 * a nivel de base de datos que TypeScript no puede dar. Este test es el
 * único lugar que garantiza que ambas listas coincidan; si alguien agrega
 * un módulo al registry sin la migración que suma el valor al enum (o al
 * revés), este test falla en vez de fallar en silencio la primera vez que
 * alguien intente activar ese módulo desde el panel de plataforma.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool, closeDatabase } from "../src/server/config/database";
import { MODULOS_ERP } from "../src/modules/registry";

describe("registry de módulos vs enum modulo_erp de Postgres", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("MODULOS_ERP (código) y el enum modulo_erp (BD) tienen exactamente el mismo set", async () => {
    const result = await pool.query<{ modulo: string }>(
      `SELECT unnest(enum_range(NULL::modulo_erp))::text AS modulo`
    );
    const modulosEnBd = result.rows.map((r) => r.modulo).sort();
    const modulosEnCodigo = [...MODULOS_ERP].sort();

    expect(modulosEnCodigo).toEqual(modulosEnBd);
  });

  it("la auditoría de un módulo de negocio realmente ESCRIBE la fila (no se pierde en silencio)", async () => {
    // registrarAuditoria() nunca tira: si el INSERT falla, loguea un warning
    // y sigue. Eso hace que un error de esquema en la fila de auditoría sea
    // invisible salvo que un test verifique la fila del otro lado — que es
    // exactamente lo que faltaba: durante un tiempo TODA la auditoría de
    // módulos de negocio violaba la FK de actor_id y se descartaba, sin que
    // nada fallara. Ver el comentario en shared/utils/moduleAudit.ts.
    const { app, crearTenantDePrueba, borrarTenantDePrueba, idUnico } = await import("./helpers");
    const request = (await import("supertest")).default;

    const { tenant, usuario } = await crearTenantDePrueba("ClaveDePrueba123");
    try {
      const agente = request.agent(app);
      await agente
        .post("/api/auth/login")
        .send({ tenantSlug: tenant.slug, email: usuario.email, password: "ClaveDePrueba123" });

      const creado = await agente
        .post("/api/erp/equipos")
        .send({ placa_codigo: idUnico("EQ"), tipo: "Camioneta" });
      expect(creado.status).toBe(201);

      const auditoria = await pool.query(
        `SELECT actor_type, actor_id, usuario_id, actor_label, detalle
         FROM platform_audit_log
         WHERE accion = 'equipos.crear' AND tenant_id = $1
         ORDER BY creado_en DESC LIMIT 1`,
        [tenant.id]
      );

      expect(auditoria.rows).toHaveLength(1);
      expect(auditoria.rows[0].actor_type).toBe("tenant_usuario");
      // El autor va en usuario_id, NO en actor_id (que tiene FK contra
      // platform_admins y haría fallar el insert).
      expect(auditoria.rows[0].actor_id).toBeNull();
      expect(auditoria.rows[0].usuario_id).toBe(usuario.id);
      expect(auditoria.rows[0].actor_label).toBe(usuario.email);
      expect(auditoria.rows[0].detalle.equipoId).toBe(creado.body.id);
    } finally {
      await borrarTenantDePrueba(tenant.id);
    }
  });

  it("cada módulo del registry declara sus tablas de backup como subconjunto válido de raices", async () => {
    const { MODULOS } = await import("../src/modules/registry");
    for (const modulo of MODULOS) {
      const nombresTablas = new Set(modulo.tablas.map((t) => t.nombre));
      for (const raiz of modulo.raices) {
        expect(
          nombresTablas.has(raiz),
          `El módulo "${modulo.id}" declara "${raiz}" en raices pero no está en tablas`
        ).toBe(true);
      }
    }
  });
});
