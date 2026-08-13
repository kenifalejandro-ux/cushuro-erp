-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: histórico de movimientos de stock de repuestos (offline-first)
--
-- Escenario que resuelve: hasta acá el único modo de cambiar `stock` era
-- `PUT /:id`, que sobreescribe la fila COMPLETA (codigo, nombre, stock,
-- etc.) — declarar esa ruta offline haría que una edición vieja, sincronizada
-- tarde, pise un stock más nuevo en silencio (mismo problema que tenía
-- Combustible antes de 0045, ver ADR-0002 §8).
--
-- A diferencia de Combustible, un movimiento de stock es un DELTA (entrada
-- +N / salida -N), no una lectura absoluta — sumar deltas es conmutativo, así
-- que `repuestos.stock` sigue siendo la columna real (no se deriva con SUM) y
-- se actualiza con un UPDATE atómico `stock = stock + delta`, sin necesitar
-- comparar contra ningún timestamp: no importa en qué orden sincronicen dos
-- movimientos, el resultado final es el mismo. Por eso esta migración NO
-- necesita backfill (no hay ninguna columna que reemplazar ni "última
-- lectura" que sembrar) ni el toggle NO FORCE/FORCE de 0037/0045 (eso solo
-- hace falta cuando un backfill toca todos los tenants a la vez).
--
-- `repuestos_movimientos` es el histórico append-only (nunca se borra un
-- movimiento) que respalda esa aritmética y da trazabilidad de campo.
--
-- EJECUTAR (después de 0045):
--   psql -d mincoreerp -f migrations/0046_repuestos_movimientos.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS repuestos_movimientos (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  repuesto_id  INTEGER NOT NULL REFERENCES repuestos(id) ON DELETE CASCADE,
  tipo         VARCHAR(10) NOT NULL CHECK (tipo IN ('entrada', 'salida')),
  -- Siempre positivo: el signo del delta lo da `tipo`, no este número.
  cantidad     INTEGER NOT NULL CHECK (cantidad > 0),
  motivo       VARCHAR(200),
  -- Cuándo pasó FÍSICAMENTE el movimiento, no cuándo llegó al servidor.
  -- A diferencia de `combustible_lecturas.leido_en`, esta columna es solo
  -- para el historial -- NO decide si el UPDATE de stock se aplica (ver el
  -- comentario de arriba sobre por qué el delta no necesita esa guarda).
  -- Nullable a propósito, mismo motivo que en combustible_lecturas: si el
  -- dispositivo no lo manda (creación online de siempre), el service usa
  -- now().
  registrado_en TIMESTAMPTZ NOT NULL,
  -- Nullable a propósito: un usuario borrado no debe borrar el historial de
  -- movimientos (mismo criterio que documentos_versiones.subido_por, 0043,
  -- y combustible_lecturas.usuario_id, 0045).
  usuario_id   UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Hoy solo existe carga manual desde el modal; deja lugar a un origen
  -- distinto (ej. integración con una futura Orden de Trabajo) el día que
  -- exista, sin migración nueva.
  origen       VARCHAR(20) NOT NULL DEFAULT 'manual',
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  creado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cubre el filtro de RLS y "movimientos de este repuesto, el más reciente
-- primero" en el mismo índice -- mismo criterio que
-- idx_combustible_lecturas_combustible (0045).
CREATE INDEX IF NOT EXISTS idx_repuestos_movimientos_repuesto
  ON repuestos_movimientos(repuesto_id, registrado_en DESC);

CREATE INDEX IF NOT EXISTS idx_repuestos_movimientos_tenant
  ON repuestos_movimientos(tenant_id);

CREATE INDEX IF NOT EXISTS idx_repuestos_movimientos_usuario
  ON repuestos_movimientos(usuario_id) WHERE usuario_id IS NOT NULL;

-- FORCE es imprescindible, si no el owner de la tabla (el rol con el que se
-- conecta la app) queda exento de RLS y la policy nunca se aplicaría a las
-- queries de la propia app -- mismo criterio que 0005/0042/0044/0045.
ALTER TABLE repuestos_movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE repuestos_movimientos FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'repuestos_movimientos' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON repuestos_movimientos
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
