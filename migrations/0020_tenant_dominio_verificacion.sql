-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: verificación de propiedad de dominio personalizado (TXT record)
--
-- Hasta ahora dominio_personalizado (0009) se guardaba y se usaba
-- directo para resolver a qué tenant pertenece un login (ver
-- resolveTenantSubdomain.ts) sin ninguna prueba de que quien lo configuró
-- desde el panel de plataforma realmente controlara ese dominio — un
-- Platform Admin (o el secreto de emergencia) podía apuntar el dominio de
-- un tercero al tenant equivocado por error de tipeo, sin que nada lo
-- detectara.
--
-- A partir de acá, un dominio nuevo entra en 'pendiente_verificacion' con
-- un token propio; resolveTenantSubdomain.ts SOLO resuelve dominios en
-- 'activo' — ver platformDomain.service.ts.
--
-- Estados:
--   pendiente_verificacion: dominio asignado, token generado, todavía sin
--                            confirmar (o esperando un reintento).
--   activo:                 TXT record confirmado — el único estado desde
--                            el que resolveTenantSubdomain.ts resuelve.
--   fallido:                se intentó verificar y el TXT record no
--                            coincidía (o no existía todavía) — se puede
--                            reintentar sin perder el token.
--   desactivado:             sin dominio propio asignado (el default).
--
-- GRANDFATHERING: los dominios que ya estaban configurados antes de esta
-- migración se dan por verificados (dominio_estado = 'activo') — exigirles
-- retroactivamente un TXT record les cortaría el login de un día para el
-- otro sin aviso. La verificación real empieza a aplicar recién para
-- dominios nuevos o reasignados desde acá en adelante.
--
-- EJECUTAR (después de 0019):
--   psql -d mincoreerp -f migrations/0020_tenant_dominio_verificacion.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dominio_estado TEXT NOT NULL DEFAULT 'desactivado';

DO $$ BEGIN
  ALTER TABLE tenants ADD CONSTRAINT tenants_dominio_estado_check
    CHECK (dominio_estado IN ('pendiente_verificacion', 'activo', 'fallido', 'desactivado'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dominio_token_verificacion TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dominio_verificado_en TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dominio_verificacion_intentos INT NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dominio_ultimo_intento_en TIMESTAMPTZ;

UPDATE tenants SET dominio_estado = 'activo', dominio_verificado_en = now()
WHERE dominio_personalizado IS NOT NULL AND dominio_estado != 'activo';

COMMENT ON COLUMN tenants.dominio_estado IS
  'pendiente_verificacion | activo | fallido | desactivado. Solo activo resuelve login por dominio propio — ver resolveTenantSubdomain.ts.';
