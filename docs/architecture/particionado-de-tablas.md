# Particionado declarativo: checklists e ipercs

- **Estado**: vigente desde 2026-08-04 (migración `0037_particionado_tablas.sql`).
- **Relacionado**: [database-performance-guidelines.md](database-performance-guidelines.md) (RLS + índices), [cuotas-por-tenant.md](cuotas-por-tenant.md) (la cuota de 200.000 filas/tenant es lo que hace a estas dos tablas candidatas reales), `tests/partitioning.test.ts`.

---

## Por qué estas dos tablas, y no otras

De las tablas del ERP, `checklists` e `ipercs` son las únicas sin techo natural: se cuenta un checklist por equipo/turno y un IPERC por frente/turno, y su cuota por tenant es 200.000 filas — muy por encima de `equipos` (2.000) o cualquier catálogo de configuración. `tenant_metricas_horarias`, aunque a veces se la menciona en la misma conversación, **no** se particiona: su propia migración (`0022`) la diseñó explícitamente acotada (`tenants × horas`, nunca `tenants × requests`) — particionarla resolvería un problema que no tiene.

Con el volumen real de hoy (piloto, un puñado de tenants) esto no hacía falta todavía — quedó documentado así antes de implementarlo. Se implementó igual, de forma completa, porque así se decidió priorizarlo.

## La clave de partición: `RANGE (creado_en)` por mes

Postgres exige que la clave de partición sea parte de cualquier `PRIMARY KEY`/`UNIQUE` de la tabla particionada. Por eso `checklists`/`ipercs` pasan de PK simple (`id`) a compuesta (`id, creado_en`) — el `id` se sigue generando de la misma secuencia `SERIAL` de siempre (reasignada a la tabla nueva), así que en la práctica nunca colisiona entre particiones.

Particiones: una por mes (`checklists_2026_08`, `checklists_2026_09`, ...) más una partición `DEFAULT` (`checklists_default`) que atrapa cualquier fila fuera del rango explícito — necesaria porque, al aplicar la migración, puede existir data histórica más vieja que "el mes actual".

## Cascada hacia `checklist_items` / `iperc_items`

Toda FK que apunte a una tabla particionada tiene que incluir la clave de partición del lado referenciado — `checklist_id` solo ya no alcanza. Por eso:

- `checklist_items` gana la columna `checklist_creado_en`, y su FK pasa a ser compuesta: `FOREIGN KEY (checklist_id, checklist_creado_en) REFERENCES checklists(id, creado_en) ON DELETE CASCADE`.
- Mismo caso para `iperc_items` / `iperc_creado_en` → `ipercs(id, creado_en)`.

`checklists.repository.ts` / `iperc.repository.ts` mandan ese valor al insertar el ítem — ya lo tenían a mano por el `RETURNING creado_en` del `INSERT` del padre, sin query extra.

### El bug de precisión que esto destapó (y por qué `creado_en` es `TIMESTAMPTZ(3)`)

Detectado corriendo el flujo real, no en el papel: `node-postgres` representa `timestamptz` como `Date` de JS, que solo tiene precisión de **milisegundos** — un `TIMESTAMPTZ` de Postgres guarda **microsegundos**. El valor de `creado_en` que vuelve del `RETURNING` del padre, al mandarse de vuelta como parámetro del `INSERT` del hijo, llega truncado a milisegundos — mientras el padre guardó microsegundos completos. Resultado: la FK compuesta nunca matcheaba, y todo `INSERT` de un ítem fallaba con `violates foreign key constraint`.

La solución no es evitar mandar el valor de vuelta (reescribiría el shape de cada `INSERT` en un `SELECT ... FROM padre`, mucho más invasivo) sino declarar `checklists.creado_en` / `ipercs.creado_en` como `TIMESTAMPTZ(3)` desde la creación de la tabla: Postgres redondea a milisegundos **al guardar** en el padre, así que el valor que después viaja como `Date` de JS y vuelve ya es exactamente el mismo, sin pérdida adicional en el camino de vuelta. No se puede arreglar después con un `ALTER COLUMN TYPE` — Postgres lo rechaza porque `creado_en` es parte de la clave de partición.

## RLS: el hallazgo no obvio de esta migración

Verificado a mano, no asumido: **habilitar RLS en la tabla particionada padre no alcanza**. Si algo consulta la partición física por su nombre (`checklists_2026_08` en vez de `checklists`), Postgres **no** hereda la policy del padre — devuelve todas las filas de esa partición, de cualquier tenant, incluso sin `app.tenant_id` seteado:

```sql
-- Con RLS+policy SOLO en el padre:
SELECT count(*) FROM checklists_2026_08;        -- 0 filas del tenant correcto vía el padre
SELECT count(*) FROM checklists_2026_08 WHERE …  -- TODAS las filas, de cualquier tenant, consultando la partición directo
```

La única forma correcta es habilitar `ENABLE`/`FORCE ROW LEVEL SECURITY` + crear la **misma** policy `tenant_isolation` en **cada partición individualmente**, no solo en el padre. Esto está centralizado en una única función SQL (`particion_rls_asegurar(text)`, ver la migración) para que no haya dos lugares donde ese paso pueda divergir — la usan tanto la migración inicial como el worker de aprovisionamiento continuo.

En la práctica, el código de la app nunca consulta una partición por su nombre físico (siempre usa `checklists`/`ipercs`), así que esto no es una vulnerabilidad explotable desde la API hoy — es una defensa en profundidad para cualquier script de diagnóstico, migración futura, o acceso directo a la base que alguien escriba sin saber esto.

## Aprovisionamiento de particiones

**Inicial** (dentro de la migración 0037): mes actual + 3 meses futuros, para ambas tablas.

**Continuo**: `src/server/services/particionado.worker.ts` corre una vez al día (`PARTICIONES_CHECK_INTERVAL_MS`, default 24h) y llama a `SELECT particiones_asegurar_futuras($PARTICIONES_MESES_ADELANTE)` (default 3 meses de margen). La función SQL es la misma que usó la migración inicial — mismo motivo que con RLS: que la creación inicial y las corridas periódicas nunca puedan divergir en cómo se arma una partición.

Idempotente: `CREATE TABLE IF NOT EXISTS ... PARTITION OF` no falla si la partición ya existe, así que correr la función de más (el worker, una migración futura que la vuelva a llamar) nunca duplica ni rompe nada.

Agregar una tabla nueva a este esquema es una línea: el array hardcodeado dentro de `particiones_asegurar_futuras()` (`ARRAY['checklists', 'ipercs']`), no una lista mantenida aparte.

## Partition pruning: cuándo ayuda hoy, y cuándo no

Postgres poda particiones cuando la condición del `WHERE` acota `creado_en` con límite inferior **y** superior:

```sql
-- Poda: solo toca la partición del mes actual (verificado con EXPLAIN)
WHERE tenant_id = $1
  AND creado_en >= date_trunc('month', now())
  AND creado_en < date_trunc('month', now()) + interval '1 month'
```

Los endpoints actuales (`findAll`, `findById` de ambos módulos) **no filtran por fecha** — listan por `tenant_id` con `ORDER BY id DESC LIMIT/OFFSET`, así que hoy no se benefician de pruning (escanean todas las particiones del tenant, más la `default`). El particionado no acelera nada todavía por sí solo: lo que da es la posibilidad de vaciar/archivar meses viejos baratísimo (`DETACH PARTITION` en vez de un `DELETE` masivo) el día que haga falta retención, y la base para que un futuro endpoint de reporte "por rango de fecha" sí pode de verdad. Ver `tests/partitioning.test.ts` para la verificación con `EXPLAIN` real.

## Tests

`tests/partitioning.test.ts` cubre:

- `checklists`/`ipercs` son `relkind = 'p'`, con las particiones esperadas (mes actual + futuras + `default`).
- `particiones_asegurar_futuras()` es idempotente, y con más margen crea la partición nueva con su propio RLS.
- Un checklist creado por la API real cae en la partición del mes correcto, y `checklist_creado_en` del ítem coincide exactamente con `creado_en` del padre (el bug de precisión no reaparece).
- Partition pruning real con `EXPLAIN`: un rango acotado al mes actual no toca ninguna otra partición.
- RLS aísla tenants incluso consultando la partición física directo por su nombre (el hallazgo de arriba, verificado, no solo documentado).
- `DELETE` en el padre cascadea al hijo vía la FK compuesta.

`tests/rls-coverage.test.ts` y `tests/db-index-coverage.test.ts` (auditorías genéricas sobre `pg_class`/`information_schema`) no necesitaron ningún cambio: al particionar, cada partición pasa a ser su propia fila `relkind='r'`, y ambos tests las auditan automáticamente igual que auditarían cualquier tabla nueva.
