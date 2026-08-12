-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: histórico de lecturas de combustible (offline-first)
--
-- Escenario que resuelve: hasta acá `PUT /:id/nivel` sobreescribía
-- `combustible.nivel_actual` directo. Eso funciona online, pero en offline
-- (ver migración 0044) dos lecturas del mismo tanque pueden sincronizar en
-- cualquier orden -- si una lectura de hace 3 horas llega DESPUÉS de una de
-- hace 10 minutos (señal intermitente en campo), un UPDATE simple pisaría el
-- dato bueno con uno viejo. Corrupción silenciosa, no un duplicado.
--
-- Esta migración agrega `combustible_lecturas` como historial append-only
-- (nunca se borra una lectura) y dejo que `combustible.nivel_actual` se
-- actualice condicionalmente comparando contra `fecha_actualizacion` --
-- columna que YA existe en `combustible` desde 0002_business_tables.sql, no
-- hace falta una nueva.
--
-- EJECUTAR (después de 0044):
--   psql -d mincoreerp -f migrations/0045_combustible_lecturas.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_lecturas (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  combustible_id INTEGER NOT NULL REFERENCES combustible(id) ON DELETE CASCADE,
  nivel          NUMERIC(12,2) NOT NULL,
  -- Cuándo se TOMÓ la lectura en el tanque, no cuándo llegó al servidor --
  -- es la marca que decide si actualiza nivel_actual (ver idempotentInsert
  -- + combustible.repository.ts). Lo manda el dispositivo; si viene vacío
  -- (creación online de siempre) el service usa now().
  leido_en       TIMESTAMPTZ NOT NULL,
  -- Nullable a propósito: un usuario borrado no debe borrar el historial de
  -- lecturas (mismo criterio que documentos_versiones.subido_por, 0043).
  usuario_id     UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  -- Hoy solo existe carga manual desde el formulario; la columna deja lugar
  -- a un origen distinto (ej. sensor) el día que exista, sin migración nueva.
  origen         VARCHAR(20) NOT NULL DEFAULT 'manual',
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cubre el filtro de RLS y "lecturas de este tanque, la más reciente
-- primero" en el mismo índice -- mismo criterio que
-- idx_documentos_versiones_documento (0043).
CREATE INDEX IF NOT EXISTS idx_combustible_lecturas_combustible
  ON combustible_lecturas(combustible_id, leido_en DESC);

CREATE INDEX IF NOT EXISTS idx_combustible_lecturas_tenant
  ON combustible_lecturas(tenant_id);

CREATE INDEX IF NOT EXISTS idx_combustible_lecturas_usuario
  ON combustible_lecturas(usuario_id) WHERE usuario_id IS NOT NULL;

-- ── Backfill ──────────────────────────────────────────────────────────────
-- Cada tanque existente arranca su historial con una lectura sintética que
-- refleja su estado actual -- así el historial nunca aparece vacío para un
-- tanque que ya tenía datos antes de esta migración, y la primera lectura
-- real que llegue se compara contra un `leido_en` real, no contra NULL.
--
-- Toca filas de TODOS los tenants a la vez -- no hay un único
-- `app.tenant_id` de sesión que fijar. `combustible` tiene FORCE ROW LEVEL
-- SECURITY (mismo bloqueo ya documentado en migrations/0037, hallazgo no
-- obvio #2): hasta el dueño de la tabla queda sujeto a la policy, y sin
-- `app.tenant_id` seteado el intento tira "unrecognized configuration
-- parameter" en vez de fallar silencioso. Se desactiva FORCE para el dueño
-- solo durante el backfill y se reactiva antes de terminar, dentro de la
-- misma transacción implícita que migrate.ts abre para todo el archivo.
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;

INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
SELECT tenant_id, id, nivel_actual, fecha_actualizacion, 'backfill'
FROM combustible
WHERE NOT EXISTS (
  SELECT 1 FROM combustible_lecturas WHERE combustible_lecturas.combustible_id = combustible.id
);

ALTER TABLE combustible FORCE ROW LEVEL SECURITY;

-- Mismo criterio que 0005/0042/0044: FORCE es imprescindible, si no el owner
-- de la tabla (el rol con el que se conecta la app) queda exento de RLS y la
-- policy nunca se aplicaría a las queries de la propia app.
ALTER TABLE combustible_lecturas ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_lecturas FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_lecturas' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_lecturas
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
