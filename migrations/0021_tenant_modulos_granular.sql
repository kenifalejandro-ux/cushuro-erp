-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: módulos por tenant más granulares (estado + rollout + versión)
--
-- Reemplaza el booleano habilitado de tenant_modulos (0008) por un estado
-- de tres valores:
--   habilitado:    igual que habilitado = true antes.
--   deshabilitado: igual que habilitado = false antes.
--   rollout:       nuevo — el módulo se activa solo para una porción
--                   (rollout_porcentaje, 0-100) de los usuarios de ESE
--                   tenant, no de todos los tenants. El bucketing es
--                   determinístico por (tenant, módulo, usuario) — ver
--                   obtenerModulosPermitidos en auth.service.ts — así el
--                   mismo usuario no ve el módulo aparecer y desaparecer
--                   entre logins mientras el porcentaje no cambie.
--
-- version es puramente informativo por ahora (string libre, ej. "v1",
-- "v2") — ningún consumidor de modulosPermitidos lo lee todavía; es
-- metadata para que el panel de plataforma pueda anotar qué versión de un
-- módulo tiene cada tenant mientras se decide si en algún momento amerita
-- que el frontend/backend del ERP branchee comportamiento por versión.
--
-- La intersección tenant_modulos ∩ usuario_modulos sigue intacta: seguir
-- viendo un módulo requiere estar asignado en usuario_modulos Y que el
-- tenant lo tenga en estado habilitado (o caer del lado correcto del
-- rollout) — usuario_modulos no cambia en esta migración.
--
-- EJECUTAR (después de 0020):
--   psql -d mincoreerp -f migrations/0021_tenant_modulos_granular.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tenant_modulos ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'deshabilitado';

DO $$ BEGIN
  ALTER TABLE tenant_modulos ADD CONSTRAINT tenant_modulos_estado_check
    CHECK (estado IN ('habilitado', 'deshabilitado', 'rollout'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE tenant_modulos ADD COLUMN IF NOT EXISTS rollout_porcentaje INT;

DO $$ BEGIN
  ALTER TABLE tenant_modulos ADD CONSTRAINT tenant_modulos_rollout_porcentaje_check
    CHECK (rollout_porcentaje IS NULL OR (rollout_porcentaje BETWEEN 0 AND 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE tenant_modulos ADD COLUMN IF NOT EXISTS version TEXT;

-- Backfill desde el booleano existente, antes de poder borrarlo.
UPDATE tenant_modulos SET estado = CASE WHEN habilitado THEN 'habilitado' ELSE 'deshabilitado' END;

ALTER TABLE tenant_modulos DROP COLUMN IF EXISTS habilitado;
