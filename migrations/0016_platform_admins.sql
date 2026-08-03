-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: cuentas individuales de Platform Admin
--
-- platform_admins: primer paso para que el panel de plataforma deje de
-- depender de un único secreto compartido para saber "quién" hizo cada
-- acción. PLATFORM_ADMIN_TOKEN sigue existiendo y sigue funcionando tal
-- cual — pasa a ser el modo de emergencia (actor_type =
-- 'emergency_shared_secret'), nunca deja de aceptarse (ver
-- platformAdmin.middleware.ts). No hay bootstrap automático de un primer
-- super_admin a propósito: se crea a mano, autenticado con el secreto
-- compartido (POST /api/platform/admins), la primera vez que se despliega
-- esto — ver la guía en el PR.
--
-- actor_type/actor_id/actor_label en platform_audit_log: quién hizo la
-- acción, no a qué se le hizo (eso lo siguen resolviendo tenant_id/
-- usuario_id + el JOIN en tiempo de lectura de listarAuditoriaService).
-- actor_label es una FOTO tomada al momento del evento, no se resuelve por
-- JOIN como tenantNombre/usuarioEmail — un admin que cambia de nombre o se
-- desactiva después no debe reescribir el historial de "quién hizo qué".
-- actor_id queda de FK solo para poder cruzar hacia adelante (ej. "todo lo
-- que hizo este admin"), con ON DELETE SET NULL por el mismo criterio que
-- tenant_id/usuario_id en 0012: la fila de auditoría sobrevive aunque el
-- admin se borre de verdad alguna vez (hoy nunca pasa: cambiarEstado
-- PlatformAdminService es soft-delete, igual que tenants/usuarios).
--
-- El DEFAULT 'emergency_shared_secret' en actor_type es un backfill
-- razonable pero imperfecto para filas viejas: antes de esta migración no
-- existía otro modo, así que toda acción EXITOSA sí se hizo con el secreto
-- compartido — pero algunas filas viejas de intentos RECHAZADOS (token
-- inválido, ver platform.session.rechazada) heredan el mismo default
-- aunque en rigor ningún actor llegó a autenticarse. Se acepta esa
-- imprecisión histórica en vez de complicar la migración por datos que ya
-- pasaron; de acá en adelante el código siempre manda un actor_type
-- explícito (incluido 'unauthenticated' para esos casos).
--
-- EJECUTAR (después de 0015):
--   psql -d mincoreerp -f migrations/0016_platform_admins.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS platform_admins (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  nombre         TEXT NOT NULL,
  rol            TEXT NOT NULL DEFAULT 'admin' CHECK (rol IN ('super_admin', 'admin')),
  activo         BOOLEAN NOT NULL DEFAULT true,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE platform_audit_log ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'emergency_shared_secret';
ALTER TABLE platform_audit_log ADD COLUMN IF NOT EXISTS actor_id UUID REFERENCES platform_admins(id) ON DELETE SET NULL;
ALTER TABLE platform_audit_log ADD COLUMN IF NOT EXISTS actor_label TEXT;

DO $$ BEGIN
  ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_actor_type_check
    CHECK (actor_type IN ('platform_admin', 'emergency_shared_secret', 'unauthenticated', 'system'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE platform_audit_log ADD CONSTRAINT platform_audit_log_actor_id_consistente
    CHECK (actor_type != 'platform_admin' OR actor_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_platform_audit_log_actor ON platform_audit_log(actor_id) WHERE actor_id IS NOT NULL;
