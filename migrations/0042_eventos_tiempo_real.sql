-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: buffer de eventos para tiempo real (SSE + Redis pub/sub)
--
-- Estas dos tablas NO son el mecanismo de entrega en vivo -- eso lo hace
-- Redis pub/sub (canales `realtime:tenant:<id>` / `realtime:platform`,
-- ver realtimeEvents.service.ts), que fan-out entre instancias sin tocar
-- Postgres. Son solo el buffer de REPOSICIÓN: cuando un cliente SSE se
-- reconecta con `Last-Event-ID` (por una caída de red, un tab en
-- background, un restart de instancia), acá se busca lo que se perdió
-- entre medio. Por eso `eventosTiempoRealRetention.worker.ts` las poda
-- agresivo (default 60 minutos) -- no son un histórico, son un buffer.
--
-- Dos tablas, no una con tenant_id nullable: un evento de plataforma
-- (tenant_id NULL) bajo la policy `tenant_id = current_setting(...)::uuid`
-- de RLS nunca matchea NADA, ni siquiera una sesión de plataforma -- y
-- sin `missing_ok` en current_setting(), leer/escribir esa tabla sin
-- app.tenant_id seteado directamente tira error (ver migración 0005). La
-- alternativa de agregar `OR tenant_id IS NULL` a la policy sí "resuelve"
-- eso, pero abre un agujero real: cualquier sesión de tenant terminaría
-- viendo también los eventos de plataforma. Separar en dos tablas evita
-- las dos trampas sin necesitar ninguna policy no estándar.
--
-- EJECUTAR (después de 0041):
--   psql -d mincoreerp -f migrations/0042_eventos_tiempo_real.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Eventos de tenant (checklists, equipos, iperc, etc.) ────────────────
-- ON DELETE CASCADE a propósito: es un buffer efímero, no registro
-- contable como facturas/cobros -- si el tenant se borra, sus eventos
-- pendientes de reposición no significan nada. Así tests/helpers.ts no
-- necesita un DELETE explícito en borrarTenantDePrueba().
CREATE TABLE IF NOT EXISTS eventos_tiempo_real (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo      TEXT NOT NULL,
  payload   JSONB NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cubre el filtro de RLS (tenant_id) y el replay ("WHERE tenant_id = ...
-- AND id > último_visto ORDER BY id") en el mismo índice.
CREATE INDEX IF NOT EXISTS idx_eventos_tiempo_real_tenant_id
  ON eventos_tiempo_real(tenant_id, id);

-- Mismo criterio que migrations/0005: FORCE es imprescindible, si no el
-- owner de la tabla (el rol con el que se conecta la app) queda exento de
-- RLS y la policy nunca se aplicaría a las queries de la propia app.
ALTER TABLE eventos_tiempo_real ENABLE ROW LEVEL SECURITY;
ALTER TABLE eventos_tiempo_real FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'eventos_tiempo_real' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON eventos_tiempo_real
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── Eventos de plataforma (panel del dueño: cuotas, backups, dominio...) ─
-- Sin tenant_id -- no entra en el alcance de tests/rls-coverage.test.ts
-- (que solo audita tablas CON tenant_id), mismo criterio que
-- platform_outbox/platform_audit_log: la lee el panel de plataforma fuera
-- de cualquier transacción de tenant.
CREATE TABLE IF NOT EXISTS platform_eventos_tiempo_real (
  id        BIGSERIAL PRIMARY KEY,
  tipo      TEXT NOT NULL,
  payload   JSONB NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);
