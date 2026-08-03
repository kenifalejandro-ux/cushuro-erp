/** tests/db-index-coverage.test.ts
 *
 * Parte de la auditoría de indexación multi-tenant
 * (docs/architecture/database-performance-guidelines.md, migración 0031):
 * antes de esta migración, varias FK (ipercs.equipo_id,
 * ipercs.linea_base_id, checklists.plantilla_id, iperc_items.linea_base_item_id)
 * no tenían ningún índice — un DELETE real sobre la tabla padre (equipos,
 * checklist_plantillas, iperc_lineas_base) forzaba a Postgres a hacer Seq
 * Scan sobre la tabla hija completa para validar el constraint. Nada
 * fallaba para avisarlo.
 *
 * Este test recorre pg_catalog directamente (no una lista mantenida a
 * mano, mismo criterio que tests/rls-coverage.test.ts) y falla si:
 *   1) una columna de Foreign Key no tiene NINGÚN índice que la incluya
 *      (en cualquier posición — ver database-performance-guidelines.md
 *      sobre cuándo debe liderar la FK vs. cuándo debe liderar tenant_id).
 *   2) una columna tenant_id no tiene ningún índice que la incluya.
 *
 * No verifica CUÁL debería ser la columna líder de cada índice — esa es
 * una decisión de diseño caso por caso (ver el ADR y los comentarios de
 * la migración 0031), no algo que un test genérico deba imponer.
 */
import { describe, it, expect, afterAll } from "vitest";
import { pool, closeDatabase } from "../src/server/config/database";

// Tablas de plataforma sin RLS (mismo criterio que rls-coverage.test.ts)
// cuyas FK no son parte del alcance de "los 7 módulos" — se excluyen a
// propósito de este audit, no por descuido.
const TABLAS_EXCLUIDAS = new Set(["schema_migrations"]);

interface FilaColumnaSinIndice {
  tabla: string;
  columna: string;
  motivo: "foreign_key" | "tenant_id";
}

describe("cobertura de índices: toda FK y toda columna tenant_id debe estar indexada", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("no hay columnas de FK ni de tenant_id sin ningún índice que las cubra", async () => {
    const result = await pool.query<FilaColumnaSinIndice>(`
      WITH fks AS (
        SELECT tc.table_name AS tabla, kcu.column_name AS columna, 'foreign_key'::text AS motivo
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      ),
      tenant_cols AS (
        SELECT table_name AS tabla, column_name AS columna, 'tenant_id'::text AS motivo
        FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'tenant_id'
      ),
      columnas_a_verificar AS (
        SELECT * FROM fks
        UNION
        SELECT * FROM tenant_cols
      ),
      columnas_indexadas AS (
        SELECT t.relname AS tabla, a.attname AS columna
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        WHERE n.nspname = 'public'
      )
      SELECT cv.tabla, cv.columna, cv.motivo
      FROM columnas_a_verificar cv
      WHERE NOT EXISTS (
        SELECT 1 FROM columnas_indexadas ci WHERE ci.tabla = cv.tabla AND ci.columna = cv.columna
      )
      ORDER BY cv.tabla, cv.columna
    `);

    const sinIndice = result.rows.filter((fila) => !TABLAS_EXCLUIDAS.has(fila.tabla));

    expect(
      sinIndice,
      `Columnas de FK/tenant_id sin ningún índice que las cubra:\n` +
        JSON.stringify(sinIndice, null, 2) +
        `\nAgregar un índice (ver docs/architecture/database-performance-guidelines.md para decidir qué columna debe liderar) o, si es intencional, sumar la tabla a TABLAS_EXCLUIDAS con el motivo.`
    ).toEqual([]);
  });
});
