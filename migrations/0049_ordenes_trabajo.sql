-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: Órdenes de Trabajo (OT)
--
-- Primer módulo nuevo desde el Contrato de Módulo (ADR-0002, migración
-- 0008 en adelante) — hasta acá los 7 módulos existentes ya venían
-- incluidos en el `CREATE TYPE modulo_erp` original de 0008, así que esta
-- es la primera vez que se usa `ALTER TYPE ... ADD VALUE` en este repo.
--
-- Diseño (ver plan aprobado, memoria nuevo_modulo_ordenes_trabajo):
-- tabla única `ordenes_trabajo` (sin ítems/tareas hija — es un ticket de
-- trabajo con un estado y un cierre, no un desglose como Checklists/IPERC),
-- FK obligatoria a `equipos` (toda OT es trabajo sobre un equipo),
-- referencia opcional a `ipercs` (sin gating real en v1). La creación
-- participa del offline (ver src/modules/registry.ts) — es de los casos
-- más claros del ERP para trabajar sin señal (el equipo se rompe en
-- cancha, se abre la OT ahí mismo) — por eso NO lleva columna propia de
-- idempotencia: usa la tabla genérica `idempotency_keys` (migración 0044),
-- mismo criterio que Combustible/Documentos.
--
-- Esta migración también extiende `documentos` con `orden_trabajo_id`
-- nullable (evidencia del trabajo — informe, fotos) — primera vez que esa
-- tabla se vincula a otra entidad, no tenía ningún campo de referencia
-- hasta ahora.
--
-- EJECUTAR (después de 0046, depende de equipos/ipercs/documentos/usuarios):
--   psql -d mincoreerp -f migrations/0049_ordenes_trabajo.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ordenes_trabajo (
  id                    SERIAL PRIMARY KEY,
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  equipo_id             INTEGER NOT NULL REFERENCES equipos(id),
  titulo                VARCHAR(200) NOT NULL,
  descripcion           TEXT,
  tipo                  VARCHAR(20) NOT NULL DEFAULT 'correctivo',
  prioridad             VARCHAR(10) NOT NULL DEFAULT 'media',
  estado                VARCHAR(20) NOT NULL DEFAULT 'abierta',
  -- Referencia opcional, sin gating real en v1 (ver decisión del plan): no
  -- bloquea ninguna transición, solo trazabilidad de "esta OT tiene tal
  -- evaluación de riesgo asociada".
  --
  -- SIN FK real a propósito (a diferencia de equipo_id): `ipercs` está
  -- particionada por RANGE(creado_en) (migración 0037), y Postgres exige
  -- que una FK hacia una tabla particionada incluya la columna de
  -- partición en la referencia (mismo motivo por el que iperc_items usa
  -- una FK COMPUESTA (iperc_id, iperc_creado_en) en vez de una simple).
  -- Cargar esa segunda columna acá solo para sostener una referencia
  -- opcional sin gating es más complejidad de la que el campo justifica --
  -- la existencia se valida en la aplicación
  -- (OrdenesTrabajoRepository.crear/actualizar), igual que ya se hace para
  -- equipo_id además de su FK real.
  iperc_id              INTEGER,
  -- NOT NULL, sin ON DELETE -- mismo criterio que ipercs.usuario_id (0006)
  -- y checklists.usuario_id: una OT siempre tiene autor, a diferencia de
  -- las tablas de histórico append-only (repuestos_movimientos.usuario_id,
  -- documentos_versiones.subido_por) donde SÍ se permite que el usuario se
  -- borre y el campo quede NULL.
  creado_por            UUID NOT NULL REFERENCES usuarios(id),
  fecha_programada      DATE,
  -- Se setean juntos al llegar a 'completada'/'cancelada' (ver
  -- OrdenesTrabajoRepository.cambiarEstado) -- NULL mientras la OT sigue
  -- abierta o en progreso.
  fecha_cierre          TIMESTAMPTZ,
  observaciones_cierre  TEXT,
  creado_en             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ordenes_trabajo_tipo_check CHECK (tipo IN ('correctivo', 'preventivo')),
  CONSTRAINT ordenes_trabajo_prioridad_check CHECK (prioridad IN ('baja', 'media', 'alta', 'urgente')),
  CONSTRAINT ordenes_trabajo_estado_check CHECK (estado IN ('abierta', 'en_progreso', 'completada', 'cancelada'))
);

CREATE INDEX IF NOT EXISTS idx_ordenes_trabajo_tenant ON ordenes_trabajo(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_trabajo_equipo ON ordenes_trabajo(equipo_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_trabajo_creado_por ON ordenes_trabajo(creado_por);
-- Cubre el filtro por estado del listado (ver OrdenesTrabajoRepository.findAll)
-- y el WHERE de la guarda de carrera de cambiarEstado en el mismo índice.
CREATE INDEX IF NOT EXISTS idx_ordenes_trabajo_tenant_estado ON ordenes_trabajo(tenant_id, estado);

-- FORCE es imprescindible: sin él, el owner de la tabla (el mismo usuario
-- con el que se conecta la app) queda exento de RLS por default, y la
-- política nunca aplicaría a las queries de la propia app -- mismo
-- criterio que 0006/0046/0045.
ALTER TABLE ordenes_trabajo ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordenes_trabajo FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'ordenes_trabajo' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON ordenes_trabajo
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;

-- Ningún statement de ESTE archivo usa el valor nuevo como dato (no hay
-- ningún INSERT/comparación contra 'ordenes_trabajo' más abajo) -- solo
-- por eso es seguro sumarlo en la misma transacción implícita que el resto
-- del archivo (migrate.ts corre todo el .sql en un solo client.query()).
-- Si algún día una migración futura necesitara INSERTAR una fila con este
-- valor, esa inserción tiene que ir en un archivo aparte.
ALTER TYPE modulo_erp ADD VALUE IF NOT EXISTS 'ordenes_trabajo';

-- ── Evidencia del trabajo (informe, fotos) ──────────────────────────────
-- Primera vez que `documentos` se vincula a otra entidad -- hasta ahora
-- era un tracker plano (SOAT, pólizas, vencimientos) sin ningún campo de
-- referencia, ni siquiera a un equipo. ON DELETE SET NULL y no CASCADE:
-- borrar una OT no debe borrar un documento legal/de evidencia, solo
-- desvincularlo.
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS orden_trabajo_id INTEGER REFERENCES ordenes_trabajo(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documentos_orden_trabajo ON documentos(orden_trabajo_id) WHERE orden_trabajo_id IS NOT NULL;
