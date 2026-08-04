-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: auditoría e indexación multi-tenant (docs/architecture/database-performance-guidelines.md)
--
-- Hasta esta migración, cada tabla de negocio tenía un índice simple
-- `(tenant_id)`. Eso alcanza para el filtro de RLS/WHERE, pero todo listado
-- paginado (`WHERE tenant_id = $1 ORDER BY id DESC LIMIT/OFFSET`, el patrón
-- en TODOS los repositorios de los 7 módulos) igual necesitaba un paso de
-- Sort aparte, porque el índice no cubría el ORDER BY. Esta migración:
--
--   1) reemplaza esos índices simples por compuestos (tenant_id, <columna
--      de orden>) — un índice compuesto sirve igual de bien cualquier
--      query que solo filtre por tenant_id (regla del prefijo izquierdo de
--      un btree), así que el índice viejo queda estrictamente redundante:
--      se DROPea en la misma migración en vez de dejarlo viviendo en
--      paralelo sin aportar nada, pagando mantenimiento en cada INSERT.
--
--   2) agrega los índices de Foreign Key que faltaban. Dos motivos
--      distintos, según si la tabla padre se borra de verdad o no (ver
--      DELETE FROM real vs. desactivar en cada repository):
--
--      a) FK hacia una tabla que SÍ se borra con DELETE real (equipos,
--         checklist_plantillas, iperc_lineas_base) y que NO tiene ON
--         DELETE CASCADE: Postgres tiene que escanear la tabla hija
--         completa para validar el constraint antes de permitir el borrado
--         del padre. Sin índice, esto es un Seq Scan que crece con la
--         tabla hija y alarga el lock del DELETE. Acá el índice va con la
--         columna FK LIDERANDO (no tenant_id) — es lo que ese chequeo
--         interno de Postgres necesita.
--
--      b) FK hacia usuarios (nunca se borra de verdad — "eliminar" un
--         usuario es desactivar, ver ADR de plataforma): no hay chequeo de
--         borrado que proteger. Estos índices son compuestos
--         (tenant_id, columna) porque su valor real es servir una futura
--         query de aplicación filtrada por tenant primero (el patrón que
--         ya usa el 100% de las queries de este código), no un chequeo de
--         constraint.
--
-- Todo con CREATE/DROP INDEX normales (sin CONCURRENTLY): el volumen de
-- datos actual (piloto único, Cushuro) hace que cada uno tome milisegundos.
-- CREATE INDEX sin CONCURRENTLY toma un lock que bloquea escrituras en esa
-- tabla mientras corre — aceptable hoy, pero cuando una tabla crezca lo
-- suficiente para que esto importe, hay que correr el reemplazo a mano con
-- CONCURRENTLY (Postgres lo prohíbe dentro de una transacción, y
-- migrate.ts corre cada archivo como una sola transacción implícita — ver
-- docs/architecture/database-performance-guidelines.md para el
-- procedimiento exacto).
--
-- EJECUTAR (después de 0030):
--   psql -d mincoreerp -f migrations/0031_optimize_tenant_indexes.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1) Índices (tenant_id, <orden>) que cubren el ORDER BY de cada listado ──

-- repuestos: RepuestosRepository.findAll → WHERE tenant_id = $1 ORDER BY id DESC
DROP INDEX IF EXISTS idx_repuestos_tenant;
CREATE INDEX IF NOT EXISTS idx_repuestos_tenant_id ON repuestos(tenant_id, id);

-- combustible: CombustibleRepository.findAll → WHERE tenant_id = $1 ORDER BY id ASC
DROP INDEX IF EXISTS idx_combustible_tenant;
CREATE INDEX IF NOT EXISTS idx_combustible_tenant_id ON combustible(tenant_id, id);

-- documentos: DocumentosRepository.findAll → WHERE tenant_id = $1
-- ORDER BY fecha_vencimiento ASC NULLS LAST (el default de un índice ASC,
-- no hace falta declararlo). El mismo dashboard también filtra 3 veces por
-- tenant_id + fecha_vencimiento (vencidos/próximos/vigentes) — este índice
-- cubre ambos casos, por eso lidera con tenant_id y no con id.
DROP INDEX IF EXISTS idx_documentos_tenant;
CREATE INDEX IF NOT EXISTS idx_documentos_tenant_vencimiento ON documentos(tenant_id, fecha_vencimiento);

-- equipos: EquiposRepository.findAll → WHERE tenant_id = $1 ORDER BY id DESC
DROP INDEX IF EXISTS idx_equipos_tenant;
CREATE INDEX IF NOT EXISTS idx_equipos_tenant_id ON equipos(tenant_id, id);

-- checklist_plantillas: ChecklistsRepository.findPlantillas → misma forma
DROP INDEX IF EXISTS idx_checklist_plantillas_tenant;
CREATE INDEX IF NOT EXISTS idx_checklist_plantillas_tenant_id ON checklist_plantillas(tenant_id, id);

-- checklists: ChecklistsRepository.findAll → misma forma
DROP INDEX IF EXISTS idx_checklists_tenant;
CREATE INDEX IF NOT EXISTS idx_checklists_tenant_id ON checklists(tenant_id, id);

-- iperc_lineas_base: IpercRepository.findLineasBase → misma forma
DROP INDEX IF EXISTS idx_iperc_lineas_base_tenant;
CREATE INDEX IF NOT EXISTS idx_iperc_lineas_base_tenant_id ON iperc_lineas_base(tenant_id, id);

-- ipercs: IpercRepository.findAll → misma forma (más un filtro opcional
-- por `tipo`, que no se cubre acá a propósito: IPERC tiene volumen bajo
-- comparado con repuestos/checklists, y un índice de 3 columnas
-- (tenant_id, tipo, id) dejaría de servir el ORDER BY cuando no se filtra
-- por tipo — no vale la complejidad hasta que el volumen real lo pida).
DROP INDEX IF EXISTS idx_ipercs_tenant;
CREATE INDEX IF NOT EXISTS idx_ipercs_tenant_id ON ipercs(tenant_id, id);

-- ── 2a) FK hacia tablas que SÍ se borran con DELETE real, sin CASCADE —
--        columna FK liderando, para que el chequeo del constraint no haga
--        Seq Scan sobre la tabla hija cuando se borra el padre ──────────

-- checklists.plantilla_id → checklist_plantillas(id), sin CASCADE.
-- ChecklistsRepository.eliminarPlantilla hace DELETE real.
CREATE INDEX IF NOT EXISTS idx_checklists_plantilla ON checklists(plantilla_id);

-- ipercs.equipo_id → equipos(id), sin CASCADE (nullable).
-- EquiposRepository.delete hace DELETE real.
CREATE INDEX IF NOT EXISTS idx_ipercs_equipo ON ipercs(equipo_id) WHERE equipo_id IS NOT NULL;

-- ipercs.linea_base_id → iperc_lineas_base(id), sin CASCADE (nullable).
-- IpercRepository.eliminarLineaBase hace DELETE real.
CREATE INDEX IF NOT EXISTS idx_ipercs_linea_base ON ipercs(linea_base_id) WHERE linea_base_id IS NOT NULL;

-- iperc_items.linea_base_item_id → iperc_linea_base_items(id), sin CASCADE
-- (nullable). No se borra directo, pero SÍ se borra en cascada cuando se
-- elimina la línea base padre (iperc_linea_base_items tiene ON DELETE
-- CASCADE desde iperc_lineas_base) — ese borrado en cascada dispara el
-- mismo chequeo de constraint contra iperc_items, fila por fila.
CREATE INDEX IF NOT EXISTS idx_iperc_items_linea_base_item ON iperc_items(linea_base_item_id) WHERE linea_base_item_id IS NOT NULL;

-- ── 2b) FK hacia usuarios (nunca se borra de verdad) — compuestos con
--        tenant_id liderando, para servir una futura query de aplicación
--        filtrada por tenant, no un chequeo de constraint ──────────────

CREATE INDEX IF NOT EXISTS idx_checklists_tenant_usuario ON checklists(tenant_id, usuario_id);
CREATE INDEX IF NOT EXISTS idx_ipercs_tenant_usuario ON ipercs(tenant_id, usuario_id);
CREATE INDEX IF NOT EXISTS idx_ipercs_tenant_aprobado_por ON ipercs(tenant_id, aprobado_por) WHERE aprobado_por IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iperc_lineas_base_tenant_creado_por ON iperc_lineas_base(tenant_id, creado_por);
CREATE INDEX IF NOT EXISTS idx_iperc_lineas_base_tenant_aprobado_por ON iperc_lineas_base(tenant_id, aprobado_por) WHERE aprobado_por IS NOT NULL;

-- ── 3) Dos gaps fuera de "los 7 módulos" que salieron a la luz al correr
--        tests/db-index-coverage.test.ts contra pg_catalog en vez de
--        confiar en una revisión manual — se corrigen acá mismo en vez de
--        dejarlos para después, ya que son igual de baratos que el resto ──

-- reset_tokens.tenant_id → tenants(id), sin CASCADE (migrations/0011). Sin
-- índice, borrar un tenant (tests/helpers.ts lo hace de verdad al limpiar
-- tenants de prueba) forzaba Seq Scan sobre reset_tokens para el chequeo
-- del constraint.
CREATE INDEX IF NOT EXISTS idx_reset_tokens_tenant ON reset_tokens(tenant_id);

-- platform_audit_log.usuario_id → usuarios(id) ON DELETE SET NULL
-- (migrations/0012). Se dispara de verdad en tests/helpers.ts al borrar un
-- usuario de prueba — sin índice, cada borrado escaneaba
-- platform_audit_log entera para encontrar las filas a poner en NULL.
CREATE INDEX IF NOT EXISTS idx_platform_audit_log_usuario ON platform_audit_log(usuario_id) WHERE usuario_id IS NOT NULL;
