-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: el nivel del tanque deja de guardarse y pasa a derivarse
--
-- El problema de fondo: el nivel vivía en DOS lugares -- la columna
-- `combustible.nivel_actual` y el historial `combustible_lecturas`. Mantener
-- las dos copias en sincronía dependía de un UPDATE condicional
-- (`WHERE fecha_actualizacion < <leido_en de la lectura nueva>`) que fallaba
-- EN SILENCIO en tres casos reales:
--
--   1. Dos lecturas dentro del mismo minuto: el input `datetime-local` del
--      formulario recorta a minutos, así que la segunda tiene el mismo
--      `leido_en` que la primera y la condición `<` no se cumple.
--   2. Una lectura registrada apenas después de crear el tanque: el tanque
--      nace con `fecha_actualizacion = NOW()` (con segundos) y la lectura
--      llega truncada al minuto, o sea ANTES.
--   3. Una corrección cargada con la hora real de la medición, anterior a
--      la última lectura ya aplicada.
--
-- En los tres el usuario ve éxito, el modal se cierra, y el número no
-- cambia. Sin error, sin aviso.
--
-- El arreglo no es sincronizar mejor las dos copias: es que haya UNA sola.
-- El nivel pasa a ser, por definición, "la última lectura vigente" -- se
-- calcula al leer (ver COLUMNAS_TANQUE en combustible.repository.ts). Así el
-- desfase deja de ser un bug a evitar y pasa a ser imposible.
--
-- El costo es despreciable acá: los tanques son unos pocos por tenant y el
-- índice que necesita la consulta ya existe
-- (idx_combustible_lecturas_vigentes, migración 0058).
--
-- EJECUTAR (después de 0058):
--   psql -d mincoreerp -f migrations/0059_combustible_nivel_derivado.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Backfill: que no se pierda ningún nivel al borrar las columnas ───────
--
-- Un tanque creado por `POST /combustible` (Fase A) recibe un nivel inicial
-- pero NO genera ninguna lectura -- ese número solo existe en la columna que
-- estamos por borrar. Se le crea su lectura `inicial` para que quede en el
-- historial, que a partir de ahora es la única fuente.
--
-- Solo para tanques SIN ninguna lectura. Los que ya tienen historial no se
-- tocan a propósito: ahí la fuente de verdad son sus lecturas, y si el
-- `nivel_actual` guardado no coincidía con la última (justamente por el bug
-- de arriba), el valor bueno es el de la lectura, no el de la caché.
--
-- Toca filas de TODOS los tenants a la vez, sin un `app.tenant_id` de sesión
-- que fijar -- mismo escenario y mismo remedio que el backfill de 0045.
ALTER TABLE combustible NO FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible_lecturas NO FORCE ROW LEVEL SECURITY;

INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
SELECT c.tenant_id, c.id, c.nivel_actual, c.fecha_actualizacion, 'inicial'
FROM combustible c
WHERE NOT EXISTS (
  SELECT 1 FROM combustible_lecturas l WHERE l.combustible_id = c.id
);

ALTER TABLE combustible_lecturas FORCE ROW LEVEL SECURITY;
ALTER TABLE combustible FORCE ROW LEVEL SECURITY;

-- ── Se van las columnas ──────────────────────────────────────────────────
--
-- Se BORRAN en vez de dejarlas sin uso: una columna que nadie actualiza pero
-- que sigue ahí es una trampa -- cualquiera que consulte la tabla directo
-- (un reporte, un script de soporte) leería un número viejo creyéndolo
-- vigente. Mejor que no exista.
--
-- La API sigue devolviendo `nivel_actual` y `fecha_actualizacion` como
-- campos calculados, así que el contrato con el cliente no cambia.
--
-- Los backups YA TOMADOS contienen estas columnas, y `restaurarTablas()`
-- arma el INSERT con las claves que vengan en el JSON -- restaurar uno viejo
-- después de esta migración fallaría con "column does not exist". Por eso
-- las dos quedan declaradas en `columnasExcluidasAlRestaurar` en
-- modules/registry.ts (mismo mecanismo que usa iperc para `nivel_riesgo`).
ALTER TABLE combustible
  DROP COLUMN nivel_actual,
  DROP COLUMN fecha_actualizacion;
