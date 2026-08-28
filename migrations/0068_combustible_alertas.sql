-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: alertas de combustible (hueco detectado, vale anulado)
--
-- Hasta acá un hueco de talonario (falta el vale 00022 entre 00021 y
-- 00023) solo se ve si alguien abre a mano GET /despachos/huecos, y una
-- anulación (migrations/0067) solo mueve la pantalla en vivo -- nadie se
-- entera si no está mirando en ese momento. Esta tabla es el registro
-- persistente de esos dos eventos, para que gerencia (rol admin) y el
-- admin de combustible se enteren por correo y en el ERP apenas pasan,
-- sin esperar a que alguien note el hueco ni al cierre de período
-- (Fase D entrega 2, que sigue aparte).
--
-- Detección 100% event-driven, sin cron: un hueco solo se puede probar
-- cuando aparece un vale más allá de él, y ese momento es el propio
-- INSERT en combustible_despachos -- ver combustibleRepository.
--
-- EJECUTAR (después de 0067):
--   psql -d mincoreerp -f migrations/0068_combustible_alertas.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_alertas (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('hueco_detectado', 'vale_anulado')),
  serie_talonario TEXT NOT NULL,
  n_vale INT NOT NULL,
  -- El despacho que reveló el hueco (hueco_detectado) o el que se anuló
  -- (vale_anulado). Nullable: si el despacho se borra en algún momento
  -- (hoy no pasa, no se borran nunca), la alerta queda como evidencia.
  despacho_id INT REFERENCES combustible_despachos(id) ON DELETE SET NULL,
  detalle JSONB NOT NULL DEFAULT '{}',
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lectura y resolución COMPARTIDAS entre todos los admins del tenant, no
  -- por usuario: no hay ningún patrón de inbox personal en el resto del
  -- ERP, esto es un registro de equipo como todo lo demás del módulo.
  leida_en TIMESTAMPTZ,
  -- hueco_detectado se resuelve solo (el vale tardío llega y llena el
  -- número) -- resuelta_por queda NULL, es el sistema. vale_anulado se
  -- resuelve a mano cuando un admin revisa el motivo -- ahí sí lleva
  -- resuelta_por, es la evidencia de quién dio el visto bueno.
  resuelta_en TIMESTAMPTZ,
  resuelta_por UUID REFERENCES usuarios(id) ON DELETE SET NULL
);

-- ── Índices ─────────────────────────────────────────────────────────────

-- Badge de la campanita: "cuántas sin leer tiene este tenant". Parcial
-- porque las leídas son la mayoría con el tiempo.
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_no_leidas
  ON combustible_alertas(tenant_id) WHERE leida_en IS NULL;

-- La auto-resolución de hueco_detectado busca por exactamente esta clave
-- cada vez que se registra un despacho (ver resolverAlertaHuecoSiExiste).
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_serie_vale
  ON combustible_alertas(tenant_id, serie_talonario, n_vale);

-- Cobertura de FK (mismo motivo que 0067 con anulada_por --
-- tests/db-index-coverage.test.ts lo exige).
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_despacho
  ON combustible_alertas(despacho_id) WHERE despacho_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_alertas_resuelta_por
  ON combustible_alertas(resuelta_por) WHERE resuelta_por IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Mismo criterio que el resto de las tablas propias de un tenant: FORCE es
-- imprescindible, si no el owner de la tabla (el rol con el que se conecta
-- la app) queda exento de la política.
ALTER TABLE combustible_alertas ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_alertas FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_alertas'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_alertas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
