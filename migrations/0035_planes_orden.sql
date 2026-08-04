-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: orden explícito de los planes
--
-- El selector del panel los listaba por nombre, o sea alfabéticamente:
-- Corporativo, Mediana, MYPE, Pequeña. Para elegir un plan ese orden está
-- mal — se esperan de menor a mayor, y que el más grande aparezca primero
-- invita a asignar el equivocado.
--
-- Hace falta una columna: por nombre queda alfabético, y por algún límite
-- tampoco sirve (Corporativo los tiene en NULL = ilimitado, que ordenaría
-- como ausencia en vez de como "el más grande"). El orden de creación
-- funcionaría por casualidad hoy —se sembraron en orden de tamaño— pero se
-- rompería con el primer plan que se agregue después.
--
-- Se numera de a 10 para poder intercalar un plan entre dos existentes sin
-- renumerar los demás.
--
-- EJECUTAR (después de 0034):
--   psql -d mincoreerp -f migrations/0035_planes_orden.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE planes ADD COLUMN IF NOT EXISTS orden INTEGER NOT NULL DEFAULT 100;

UPDATE planes SET orden = 10 WHERE codigo = 'mype';
UPDATE planes SET orden = 20 WHERE codigo = 'pequena';
UPDATE planes SET orden = 30 WHERE codigo = 'mediana';
UPDATE planes SET orden = 40 WHERE codigo = 'corporativo';
