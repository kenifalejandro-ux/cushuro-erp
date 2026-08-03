-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: auditoría de acciones del panel de plataforma
--
-- Deja rastro de qué se hizo desde /api/platform/* (crear/desactivar
-- tenants y usuarios, cambiar módulos, asignar dominio) — hoy esas
-- acciones solo quedaban en logs genéricos. Sin RLS (igual criterio que
-- tenant_modulos/usuario_modulos): por diseño cruza tenants, y el panel
-- de plataforma nunca corre dentro de una transacción con app.tenant_id
-- seteado.
--
-- Limitación consciente: todo el panel comparte un solo secreto
-- (PLATFORM_ADMIN_TOKEN) — no hay cuentas individuales de administrador
-- de plataforma, así que esta tabla registra QUÉ se hizo y DESDE QUÉ IP,
-- no QUIÉN de un equipo lo hizo. Eso requeriría cuentas de plataforma
-- individuales, fuera de alcance por ahora.
--
-- EJECUTAR (después de 0001, depende de tenants/usuarios):
--   psql -d mincoreerp -f migrations/0012_platform_audit_log.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ON DELETE SET NULL a propósito (no CASCADE): un registro de auditoría
-- debe sobrevivir aunque el tenant/usuario que menciona se borre después
-- — la fila de negocio hoy nunca se borra de verdad (desactivar en vez de
-- eliminar, ver cambiarEstadoUsuarioService), pero la auditoría no debería
-- depender de esa decisión para seguir siendo consistente.
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  accion      TEXT NOT NULL,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE SET NULL,
  usuario_id  UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  detalle     JSONB,
  ip          TEXT,
  request_id  TEXT,
  creado_en   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_tenant ON platform_audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_creado ON platform_audit_log(creado_en DESC);
