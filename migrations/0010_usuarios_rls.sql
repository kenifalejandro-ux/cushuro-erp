-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: RLS en usuarios + tenant_id denormalizado en refresh_tokens
--
-- `usuarios` era la única tabla de negocio sin RLS — quedó fuera en 0001 a
-- propósito porque el login todavía no sabía a qué tenant pertenecía un
-- usuario antes de buscarlo por email. Ese prerrequisito ya se resolvió
-- (login/google exigen tenantSlug, resuelto por dominio propio o
-- subdominio antes de tocar la BD — ver resolveTenantSubdomain.ts), así
-- que este es el último paso pendiente del aislamiento multi-tenant.
--
-- `refresh_tokens` gana `tenant_id` (denormalizado desde usuarios.tenant_id
-- al momento de emitir el token) por una razón puntual: refrescarTokenService
-- busca el token por su hash SIN saber todavía a qué tenant pertenece —
-- necesita ese dato para poder abrir después una transacción con
-- withTenant() y consultar `usuarios` bajo RLS. Sin este campo sería
-- imposible resolver ese "huevo y la gallina". refresh_tokens en sí sigue
-- SIN RLS (mismo criterio que 0001: no es una tabla que un usuario consulte
-- directamente, es infraestructura de sesión).
--
-- EJECUTAR (después de 0001, depende de tenants/usuarios/refresh_tokens):
--   psql -d mincoreerp -f migrations/0010_usuarios_rls.sql
--
-- ROLLBACK manual si hiciera falta revertir:
--   DROP POLICY IF EXISTS tenant_isolation ON usuarios;
--   ALTER TABLE usuarios NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE usuarios DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS tenant_id;
--   (revertir también los cambios de código en auth.service.ts/platform.*
--    antes de hacer esto — si no, todas las queries fallarían por falta
--    de app.tenant_id)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── refresh_tokens.tenant_id: agregar, hacer backfill, luego NOT NULL ────
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

UPDATE refresh_tokens rt
SET tenant_id = u.tenant_id
FROM usuarios u
WHERE rt.usuario_id = u.id AND rt.tenant_id IS NULL;

DO $$ BEGIN
  ALTER TABLE refresh_tokens ALTER COLUMN tenant_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL; -- ya era NOT NULL en una base creada después de este cambio
END $$;

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_tenant ON refresh_tokens(tenant_id);

-- ── RLS en usuarios ──────────────────────────────────────────────────────
-- FORCE es imprescindible (igual que en 0005/0006/0007): sin él, el owner
-- de las tablas (el mismo rol con el que se conecta la app) queda exento
-- de RLS por default, y la política nunca aplicaría a las queries reales.
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON usuarios
    USING (tenant_id = current_setting('app.tenant_id')::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
