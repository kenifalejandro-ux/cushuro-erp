-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: control de módulos por tenant y por usuario (panel de plataforma)
--
-- El dueño del ERP necesita decidir, desde una superficie separada de
-- cualquier tenant (protegida por PLATFORM_ADMIN_TOKEN, no por el JWT de un
-- tenant — ver platformAdmin.middleware.ts), qué módulos tiene contratados
-- cada empresa cliente y qué módulos ve cada usuario individual dentro de
-- ella. Deliberadamente SIN RLS en las dos tablas nuevas (a diferencia de
-- las tablas de negocio): el panel de plataforma necesita leer/escribir
-- estas filas para cualquier tenant, y nunca corre dentro de una
-- transacción con app.tenant_id seteado (no pasa por withTenant()) — mismo
-- criterio que excluye a refresh_tokens/schema_migrations en
-- 0001_tenants_usuarios.sql.
--
-- EJECUTAR (después de 0001, depende de tenants/usuarios):
--   psql -d mincoreerp -f migrations/0008_platform_modulos.sql
-- ═══════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE modulo_erp AS ENUM (
    'repuestos', 'combustible', 'documentos', 'dashboard',
    'equipos', 'checklists', 'iperc'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Módulos habilitados por tenant ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_modulos (
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  modulo     modulo_erp NOT NULL,
  habilitado BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, modulo)
);

-- ── Módulos visibles por usuario (dentro de lo que su tenant tenga
--    habilitado) — la presencia de la fila significa "puede verlo" ───────
CREATE TABLE IF NOT EXISTS usuario_modulos (
  usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo     modulo_erp NOT NULL,
  PRIMARY KEY (usuario_id, modulo)
);

-- ── Seed de compatibilidad: sin esto, en el primer login después de este
--    cambio modulosPermitidos calcularía vacío para los usuarios ya
--    existentes (Cushuro) y el Sidebar quedaría en blanco. ────────────────
INSERT INTO tenant_modulos (tenant_id, modulo, habilitado)
SELECT t.id, m.modulo, true
FROM tenants t
CROSS JOIN unnest(enum_range(NULL::modulo_erp)) AS m(modulo)
ON CONFLICT (tenant_id, modulo) DO NOTHING;

INSERT INTO usuario_modulos (usuario_id, modulo)
SELECT u.id, m.modulo
FROM usuarios u
CROSS JOIN unnest(enum_range(NULL::modulo_erp)) AS m(modulo)
ON CONFLICT (usuario_id, modulo) DO NOTHING;
