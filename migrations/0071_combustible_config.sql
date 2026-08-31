-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: configuración de combustible por tenant (ventana de gracia)
--
-- Primera pieza de la conciliación (punto 4 de
-- docs/architecture/control-de-combustible.md): cuánto tiempo tiene un
-- hueco de talonario para explicarse solo antes de congelarse como
-- hallazgo permanente.
--
-- ── Por qué 72 horas, y por qué editable ────────────────────────────────
--
-- Un hueco se explica solo de varias formas legítimas: el vale estaba en
-- una tablet sin señal y sincroniza horas después, alguien lo anuló porque
-- se mojó, o simplemente se carga tarde. Todas tardan horas, no semanas.
--
-- Si la ventana es muy corta, se congelan como sospechosos vales que
-- estaban en camino -- y el control se llena de hallazgos falsos que nadie
-- va a mirar. Si es muy larga, un robo real queda meses en estado
-- "pendiente" mezclado con ruido, que es justo lo que Kenif no quiere:
-- "el ERP no debe acumular los huecos porque no será escalable con el
-- tiempo y todo será desordenado".
--
-- 72h (3 días) es el punto de partida acordado, NO un número validado con
-- operación real -- por eso vive acá y no hardcodeado: el admin lo ajusta
-- cuando vea el ritmo real de sus talonarios. Mismo criterio que
-- `umbral_diferencia_pct` (0066) y su asistente de calibración.
--
-- ── Por qué CON RLS, a diferencia de tenant_sso_config ──────────────────
--
-- tenant_sso_config / tenant_modulos / tenant_cuotas NO tienen RLS a
-- propósito: las administra el panel de PLATAFORMA para cualquier tenant,
-- fuera de toda transacción con app.tenant_id seteado.
--
-- Esta es al revés: la edita el ADMIN DEL PROPIO TENANT desde el ERP, y
-- nunca la toca el panel de plataforma. Es un dato de negocio del tenant,
-- igual que sus tanques -- así que va con el mismo blindaje que el resto
-- del módulo.
--
-- ── Sin sembrar filas ───────────────────────────────────────────────────
--
-- Un tenant sin fila acá usa 72h. El default se resuelve al LEER
-- (COALESCE en la consulta), no insertando una fila por tenant en esta
-- migración: así un tenant nuevo tampoco necesita que nadie se acuerde de
-- crearle la suya, y no hay que mantener sincronizado el alta de tenants.
--
-- EJECUTAR (después de 0070):
--   psql -d mincoreerp -f migrations/0071_combustible_config.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS combustible_config (
  -- `id` serial + UNIQUE(tenant_id), y no `tenant_id` como PK directamente
  -- (que sería lo natural para una fila por tenant): el backup/restore de
  -- tenant asume que toda tabla de módulo tiene una columna `id` propia
  -- --genera una nueva al clonar, ver restaurarTablas() en
  -- platformBackup.service.ts--, y una tabla con PK natural no entraría en
  -- ese mecanismo sin cambiarlo. El UNIQUE de abajo da la misma garantía
  -- de "una sola config por tenant" que daría la PK.
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  ventana_gracia_horas INT NOT NULL DEFAULT 72,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Quién la cambió: subir la ventana afloja el control, así que el "quién"
  -- importa (ADR-0002 §auditoría). Nullable por el ON DELETE SET NULL --
  -- borrar un usuario no debe borrar la evidencia.
  actualizado_por UUID REFERENCES usuarios(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_config_ventana_check'
  ) THEN
    ALTER TABLE combustible_config
      ADD CONSTRAINT combustible_config_ventana_check
      -- Mínimo 1 hora: menos que eso congelaría vales que todavía están
      -- sincronizando, y el control se vuelve ruido. Máximo 1 año: una
      -- ventana más larga que eso no es "dar tiempo", es no conciliar
      -- nunca -- exactamente el desorden que esto viene a evitar.
      CHECK (ventana_gracia_horas BETWEEN 1 AND 8760);
  END IF;
END $$;

-- Cobertura de FK: borrar un usuario dispara el ON DELETE SET NULL sobre
-- esta columna (ver docs/architecture/database-performance-guidelines.md;
-- tests/db-index-coverage.test.ts lo hace fallar en CI si falta).
CREATE INDEX IF NOT EXISTS idx_combustible_config_actualizado_por
  ON combustible_config(actualizado_por) WHERE actualizado_por IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE combustible_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_config FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_config'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_config
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
