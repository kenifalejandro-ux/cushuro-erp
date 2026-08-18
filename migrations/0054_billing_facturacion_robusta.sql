-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: motor de facturación recurrente + saldo parcial en cobros
--
-- Hasta acá `cobros` era un monto único con estado binario
-- (pendiente/exitoso/fallido) y ningún cobro de tipo 'suscripcion' se
-- creaba por adelantado -- solo existían como efecto secundario de
-- "Forzar cobro" (ver platformBilling.service.ts). Esta migración agrega
-- lo mínimo para que el motor de facturación (platformBillingVencimientos
-- .service.ts) pueda generar cobros ANTES de que venzan, y para que un
-- cobro se pueda pagar de a partes:
--
--   • `fecha_vencimiento`: cuándo corresponde este cobro. NULL en filas
--     viejas (ya resueltas, no necesitan una) y en los cobros de
--     implementación cargados sin fecha pactada.
--   • `monto_pagado`: acumulado recibido hasta ahora. 0 en todo lo
--     existente (no cambia el significado de las filas ya cerradas:
--     'exitoso' + monto_pagado=0 sigue leyéndose como pagado completo por
--     los reportes existentes, que miran `estado`, no `monto_pagado`).
--     El servicio (no esta migración) hace cumplir que
--     `estado='exitoso' => monto_pagado=monto` -- acá solo el piso/techo.
--
-- El índice parcial (`WHERE estado='pendiente'`) es porque las dos
-- consultas que se agregan corren seguido y cruzan TODOS los tenants:
-- "generar próximos cobros" (evitar duplicar) y `obtenerAlertasBillingService`
-- (vencidas/próximas) -- ninguna de las dos necesita mirar cobros ya
-- resueltos.
--
-- EJECUTAR (después de 0053):
--   psql -d mincoreerp -f migrations/0054_billing_facturacion_robusta.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE cobros ADD COLUMN IF NOT EXISTS fecha_vencimiento TIMESTAMPTZ;
ALTER TABLE cobros ADD COLUMN IF NOT EXISTS monto_pagado NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE cobros DROP CONSTRAINT IF EXISTS cobros_monto_pagado_check;
ALTER TABLE cobros ADD CONSTRAINT cobros_monto_pagado_check
  CHECK (monto_pagado >= 0 AND monto_pagado <= monto);

CREATE INDEX IF NOT EXISTS idx_cobros_pendientes_vencimiento
  ON cobros(fecha_vencimiento) WHERE estado = 'pendiente';
