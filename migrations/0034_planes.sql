-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: planes (segmentación por tamaño de empresa)
--
-- Escalón intermedio entre el override puntual y el default global. El
-- límite efectivo de un tenant se resuelve en TRES niveles, en este orden:
--
--   1. tenant_cuotas   → excepción negociada con ESE cliente (máxima
--                        prioridad; ya existía, no cambia)
--   2. plan del tenant → MYPE / Pequeña / Mediana / Corporativo   ← nuevo
--   3. registry        → default de última instancia (src/modules/registry.ts)
--
-- Sin esto, dar de alta una PYME era cargar ~8 overrides a mano, sin que
-- quedara registrado en ningún lado QUÉ categoría es ese cliente — y
-- cambiar los límites de un segmento obligaba a actualizar cliente por
-- cliente. Ver docs/architecture/cuotas-por-tenant.md.
--
-- ── Por qué plan_limites y no una columna por recurso ───────────────────
--
-- La alternativa obvia era `planes(usuarios INT, equipos INT, ...)`. Se
-- descartó por una razón concreta: con columnas, agregar el módulo 8
-- exigiría una migración para sumar la columna MÁS actualizar el seed de
-- cada plan — justo el tipo de trabajo repartido que el Contrato de Módulo
-- (ADR-0002) existe para eliminar.
--
-- Normalizado, un módulo nuevo simplemente no tiene fila en ningún plan, y
-- su límite cae al nivel 3 (el default del registry). Eso no es un agujero:
-- es el mecanismo de resolución funcionando. Cuando se quiera diferenciar
-- ese módulo por plan, se insertan filas — sin DDL.
--
-- ── `activo` no apaga los límites ───────────────────────────────────────
--
-- Desactivar un plan impide ASIGNARLO a tenants nuevos; los que ya lo
-- tienen conservan sus límites. Lo contrario sería peligroso: dar de baja
-- un plan viejo cambiaría en silencio los topes de los clientes que están
-- en él, posiblemente dejándolos excedidos sin que nadie tocara su cuenta.
--
-- EJECUTAR (después de 0033):
--   psql -d mincoreerp -f migrations/0034_planes.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS planes (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Identificador estable para referirse a un plan desde código//scripts sin
  -- depender del UUID ni del nombre visible (que puede cambiar por marketing).
  codigo         TEXT NOT NULL UNIQUE,
  nombre         TEXT NOT NULL,
  descripcion    TEXT,
  activo         BOOLEAN NOT NULL DEFAULT true,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_limites (
  plan_id UUID NOT NULL REFERENCES planes(id) ON DELETE CASCADE,
  -- Mismos identificadores que tenant_cuotas.recurso: 'usuarios',
  -- 'backup_bytes', o el id de un módulo del registry.
  recurso TEXT NOT NULL,
  -- NULL = ILIMITADO en este plan, igual semántica que tenant_cuotas.limite.
  -- No confundir con "sin fila", que significa "este plan no opina, usá el
  -- default del registry".
  limite  BIGINT,
  PRIMARY KEY (plan_id, recurso)
);

DO $$ BEGIN
  ALTER TABLE plan_limites ADD CONSTRAINT plan_limites_limite_no_negativo
    CHECK (limite IS NULL OR limite >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ON DELETE SET NULL y no CASCADE: borrar un plan JAMÁS puede llevarse
-- puesto a un tenant. El tenant queda sin plan y cae al default del
-- registry, que es un estado seguro y reversible.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES planes(id) ON DELETE SET NULL;

-- Los tenants existentes quedan con plan_id = NULL a propósito: siguen
-- resolviendo por el default del registry, exactamente como venían
-- funcionando. Asignarles un plan es una decisión comercial explícita, no
-- algo que esta migración deba adivinar.
CREATE INDEX IF NOT EXISTS idx_tenants_plan ON tenants(plan_id) WHERE plan_id IS NOT NULL;

-- ── Seed de los 4 planes iniciales ──────────────────────────────────────
--
-- Los números salen de que en este ERP casi todo escala con la CANTIDAD DE
-- EQUIPOS: un checklist de pre-uso es ~1 por equipo por turno, así que
-- 20 equipos × 2 turnos × 365 días ≈ 14.600 checklists/año. Por eso
-- `equipos` es el número que define cada segmento y el resto se deriva con
-- holgura de varios años, en vez de ser cifras sueltas.
--
-- Son un punto de partida ajustable desde el panel sin tocar código.

INSERT INTO planes (codigo, nombre, descripcion) VALUES
  ('mype',        'MYPE',        'Microempresa: operaciones chicas, hasta ~20 equipos'),
  ('pequena',     'Pequeña',     'Pequeña empresa: hasta ~100 equipos'),
  ('mediana',     'Mediana',     'Mediana empresa: hasta ~500 equipos'),
  ('corporativo', 'Corporativo', 'Sin topes de volumen; solo se limita el almacenamiento de backups')
ON CONFLICT (codigo) DO NOTHING;

-- NULL en `limite` = ilimitado. Corporativo solo topea backup_bytes porque
-- es el único recurso con costo directo y recurrente (S3 se paga por GB-mes,
-- ver docs/architecture/backups-s3.md) — el resto son filas en una base que
-- ya se paga igual.
INSERT INTO plan_limites (plan_id, recurso, limite)
SELECT p.id, v.recurso, v.limite
FROM planes p
JOIN (VALUES
  ('mype',        'usuarios',      10::bigint),
  ('mype',        'equipos',       20),
  ('mype',        'checklists',    40000),
  ('mype',        'iperc',         40000),
  ('mype',        'combustible',   20000),
  ('mype',        'repuestos',     10000),
  ('mype',        'documentos',    5000),
  ('mype',        'backup_bytes',  1073741824),          -- 1 GiB

  ('pequena',     'usuarios',      50),
  ('pequena',     'equipos',       100),
  ('pequena',     'checklists',    200000),
  ('pequena',     'iperc',         200000),
  ('pequena',     'combustible',   100000),
  ('pequena',     'repuestos',     50000),
  ('pequena',     'documentos',    20000),
  ('pequena',     'backup_bytes',  5368709120),          -- 5 GiB

  ('mediana',     'usuarios',      200),
  ('mediana',     'equipos',       500),
  ('mediana',     'checklists',    1000000),
  ('mediana',     'iperc',         1000000),
  ('mediana',     'combustible',   500000),
  ('mediana',     'repuestos',     200000),
  ('mediana',     'documentos',    50000),
  ('mediana',     'backup_bytes',  21474836480),         -- 20 GiB

  ('corporativo', 'usuarios',      NULL),
  ('corporativo', 'equipos',       NULL),
  ('corporativo', 'checklists',    NULL),
  ('corporativo', 'iperc',         NULL),
  ('corporativo', 'combustible',   NULL),
  ('corporativo', 'repuestos',     NULL),
  ('corporativo', 'documentos',    NULL),
  ('corporativo', 'backup_bytes',  107374182400)         -- 100 GiB
) AS v(codigo, recurso, limite) ON v.codigo = p.codigo
ON CONFLICT (plan_id, recurso) DO NOTHING;
