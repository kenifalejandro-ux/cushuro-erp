-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: combustible_anomalias -- el hallazgo congelado
--
-- El corazón del punto 4 de docs/architecture/control-de-combustible.md.
-- Con 0071 (la ventana) y esta tabla, un worker puede cerrar el ciclo:
-- lo que a las 72h sigue sin explicación deja de ser un aviso vivo y pasa
-- a ser un hallazgo permanente.
--
-- ── Por qué DOS tablas y no un flag en combustible_alertas ──────────────
--
-- Son dos cosas distintas, no dos estados de la misma:
--
-- - `combustible_alertas` (0068) es el candidato VIVO: se crea al detectar
--   un hueco, se resuelve sola cuando llega el vale, se puede marcar como
--   leída. Es ruido en tránsito, y la mayoría desaparece.
-- - `combustible_anomalias` es el hallazgo CONGELADO: ya pasó la ventana
--   sin explicación. Es evidencia, no una bandeja de entrada.
--
-- El documento es explícito sobre por qué importa la separación: "si el
-- preview escribiera filas a las 14:00, a fin de mes habría cientos de
-- alertas de las cuales la mayoría se resolvieron solas y nadie las
-- limpió... el control muere no por falso, sino por ruidoso. Con esta
-- separación: si hay una fila en combustible_anomalias, es real".
--
-- ── Append-only a propósito ─────────────────────────────────────────────
--
-- No hay `resuelta_en` ni `anulada_en` acá. El documento dice "la
-- conciliación del martes queda inmutable", y esa inmutabilidad es lo que
-- le da valor: un hallazgo que se puede borrar o marcar como resuelto es
-- un hallazgo que alguien va a borrar cuando incomode.
--
-- `ventana_horas` se guarda EN LA FILA, no se lee de combustible_config al
-- consultarla: si mañana alguien sube la ventana a 200h, los hallazgos
-- viejos tienen que seguir diciendo "estuvo 72h sin explicarse", que es lo
-- que realmente pasó. Sin esta columna, cambiar la config reescribiría el
-- pasado.
--
-- ── despacho_tardio ─────────────────────────────────────────────────────
--
-- El "bonus" del punto 4: "si el jueves aparece un vale del martes, no toca
-- la conciliación ya cerrada -- entra marcado como despacho_tardio. Que
-- alguien 'se acuerde' de un vale dos días después es justo lo que se
-- quiere ver, no algo a corregir en silencio."
--
-- Por eso el vale que llega tarde NO resucita la anomalía (es inmutable):
-- genera una alerta nueva de este tipo, que sí se puede revisar y cerrar.
--
-- EJECUTAR (después de 0071):
--   psql -d mincoreerp -f migrations/0072_combustible_anomalias.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_anomalias (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Mismos tipos que combustible_alertas, salvo despacho_tardio: ese nunca
  -- se congela (es un aviso que se revisa y se cierra, no un faltante).
  tipo TEXT NOT NULL CHECK (tipo IN ('hueco_detectado', 'sobredespacho')),
  serie_talonario TEXT NOT NULL,
  n_vale INT NOT NULL,
  despacho_id INT REFERENCES combustible_despachos(id) ON DELETE SET NULL,
  -- La alerta que le dio origen. Nullable por el ON DELETE SET NULL: la
  -- anomalía sobrevive aunque la alerta se limpie algún día.
  alerta_id BIGINT REFERENCES combustible_alertas(id) ON DELETE SET NULL,
  detalle JSONB NOT NULL DEFAULT '{}',
  -- Cuándo se detectó el problema (= creado_en de la alerta original) y
  -- cuándo se congeló. La resta entre las dos es la evidencia de cuánto
  -- tiempo estuvo sin explicarse.
  detectada_en TIMESTAMPTZ NOT NULL,
  congelada_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- La ventana que regía en ESE momento -- ver el comentario de arriba.
  ventana_horas INT NOT NULL
);

-- Una alerta se congela UNA sola vez. Es la red de seguridad real contra
-- que dos instancias del worker corran a la vez y dupliquen el hallazgo
-- (el advisory lock ya lo evita, pero el lock es coordinación, no
-- garantía: esto sí lo es). Parcial porque alerta_id es nullable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_combustible_anomalias_alerta_unica
  ON combustible_anomalias(alerta_id) WHERE alerta_id IS NOT NULL;

-- "Las anomalías de este tenant, de la más reciente a la más vieja" -- la
-- consulta del listado.
CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_tenant
  ON combustible_anomalias(tenant_id, congelada_en DESC);

-- Cobertura de FK (tests/db-index-coverage.test.ts lo exige).
CREATE INDEX IF NOT EXISTS idx_combustible_anomalias_despacho
  ON combustible_anomalias(despacho_id) WHERE despacho_id IS NOT NULL;

ALTER TABLE combustible_anomalias ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_anomalias FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_anomalias'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_anomalias
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- ── combustible_alertas: marca de congelada ─────────────────────────────
-- Sin esto, el worker no tendría cómo saber qué alertas ya procesó y las
-- volvería a congelar en cada corrida.
--
-- Solo la MARCA, sin un `anomalia_id` de vuelta: la relación ya la guarda
-- combustible_anomalias.alerta_id, y agregar el puntero inverso crearía un
-- ciclo de FK entre las dos tablas. Eso rompería el restore de un backup,
-- que inserta tabla por tabla en orden padre→hijo (ver `tablas` en
-- registry.ts y restaurarTablas()): con un ciclo no existe tal orden, y la
-- primera de las dos en insertarse referenciaría filas que todavía no
-- existen. Ir de alerta a anomalía es un JOIN por alerta_id, que alcanza.
ALTER TABLE combustible_alertas
  ADD COLUMN IF NOT EXISTS congelada_en TIMESTAMPTZ;

-- La consulta EXACTA del worker: "huecos de este tenant, sin resolver, sin
-- congelar". Parcial sobre esas dos condiciones porque son justamente las
-- filas raras (la mayoría se resuelve o ya se congeló).
CREATE INDEX IF NOT EXISTS idx_combustible_alertas_por_congelar
  ON combustible_alertas(tenant_id, creado_en)
  WHERE resuelta_en IS NULL AND congelada_en IS NULL;

-- ── Nuevo tipo de alerta: despacho_tardio ───────────────────────────────
-- Ver el encabezado. Postgres no permite extender un CHECK: se reemplaza.
ALTER TABLE combustible_alertas
  DROP CONSTRAINT IF EXISTS combustible_alertas_tipo_check;

ALTER TABLE combustible_alertas
  ADD CONSTRAINT combustible_alertas_tipo_check
  CHECK (tipo IN ('hueco_detectado', 'vale_anulado', 'sobredespacho', 'despacho_tardio'));
