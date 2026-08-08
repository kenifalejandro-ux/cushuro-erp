# Guía de rendimiento de base de datos (RLS + multi-tenant)

- **Estado**: vigente desde la auditoría de indexación de 2026-08-03 (migración `0031_optimize_tenant_indexes.sql`).
- **Relacionado**: [ADR-0001](../adr/0001-multi-tenancy-plataforma.md) (RLS, aislamiento), [ADR-0002](../adr/0002-contrato-de-modulo.md) (contrato de módulo — el paso 1 de su checklist de "nuevo módulo" apunta acá).

Esta guía documenta cómo escribir queries y migraciones sobre tablas con Row-Level Security sin pagar el costo de rendimiento que un `WHERE`/policy mal escrito puede esconder. No es teoría: cada sección viene de auditar el código real de MinCore ERP, no de una lista genérica de buenas prácticas de Postgres.

---

## 1. RLS y uso de índices: el patrón correcto (y por qué ya se sigue bien)

Toda policy de este proyecto tiene esta forma exacta (ver `migrations/0005`, `0006`, `0007`, `0010`):

```sql
CREATE POLICY tenant_isolation ON <tabla>
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

**El cast (`::uuid`) está del lado de `current_setting(...)`, nunca del lado de la columna `tenant_id`.** Esto importa: si la policy comparara `tenant_id::text = current_setting('app.tenant_id')`, cualquier índice sobre `tenant_id` dejaría de servir para esa comparación — Postgres no puede usar un índice de `uuid` para resolver una igualdad calculada sobre `tenant_id::text`, salvo que exista un índice de expresión aparte. Auditado: **las 8 tablas con RLS de este proyecto siguen el patrón correcto**, sin excepciones.

**Regla para cualquier policy nueva**: el cast siempre va sobre el valor de sesión (`current_setting(...)`), nunca sobre la columna de la tabla.

## 2. Mantené el filtro explícito de `tenant_id` en la query, aunque RLS ya lo fuerce

Todos los repositorios de este proyecto hacen esto (ejemplo real, `equipos.repository.ts`):

```sql
SELECT id, placa_codigo, ... FROM equipos WHERE tenant_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3
```

RLS ya agrega `AND tenant_id = current_setting('app.tenant_id')::uuid` a esta query sola, sin que el código lo pida. **Aun así, seguí escribiendo el filtro explícito.** Dos razones, no una sola:

1. **Optimización del planner**: cuando la query trae su propio literal/parámetro (`$1`) además de la condición de RLS, Postgres puede usar el valor concreto del parámetro para decidir el plan (ej. cardinalidad estimada, elegir el índice compuesto correcto) de una forma que a veces no logra igual de bien con solo la expresión de la policy. En la práctica, con las dos condiciones (la explícita y la de RLS) terminan siendo redundantes y el optimizador colapsa una en la otra — pero no hay que asumirlo a ciegas: la explícita es la garantía barata.
2. **Nunca depender de RLS como única defensa dentro del código de la app.** Si algún día una tabla pierde su policy por error humano (una migración mal escrita, un `NO FORCE ROW LEVEL SECURITY` accidental), el filtro explícito sigue aislando tenants aunque RLS haya fallado. `tests/rls-coverage.test.ts` (ver ADR-0002) protege contra ese error, pero dos capas de defensa es mejor que una.

## 3. Orden de columnas en un índice compuesto: depende de qué escaneo tiene que servir

Esta es la decisión que más se repite al auditar índices, y no tiene una sola respuesta. Dos casos, con ejemplos reales de `migrations/0031`:

### Caso A — la columna que lidera es `tenant_id`

Sirve para: **cualquier query de aplicación**, porque el 100% de las queries de este código filtran por tenant primero. También cubre el `ORDER BY` si se agrega como segunda columna, evitando un nodo `Sort` aparte.

```sql
-- equipos.repository: WHERE tenant_id = $1 ORDER BY id DESC LIMIT/OFFSET
CREATE INDEX idx_equipos_tenant_id ON equipos(tenant_id, id);
```

Usalo para: listados paginados (`(tenant_id, id)`), filtros por estado/fecha dentro de un tenant (`(tenant_id, fecha_vencimiento)`), y cualquier FK hacia una tabla que **nunca se borra de verdad** (en este proyecto, `usuarios` — "eliminar" siempre es desactivar).

### Caso B — la columna que lidera es la FK, no `tenant_id`

Sirve para: el chequeo interno que hace Postgres al `DELETE` de una fila que otra tabla referencia por FK **sin `ON DELETE CASCADE`**. Ese chequeo es `SELECT 1 FROM <tabla_hija> WHERE <columna_fk> = $1` — sin filtro de tenant, porque el motor de FK no sabe nada de multi-tenancy. Un índice `(tenant_id, columna_fk)` **no sirve** para esa query (la columna que el chequeo busca no es la primera del índice); hace falta que la FK lidere.

```sql
-- equipos SÍ se borra con DELETE real (equipos.repository.ts) y
-- ipercs.equipo_id la referencia sin CASCADE → sin este índice, borrar un
-- equipo con IPERC asociados hacía Seq Scan sobre toda la tabla ipercs.
CREATE INDEX idx_ipercs_equipo ON ipercs(equipo_id) WHERE equipo_id IS NOT NULL;
```

**Cómo decidir cuál es, en la práctica**: preguntate "¿esta tabla padre alguna vez recibe un `DELETE FROM` real (no un `activo = false`)?". Si sí, y la FK no tiene `ON DELETE CASCADE`, necesita un índice con la FK liderando. Si no (la única forma de "borrar" es desactivar, como con `usuarios`), un compuesto `(tenant_id, columna_fk)` alcanza y es más útil para el día a día.

## 4. Checklist de índices para una tabla nueva

Ver también el paso 1 del checklist de "Nuevo Módulo" en el ADR-0002. Al escribir la migración de una tabla nueva:

- [ ] `tenant_id UUID NOT NULL REFERENCES tenants(id)` + bloque RLS (`ENABLE`/`FORCE ROW LEVEL SECURITY` + policy `tenant_isolation`).
- [ ] Si la tabla se lista paginada (`ORDER BY <columna> LIMIT/OFFSET`, el patrón de todos los `findAll`), un índice `(tenant_id, <columna de orden>)` — no uno simple de `tenant_id` solo, que deja el `ORDER BY` sin cubrir.
- [ ] Cada columna de FK: decidir Caso A o Caso B (sección 3) y crear el índice correspondiente.
- [ ] Correr `npx vitest run tests/db-index-coverage.test.ts tests/rls-coverage.test.ts` antes de dar la migración por terminada — ambos fallan ruidoso si algo quedó sin cubrir.

## 5. Anti-patrones auditados en este código (y el resultado)

Se revisaron los `*.controller.ts`/`*.service.ts`/`*.repository.ts` de los 7 módulos buscando específicamente los patrones que rompen el uso de índices bajo RLS:

| Anti-patrón                                                                                                                | ¿Se encontró en este código?                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cast sobre la columna en vez del valor de sesión en una policy (`tenant_id::text = ...`)                                   | No — las 8 policies existentes castean el lado de `current_setting`, nunca la columna (sección 1).                                                                                                                                                                                                                                                                                       |
| Función no inmutable envolviendo la columna indexada en un `WHERE` (ej. `WHERE lower(email) = $1` sin índice de expresión) | No — `email` siempre llega normalizado a minúsculas desde Zod (`.toLowerCase()`) antes de tocar la base; la comparación en SQL es directa contra la columna.                                                                                                                                                                                                                             |
| Comparar un UUID contra un parámetro sin tipar, forzando un cast implícito costoso                                         | No — todas las queries parametrizadas (`$1`, `$2`, ...) dejan que Postgres infiera el tipo desde la columna comparada; no hay concatenación de strings armando SQL con valores sin tipar.                                                                                                                                                                                                |
| `SELECT *` sobre tablas anchas donde solo se necesitan 2-3 columnas                                                        | Parcial — algunas queries de auditoría (`platform_audit_log`) traen filas completas; aceptable ahí por ser listados de bajo volumen paginados con cursor, no goza de la misma prioridad que los listados de los 7 módulos. No se tocó en esta ronda.                                                                                                                                     |
| Índices con la columna FK en la posición equivocada para el chequeo de `DELETE` que realmente ocurre                       | **Sí, encontrado y corregido** — ver `migrations/0031`: `ipercs.equipo_id`, `ipercs.linea_base_id`, `checklists.plantilla_id`, `iperc_items.linea_base_item_id`, `reset_tokens.tenant_id` y `platform_audit_log.usuario_id` no tenían ningún índice. Un `DELETE` real sobre la tabla padre correspondiente forzaba un Seq Scan completo de la tabla hija para el chequeo del constraint. |
| Índice simple de `tenant_id` sin cubrir el `ORDER BY` del listado paginado (obliga a un `Sort` aparte en cada página)      | **Sí, encontrado y corregido** — los 7 índices `idx_<tabla>_tenant` originales se reemplazaron por compuestos `(tenant_id, <columna de orden>)` (sección 3, Caso A). Verificado con `EXPLAIN ANALYZE` contra una tabla con 200k+ filas de "ruido" de otro tenant: el plan pasó de `Seq Scan` + `Sort` a `Index Only Scan Backward`, sin nodo de Sort.                                    |

## 6. Paginación con `COUNT(*) OVER()`: no es un problema de índices, pero sí de escala

Todos los `findAll` paginados usan `COUNT(*) OVER()` para devolver el total de filas junto con la página pedida (`armarRespuestaPaginada`). Con el índice correcto (sección 3), esto es barato porque Postgres puede resolver el conteo con un **Index Only Scan** sin tocar el heap — pero sigue significando "contar todas las filas que matchean el filtro", no solo las 50 que se muestran. Con miles de filas por tenant esto es instantáneo; si algún tenant llega a cientos de miles de filas en una sola tabla, el conteo exacto empieza a pesar más que el resto de la query junta.

**No se cambió nada de esto en esta ronda** — a la escala actual (piloto único) no hace falta, y cambiarlo es un rediseño de la API de paginación (dejar de devolver `totalPages` exacto, o pasar a paginación por cursor/keyset), no una migración de índices. Queda anotado para cuando el volumen real lo justifique.

## 7. Locking: por qué la migración 0031 no usa `CREATE INDEX CONCURRENTLY`

`CREATE INDEX` sin `CONCURRENTLY` toma un lock `SHARE` que **bloquea escrituras** (`INSERT`/`UPDATE`/`DELETE`, no lecturas) sobre la tabla mientras dura la construcción del índice — proporcional al tamaño de la tabla. `CONCURRENTLY` evita ese bloqueo a costa de tardar más y no poder correr dentro de una transacción.

`src/server/config/migrate.ts` manda el contenido completo de cada archivo `.sql` como un solo mensaje al driver (`client.query(sql)`). Cuando ese mensaje trae más de un statement, Postgres lo envuelve en una transacción implícita — y `CREATE INDEX CONCURRENTLY` **no puede correr dentro de una transacción**, tenga o no un `BEGIN` explícito el archivo. Por eso `migrations/0031` (que trae ~20 statements en un solo archivo) usa `CREATE INDEX IF NOT EXISTS` normal, igual que el resto de las migraciones de este proyecto.

A la escala actual (piloto único, tablas de bajo volumen) el lock dura milisegundos — verificado en la propia migración. **Cuando una tabla crezca lo suficiente para que este lock importe**, el procedimiento correcto es correrlo a mano, fuera de `migrate.ts`, con cada índice en su propio comando (nunca varios `CONCURRENTLY` juntos en la misma sesión):

```sql
-- Uno por uno, cada CREATE INDEX CONCURRENTLY en su propia conexión/sesión,
-- NUNCA dentro de BEGIN...COMMIT ni junto a otro CREATE INDEX CONCURRENTLY:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ejemplo ON tabla(columna);

-- Si algo falla a mitad de camino, CONCURRENTLY puede dejar un índice
-- INVALID — se detecta así y se limpia antes de reintentar:
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
DROP INDEX CONCURRENTLY IF EXISTS idx_ejemplo;
```

Después de correrlo a mano contra producción, agregar el `filename` correspondiente a `schema_migrations` manualmente (o una migración vacía que documente que ya se aplicó fuera de banda) para que `migrate.ts` no intente repetirlo.

## 8. Diagnóstico de queries pesadas

`npm run diagnose:queries` (ver `scripts/diagnosticoQueries.ts`) corre en dos modos:

1. **`pg_stat_statements`**, si está instalada — el diagnóstico real de producción (qué se ejecutó, cuánto tiempo acumulado). Requiere `shared_preload_libraries` a nivel de servidor + reinicio + `CREATE EXTENSION` como superuser; el rol de la app no puede autoinstalarla (a propósito, ver `.env.example`). El script imprime los pasos exactos si no está disponible.
2. **`EXPLAIN ANALYZE`** contra las queries reales de los 7 módulos, usando `withTenant()` igual que la app — corre siempre, sin depender de ninguna extensión. Marca con `⚠` cualquier plan con `Seq Scan`.

**Importante al leer la salida del modo 2**: con pocas filas, un `Seq Scan` es el plan _correcto_ — el planner de Postgres no usa un índice si escanear la tabla entera es más barato, y con pocas filas casi siempre lo es. Un `⚠` en este script solo es una señal real de problema cuando el tenant usado tiene volumen de datos comparable al de producción. `tests/db-index-coverage.test.ts` (índices faltantes) y este script (planes reales) son complementarios, no intercambiables — uno audita estructura, el otro comportamiento.

`npx tsx scripts/diagnosticoQueries.ts --tenant=<slug> --top=<n>` para apuntar a un tenant puntual (por defecto usa el más antiguo) y ajustar cuántas filas trae del modo 1.
