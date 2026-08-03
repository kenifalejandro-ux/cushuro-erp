-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: dominio propio por tenant
--
-- Cada empresa cliente entra con SU propio dominio (ej. "cushuro.pe"), no
-- con uno de la plataforma — "cushuro.mincoreerp.com" queda como respaldo
-- para el que todavía no tenga dominio propio (ver
-- resolveTenantSubdomain.ts). Nullable: la mayoría de tenants no lo tendrá
-- configurado de entrada.
--
-- EJECUTAR (después de 0001, depende de tenants):
--   psql -d mincoreerp -f migrations/0009_tenant_dominio_personalizado.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dominio_personalizado TEXT UNIQUE;
