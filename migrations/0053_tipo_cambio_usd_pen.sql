-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: Tipo de cambio USD → PEN (billing, migración 0041)
--
-- Reemplaza TIPO_CAMBIO_USD_PEN_PLACEHOLDER (constante hardcodeada en
-- platformBilling.service.ts) por un valor real, editable sin deploy --
-- el TC cambia seguido (SUNAT lo publica día a día) y antes no había forma
-- de actualizarlo sin tocar código.
--
-- Diseño (híbrido, ver el resumen que acompaña esta migración):
--   • `platform_tipo_cambio_usd_pen` es APPEND-ONLY, mismo criterio que
--     platform_audit_log/webhooks_pasarela -- nunca se pisa un valor
--     viejo, se agrega uno nuevo. "El TC actual" = la fila con
--     creado_en más reciente. Esto da el historial de cambios gratis,
--     sin una tabla de auditoría aparte.
--   • `suscripciones.tipo_cambio_override` es la excepción puntual: un
--     cliente con una tasa pactada fija distinta a la de mercado. NULL
--     (default) = usa el TC global de la fila más reciente.
--   • `cobros.tipo_cambio_aplicado` (ya existe desde 0041) NO se toca --
--     sigue siendo el snapshot real de cada cobro puntual, sea cual sea
--     el TC "actual" en el momento en que se lee. El histórico de cobros
--     nunca se recalcula retroactivamente si cambia el TC global después.
--
-- Semilla: mismo valor que tenía el placeholder (3.75), para que el
-- primer cobro después de esta migración no cambie de monto de golpe.
--
-- EJECUTAR (después de 0052):
--   psql -d mincoreerp -f migrations/0053_tipo_cambio_usd_pen.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS platform_tipo_cambio_usd_pen (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  valor NUMERIC(10, 4) NOT NULL CHECK (valor > 0),
  -- Snapshot del actorLabel de quien lo actualizó -- mismo criterio que
  -- platform_audit_log.actor_label: una foto tomada al momento, no se
  -- resuelve por JOIN (un admin que cambia de nombre no debe reescribir
  -- el historial).
  creado_por TEXT NOT NULL,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tipo_cambio_creado_en ON platform_tipo_cambio_usd_pen (creado_en DESC);

INSERT INTO platform_tipo_cambio_usd_pen (valor, creado_por)
SELECT 3.75, 'migración 0053 (semilla inicial, mismo valor que el placeholder que reemplaza)'
WHERE NOT EXISTS (SELECT 1 FROM platform_tipo_cambio_usd_pen);

ALTER TABLE suscripciones
  ADD COLUMN IF NOT EXISTS tipo_cambio_override NUMERIC(10, 4) CHECK (
    tipo_cambio_override IS NULL OR tipo_cambio_override > 0
  );
