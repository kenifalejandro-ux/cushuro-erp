-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: particionado declarativo de checklists e ipercs
--
-- Candidatas por volumen real: la cuota por tenant de ambas es 200.000
-- filas (src/modules/registry.ts) — muy por encima de equipos (2.000) — se
-- cuenta un checklist por equipo/turno y un IPERC por frente/turno, así
-- que a diferencia del resto de las tablas del ERP, estas SÍ crecen sin
-- techo natural con el tiempo. tenant_metricas_horarias, aunque a veces se
-- la menciona junto a estas dos, NO se particiona acá: su propia migración
-- (0022) la diseñó explícitamente acotada (tenants × horas, nunca
-- tenants × requests) — particionarla resolvería un problema que no tiene.
--
-- Clave de partición: RANGE (creado_en) por mes. Postgres exige que la
-- clave de partición forme parte de cualquier PRIMARY KEY/UNIQUE de la
-- tabla particionada, así que checklists/ipercs pasan de PK simple (id) a
-- compuesta (id, creado_en) — el id se sigue generando de una secuencia
-- única y global (se reasigna la misma secuencia SERIAL de siempre), así
-- que en la práctica nunca colisiona entre particiones.
--
-- ── Por qué creado_en es TIMESTAMPTZ(3) acá y no el TIMESTAMPTZ normal
--    (microsegundos) del resto del proyecto ─────────────────────────────
-- Detectado probando el flujo real de checklists.repository.ts/
-- iperc.repository.ts, no en el papel: el checklist/IPERC padre se
-- inserta con RETURNING creado_en, y ese valor (ya un objeto Date de JS)
-- se manda de vuelta como parámetro al INSERT de checklist_items/
-- iperc_items para completar la FK compuesta. node-postgres representa
-- timestamptz como Date de JS, que solo tiene precisión de MILISEGUNDOS —
-- pero un TIMESTAMPTZ de Postgres guarda microsegundos. Sin este ajuste,
-- el valor que vuelve a Postgres para el hijo queda truncado a
-- milisegundos mientras el padre guardó microsegundos completos: la FK
-- compuesta (checklist_id, checklist_creado_en) nunca matchea con
-- (id, creado_en) del padre, y todo INSERT de un ítem falla con
-- "violates foreign key constraint". Declarando creado_en como
-- TIMESTAMPTZ(3) desde el vamos, Postgres redondea a milisegundos AL
-- GUARDAR en el padre — el mismo valor que después viaja como Date de JS
-- y vuelve, sin ninguna pérdida adicional en el camino de vuelta.
-- (No se puede arreglar después con un ALTER COLUMN TYPE: Postgres lo
-- rechaza porque creado_en es parte de la clave de partición — tiene que
-- quedar bien desde esta misma migración.)
--
-- ── Por qué checklist_items/iperc_items necesitan una columna nueva ──────
-- Toda FK que apunte a una tabla particionada tiene que incluir la clave
-- de partición del lado referenciado. checklist_items.checklist_id →
-- checklists(id) deja de alcanzar por sí solo: se agrega
-- checklist_items.checklist_creado_en (copiado del padre al insertar) y la
-- FK pasa a ser compuesta (checklist_id, checklist_creado_en) →
-- checklists(id, creado_en). Mismo caso para iperc_items/iperc_creado_en.
-- Ver checklists.repository.ts / iperc.repository.ts, actualizados para
-- mandar ese valor (ya lo tenían a mano por el RETURNING creado_en del
-- INSERT del padre — no hace falta una query extra).
--
-- ── Hallazgo no obvio #1: RLS NO se propaga solo a las particiones ──────
-- Verificado a mano antes de escribir esto: `ALTER TABLE checklists ENABLE
-- /FORCE ROW LEVEL SECURITY` + policy en el padre NO alcanza. Si alguien
-- (un script, un diagnóstico, un bug futuro) consulta la partición física
-- por su nombre (`checklists_2026_08` en vez de `checklists`), Postgres no
-- hereda la policy del padre — devuelve TODAS las filas de esa partición,
-- de cualquier tenant, incluso sin `app.tenant_id` seteado. La única forma
-- correcta es habilitar RLS + crear la misma policy en CADA partición
-- individualmente. Por eso existe particion_rls_asegurar() más abajo: el
-- único lugar donde se decide "cómo asegurar una partición", usado tanto
-- acá como por el worker de aprovisionamiento continuo
-- (particionado.worker.ts) — que nunca puedan divergir en este paso es
-- justamente el punto.
--
-- ── Hallazgo no obvio #2: FORCE ROW LEVEL SECURITY bloquea esta misma
--    migración ──────────────────────────────────────────────────────────
-- Copiar los datos existentes hacia la tabla nueva, y el backfill de
-- checklist_creado_en/iperc_creado_en, tocan filas de TODOS los tenants a
-- la vez — no hay un único `app.tenant_id` de sesión que fijar. Con FORCE
-- activo (el estado normal de estas tablas) hasta el dueño de la tabla
-- queda sujeto a la policy, y sin `app.tenant_id` seteado el intento ni
-- siquiera falla silencioso: tira "unrecognized configuration parameter".
-- `SET row_security = off` tampoco sirve — Postgres lo rechaza explícito
-- cuando FORCE está activo. La única salida documentada es
-- `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` para el dueño, temporal,
-- durante el copiado — se reactiva FORCE antes de terminar la migración,
-- dentro de la misma transacción (si algo de esto fallara a mitad de
-- camino, migrate.ts manda todo el archivo como una sola transacción
-- implícita: no queda ninguna ventana real con RLS debilitado para nadie
-- más, ver database-performance-guidelines.md sección 7 sobre esto mismo).
--
-- EJECUTAR (después de 0036):
--   psql -d mincoreerp -f migrations/0037_particionado_tablas.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Funciones de aprovisionamiento de particiones ────────────────────────
-- Únicas, reusadas por esta migración (particiones iniciales) y por
-- particionado.worker.ts (particiones futuras, corrida diaria).

CREATE OR REPLACE FUNCTION particion_rls_asegurar(p_relacion text) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_relacion);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_relacion);
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = p_relacion AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'')::uuid)
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      p_relacion
    );
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Crea (si falta) la partición del mes que contiene p_mes, para p_tabla,
-- con su propio RLS. Idempotente: CREATE TABLE IF NOT EXISTS + el chequeo
-- de pg_policies en particion_rls_asegurar() hacen que llamarla de nuevo
-- sobre una partición que ya existe sea un no-op seguro.
CREATE OR REPLACE FUNCTION particion_asegurar_mensual(p_tabla text, p_mes date) RETURNS void AS $$
DECLARE
  particion text := p_tabla || '_' || to_char(p_mes, 'YYYY_MM');
  inicio    date := date_trunc('month', p_mes)::date;
  fin       date := (date_trunc('month', p_mes) + interval '1 month')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    particion, p_tabla, inicio, fin
  );
  PERFORM particion_rls_asegurar(particion);
END;
$$ LANGUAGE plpgsql;

-- Entry point que corre particionado.worker.ts todos los días: asegura que
-- siempre existan el mes actual + p_meses_adelante meses futuros, para las
-- dos tablas particionadas. Agregar acá cualquier tabla nueva que se
-- particione en el futuro — es la única lista que hay que tocar.
CREATE OR REPLACE FUNCTION particiones_asegurar_futuras(p_meses_adelante integer DEFAULT 3) RETURNS void AS $$
DECLARE
  tabla text;
  n     integer;
BEGIN
  FOREACH tabla IN ARRAY ARRAY['checklists', 'ipercs']
  LOOP
    FOR n IN 0..p_meses_adelante LOOP
      PERFORM particion_asegurar_mensual(tabla, (date_trunc('month', now()) + (n || ' months')::interval)::date);
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ── checklists: recrear como tabla particionada ──────────────────────────

ALTER TABLE checklists RENAME TO checklists_old;
ALTER INDEX checklists_pkey RENAME TO checklists_old_pkey;
ALTER INDEX idx_checklists_equipo RENAME TO idx_checklists_old_equipo;
ALTER INDEX idx_checklists_plantilla RENAME TO idx_checklists_old_plantilla;
ALTER INDEX idx_checklists_tenant_id RENAME TO idx_checklists_old_tenant_id;
ALTER INDEX idx_checklists_tenant_usuario RENAME TO idx_checklists_old_tenant_usuario;

CREATE TABLE checklists (
  id                      INTEGER NOT NULL DEFAULT nextval('checklists_id_seq'),
  tenant_id               UUID NOT NULL REFERENCES tenants(id),
  equipo_id               INTEGER NOT NULL REFERENCES equipos(id),
  plantilla_id            INTEGER NOT NULL REFERENCES checklist_plantillas(id),
  usuario_id              UUID NOT NULL REFERENCES usuarios(id),
  fecha                   DATE NOT NULL DEFAULT CURRENT_DATE,
  turno                   VARCHAR(20),
  resultado               VARCHAR(20) NOT NULL DEFAULT 'bien',
  observaciones_generales TEXT,
  creado_en               TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (id, creado_en)
) PARTITION BY RANGE (creado_en);

ALTER SEQUENCE checklists_id_seq OWNED BY checklists.id;

CREATE INDEX idx_checklists_equipo ON checklists(equipo_id);
CREATE INDEX idx_checklists_plantilla ON checklists(plantilla_id);
CREATE INDEX idx_checklists_tenant_id ON checklists(tenant_id, id);
CREATE INDEX idx_checklists_tenant_usuario ON checklists(tenant_id, usuario_id);

SELECT particion_rls_asegurar('checklists');

CREATE TABLE checklists_default PARTITION OF checklists DEFAULT;
SELECT particion_rls_asegurar('checklists_default');

-- ── ipercs: recrear como tabla particionada ──────────────────────────────

ALTER TABLE ipercs RENAME TO ipercs_old;
ALTER INDEX ipercs_pkey RENAME TO ipercs_old_pkey;
ALTER INDEX idx_ipercs_equipo RENAME TO idx_ipercs_old_equipo;
ALTER INDEX idx_ipercs_linea_base RENAME TO idx_ipercs_old_linea_base;
ALTER INDEX idx_ipercs_tenant_aprobado_por RENAME TO idx_ipercs_old_tenant_aprobado_por;
ALTER INDEX idx_ipercs_tenant_id RENAME TO idx_ipercs_old_tenant_id;
ALTER INDEX idx_ipercs_tenant_usuario RENAME TO idx_ipercs_old_tenant_usuario;

CREATE TABLE ipercs (
  id               INTEGER NOT NULL DEFAULT nextval('ipercs_id_seq'),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  fecha            DATE NOT NULL DEFAULT CURRENT_DATE,
  turno            VARCHAR(20),
  area_frente      VARCHAR(200) NOT NULL,
  equipo_id        INTEGER REFERENCES equipos(id),
  usuario_id       UUID NOT NULL REFERENCES usuarios(id),
  estado           VARCHAR(20) NOT NULL DEFAULT 'borrador',
  aprobado_por     UUID REFERENCES usuarios(id),
  aprobado_en      TIMESTAMPTZ,
  creado_en        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  tipo             VARCHAR(20) NOT NULL DEFAULT 'continuo',
  linea_base_id    INTEGER REFERENCES iperc_lineas_base(id),
  tarea_especifica VARCHAR(300),
  PRIMARY KEY (id, creado_en),
  CONSTRAINT ipercs_estado_check CHECK (estado IN ('borrador', 'aprobado', 'rechazado')),
  CONSTRAINT ipercs_tipo_check CHECK (tipo IN ('continuo', 'especifico'))
) PARTITION BY RANGE (creado_en);

ALTER SEQUENCE ipercs_id_seq OWNED BY ipercs.id;

CREATE INDEX idx_ipercs_equipo ON ipercs(equipo_id) WHERE equipo_id IS NOT NULL;
CREATE INDEX idx_ipercs_linea_base ON ipercs(linea_base_id) WHERE linea_base_id IS NOT NULL;
CREATE INDEX idx_ipercs_tenant_aprobado_por ON ipercs(tenant_id, aprobado_por) WHERE aprobado_por IS NOT NULL;
CREATE INDEX idx_ipercs_tenant_id ON ipercs(tenant_id, id);
CREATE INDEX idx_ipercs_tenant_usuario ON ipercs(tenant_id, usuario_id);

SELECT particion_rls_asegurar('ipercs');

CREATE TABLE ipercs_default PARTITION OF ipercs DEFAULT;
SELECT particion_rls_asegurar('ipercs_default');

-- ── Particiones iniciales: mes actual + 3 meses futuros, para ambas ──────
SELECT particiones_asegurar_futuras(3);

-- ── Copiado de datos + backfill de checklist_items/iperc_items ──────────
-- NO FORCE temporal: ver hallazgo #2 en el comentario de arriba.

ALTER TABLE checklists_old NO FORCE ROW LEVEL SECURITY;
ALTER TABLE checklists NO FORCE ROW LEVEL SECURITY;
ALTER TABLE checklist_items NO FORCE ROW LEVEL SECURITY;

INSERT INTO checklists SELECT * FROM checklists_old;

ALTER TABLE checklist_items ADD COLUMN checklist_creado_en TIMESTAMPTZ(3);
UPDATE checklist_items ci SET checklist_creado_en = c.creado_en
  FROM checklists c WHERE c.id = ci.checklist_id;
ALTER TABLE checklist_items ALTER COLUMN checklist_creado_en SET NOT NULL;

ALTER TABLE checklist_items DROP CONSTRAINT checklist_items_checklist_id_fkey;
ALTER TABLE checklist_items ADD CONSTRAINT checklist_items_checklist_id_fkey
  FOREIGN KEY (checklist_id, checklist_creado_en) REFERENCES checklists(id, creado_en) ON DELETE CASCADE;

DROP INDEX idx_checklist_items_checklist;
CREATE INDEX idx_checklist_items_checklist ON checklist_items(checklist_id, checklist_creado_en);

ALTER TABLE checklists FORCE ROW LEVEL SECURITY;
ALTER TABLE checklist_items FORCE ROW LEVEL SECURITY;

DROP TABLE checklists_old;

ALTER TABLE ipercs_old NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ipercs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE iperc_items NO FORCE ROW LEVEL SECURITY;

INSERT INTO ipercs SELECT * FROM ipercs_old;

ALTER TABLE iperc_items ADD COLUMN iperc_creado_en TIMESTAMPTZ(3);
UPDATE iperc_items ii SET iperc_creado_en = i.creado_en
  FROM ipercs i WHERE i.id = ii.iperc_id;
ALTER TABLE iperc_items ALTER COLUMN iperc_creado_en SET NOT NULL;

ALTER TABLE iperc_items DROP CONSTRAINT iperc_items_iperc_id_fkey;
ALTER TABLE iperc_items ADD CONSTRAINT iperc_items_iperc_id_fkey
  FOREIGN KEY (iperc_id, iperc_creado_en) REFERENCES ipercs(id, creado_en) ON DELETE CASCADE;

DROP INDEX idx_iperc_items_iperc;
CREATE INDEX idx_iperc_items_iperc ON iperc_items(iperc_id, iperc_creado_en);

ALTER TABLE ipercs FORCE ROW LEVEL SECURITY;
ALTER TABLE iperc_items FORCE ROW LEVEL SECURITY;

DROP TABLE ipercs_old;
