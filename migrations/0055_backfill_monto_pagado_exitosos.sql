-- ═══════════════════════════════════════════════════════════════════════════
-- Backfill: cobros.monto_pagado en filas 'exitoso' anteriores a la 0054
--
-- La migración 0054 agregó monto_pagado con DEFAULT 0, pero no tocó las
-- filas que ya existían -- un cobro viejo con estado='exitoso' se quedó
-- con monto_pagado=0, rompiendo el invariante que asume el resto del
-- código (estado='exitoso' => monto_pagado=monto) y mostrando en la UI
-- "Saldo pendiente" sobre algo que ya está pagado por completo.
--
-- EJECUTAR (después de 0054):
--   psql -d mincoreerp -f migrations/0055_backfill_monto_pagado_exitosos.sql
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE cobros SET monto_pagado = monto WHERE estado = 'exitoso' AND monto_pagado <> monto;
