# Escalabilidad preventiva

- **Estado**: vigente desde 2026-08-04.
- **Relacionado**: [cuotas por tenant](cuotas-por-tenant.md), [particionado de tablas](particionado-de-tablas.md), [backups en S3](backups-s3.md).

---

## Por qué esto, y por qué ahora

Con la infraestructura base terminada, esto es lo que hay que resolver en código **antes** de que el volumen real lo exija: consultas repetidas de cuotas en cada request, paginación que se cae con tablas grandes, y workers que se pisan entre sí si algún día hay más de una instancia del server corriendo. Ninguno de estos puntos es urgente hoy — es la lista de qué revisar primero cuando empiece a serlo.

Fuera de alcance de este documento (fase de escala real, para cuando haya tráfico/concurrencia real): réplicas de lectura de Postgres, Redis en alta disponibilidad, y el ajuste fino de tamaños de pool y caches.

---

## 1. Cache corto de cuotas y planes

`resolverLimite()` (`platformCuotas.service.ts`) resuelve el límite efectivo de un recurso con tres niveles de precedencia — override del tenant → plan → default del registry (ver [cuotas por tenant](cuotas-por-tenant.md)). Corre en **cada POST** de cualquier módulo (vía `requireCuota`), así que sin cache es una query a Postgres por cada creación de un recurso, en el camino más caliente que tiene el ERP.

### La estrategia: Redis con TTL corto + fallback en memoria

Mismo patrón que ya usaba `platformRateLimitCuota.ts` para el rate limiting, reusado acá:

```
resolverLimite(tenantId, recurso)
  → ¿está en Redis?           → sí: devolver (case común, un solo GET)
  → ¿Redis no disponible?     → memoria local, TTL más corto (30s)
  → ninguna de las dos        → Postgres, y se cachea el resultado
```

- **TTL en Redis: 300s.** **TTL en memoria: 30s**, deliberadamente más corto — sin Redis, la invalidación explícita (ver abajo) no se propaga entre instancias, así que la única garantía de frescura es que el valor caduque pronto.
- **Por qué Redis y no memoria como caché principal**: con más de una instancia, un caché en memoria resolvería cada una su propio valor sin que la invalidación cruce entre ellas — cambiás un límite en el panel y una instancia lo respeta, la otra no. En Redis se resuelve solo.
- **Qué NO se cachea: `usoActual()`.** El _límite_ configurado cambia poco (solo cuando un admin toca `tenant_cuotas` o reasigna un plan); el _uso_ cambia con cada INSERT del propio tenant. Cachear el uso rompería la cuota — un tenant podría crear de más mientras el conteo cacheado queda viejo. El límite es la parte estable; el uso siempre se lee fresco.

### Invalidación

Dos puntos de escritura, dos invalidaciones:

| Se cambia                                          | Se invalida                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Un override puntual (`fijarCuotaTenant`)           | Solo ese `(tenant, recurso)`                                                                     |
| El plan de un tenant (`asignarPlanATenantService`) | **Todo** el catálogo de ese tenant — cambia el nivel 2 de todos los recursos sin override propio |

`invalidarCacheLimitesTenant()` recorre `recursosConCuota()` (finito, ya vive en proceso) e invalida cada `(tenant, recurso)` uno por uno — no hace falta un `SCAN` sobre Redis, que sí sería un problema en producción.

**Regla para cualquier código nuevo que toque `tenant_cuotas` o `tenants.plan_id` directo (una migración de datos, un script, un fix a mano):** eso bypassea las invalidaciones de arriba. Hay que invalidar a mano, con `invalidarCacheLimite()`/`invalidarCacheLimitesTenant()` — los tests que hacen `UPDATE` directo a esas tablas ya siguen esta regla (ver `tests/tenant-cuotas.test.ts`, `tests/tenant-planes.test.ts`).

### Por qué NO hay un cache de "módulos habilitados"

Es lo primero que uno pensaría cachear junto con las cuotas, y resulta que **ya no hace falta**: `modulosPermitidos` (qué módulos puede ver un usuario) se resuelve **una sola vez**, al login o al refresh del token, y queda embebido en el JWT (`obtenerModulosPermitidos()` en `auth.service.ts`). `requireModulo()` solo lee el payload del token — cero queries por request.

La contrapartida, ya documentada donde se define el campo: un cambio de módulos hecho desde el panel de plataforma tarda hasta el próximo login/refresh en reflejarse. Es una decisión ya tomada, no un vacío — agregar un cache ahí sería resolver un problema que no existe, a costa de sumar una fuente más de inconsistencia.

---

## 2. Paginación por cursor (keyset) en checklists e IPERC

`checklists` e `ipercs` (los registros llenados, no las plantillas/líneas base — esas son catálogo, acotado) son las **dos únicas tablas particionadas** (ver [particionado de tablas](particionado-de-tablas.md)), y las que de verdad pueden crecer sin techo natural por tenant.

### El problema con OFFSET

```sql
SELECT ..., COUNT(*) OVER() AS total_count
FROM checklists
WHERE tenant_id = $1
ORDER BY id DESC
LIMIT $2 OFFSET $3
```

Dos costos que crecen con el volumen: `OFFSET` obliga a recorrer y descartar todas las filas anteriores a la página pedida, y `COUNT(*) OVER()` cuenta la tabla entera en cada página. Barato con miles de filas por tenant, pesado con cientos de miles.

### La solución: cursor por `id`

```sql
SELECT ...
FROM checklists
WHERE tenant_id = $1 AND ($2::int IS NULL OR id < $2)
ORDER BY id DESC
LIMIT $3   -- pageSize + 1
```

Con el índice `(tenant_id, id)` ya existente, esto resuelve cualquier página en tiempo prácticamente constante, sin importar cuán atrás esté. Se pide `pageSize + 1` filas para saber si hay más **sin contarlas todas** — `armarRespuestaCursor()` (`src/server/shared/utils/pagination.ts`) es quien corta esa fila de más y arma la respuesta.

Cursor por `id` solo, no por `(creado_en, id)`: alcanza porque `id` ya ordena por inserción (es un `SERIAL`), y evita el costo de comparar una tupla en vez de un entero.

**Contrato de la respuesta** (`camelCase`, consistente con el resto de la API — `pageSize`/`totalPages` ya se usaban así en todos lados):

```json
{
  "data": [...],
  "pagination": { "pageSize": 50, "nextCursor": 118, "hasMore": true }
}
```

Query params: `?pageSize=50&cursor=118`. Sin `page` ni `total` — ese es el costo aceptado a propósito: no se puede "saltar a la página 8", solo avanzar/retroceder de a una. Mismo patrón que ya usaban Equipos/Repuestos/Documentos en el cliente (botones **Anterior/Siguiente**, nunca un selector de página), así que no rompe ninguna expectativa de UX existente — y de hecho, checklists e IPERC no tenían NINGUNA paginación en el cliente antes de esto (quedaban clavados en los primeros 50 registros, sin forma de ver el resto); se las agregó de una.

Equipos, Repuestos y Documentos **siguen con `OFFSET`**: tienen cuotas más bajas (decenas de miles, no cientos de miles) y no están particionados — se revisan si alguna vez se acercan al mismo volumen.

---

## 3. Bloqueos distribuidos en workers

Cuatro workers periódicos corren con `setInterval` dentro de cada instancia del server: particionado, retención de backups, retención de auditoría, y drenaje del outbox. Sin coordinación, correr **dos instancias** del server duplica ese trabajo.

### Outbox: ya resuelto, a nivel de dato

`platformOutbox.worker.ts` usa `SELECT ... FOR UPDATE SKIP LOCKED` por fila — cada instancia reclama un lote de eventos sin pisar a la otra. No necesita ningún lock adicional.

### Los otros tres: `pg_advisory_xact_lock`

`src/server/shared/utils/advisoryLock.ts` expone `runSiPrimero(lockId, fn)`: toma un advisory lock **transaccional** de Postgres y corre `fn(client)` solo si lo consigue; si otra instancia ya lo tiene, no hace nada y la próxima vuelta del `setInterval` (o la otra instancia, ahora mismo) se encarga.

```ts
setInterval(() => {
  runSiPrimero(LOCK_IDS.particionado, (client) => asegurarParticionesFuturas(client)).catch((err) =>
    logger.error({ err }, "...")
  );
}, env.particionesCheckIntervalMs).unref();
```

### Por qué transaccional y no de sesión — y por qué importa para PgBouncer

La primera versión usaba `pg_try_advisory_lock` / `pg_advisory_unlock`: un lock de **sesión**, atado a la conexión física que lo pidió, sin importar cuántas transacciones corran de por medio (mismo mecanismo que ya usa `migrate.ts` al arrancar).

Eso es **incompatible con un pooler en modo transacción** (PgBouncer transaction pooling, el modo recomendado para escalar conexiones — ver ["Lo que sigue pendiente"](#5-lo-que-sigue-pendiente) más abajo). Ahí, PgBouncer solo garantiza que un cliente mantenga la misma conexión de backend **mientras dura una transacción explícita**. Tomar el lock y soltarlo como dos sentencias sueltas corre el riesgo real de que PgBouncer las despache contra dos conexiones de backend distintas — el lock quedaría tomado para siempre en una conexión que nadie vuelve a tocar, hasta que PgBouncer la resetee.

Un lock **transaccional** (`pg_try_advisory_xact_lock`) no tiene ese problema: se libera solo al `COMMIT`/`ROLLBACK` de la transacción que lo tomó. Mientras el `BEGIN`/`COMMIT` ocurran sobre el mismo client (como en `runSiPrimero`), da igual cuántas conexiones de backend distintas use PgBouncer entre una transacción y la siguiente.

La consecuencia práctica: el trabajo protegido tiene que correr **dentro** de esa misma transacción — por eso `fn` recibe el `client`, y por eso no alcanza con pasarle una función que use `pool` por su cuenta (correría fuera de la transacción que sostiene el lock, sin ninguna protección real).

### El caso especial: retención de auditoría, que borra en lotes

`platformAuditRetention.worker.ts` borra `platform_audit_log` en lotes de 5.000 filas — a propósito, para no tomar un lock de fila largo sobre una tabla que se sigue escribiendo en paralelo. Si el lock se pidiera **una sola vez para toda la corrida**, envolvería todos los lotes en una única transacción larga — exactamente lo que el batching existe para evitar.

Por eso `correrRetencionAuditoriaCoordinada()` pide el lock **una vez por lote**: cada lote es su propia transacción corta, protegida por su propio lock. Si en algún lote el lock ya lo tiene otra instancia, la corrida se detiene ahí — el resto lo hace la próxima vuelta, o la instancia que lo tiene ahora.

```ts
for (;;) {
  const borradas = await runSiPrimero(LOCK_IDS.auditRetention, (client) =>
    borrarUnLote(client, retentionDays)
  );
  if (borradas === undefined) break; // el lock de este lote ya lo tiene otra instancia
  total += borradas;
  if (borradas < LOTE) break;
}
```

`limpiarAuditoriaVieja()` (la función que usan los tests y una corrida manual) sigue sin lock — es de un solo proceso, la coordinación no pinta nada ahí.

---

## 4. Restore drill: validación de backups

Un backup nunca restaurado no es una garantía, es una suposición. `platformBackupDrill.worker.ts` corre diariamente (mismo mecanismo de lock que los demás workers) y valida el backup **completo** más reciente de cada tenant, y el más reciente de plataforma:

1. Lee el objeto del storage (S3 o local) y lo descifra/descomprime — si el objeto no existe o está corrupto, falla acá.
2. Parsea el JSON.
3. Compara la cantidad de filas por tabla contra el manifiesto guardado en `tenant_backups.tablas` / `platform_backups.tablas` al momento de crear el backup.

**Deliberadamente no restaura de verdad.** Es de solo lectura de punta a punta: nunca escribe en Postgres, solo lee el índice de backups y el objeto de storage. El drill que sí restaura de verdad —`platformBackupWriteDrill.worker.ts`— se documenta aparte más abajo.

### Ejecución manual: `npm run backup:restore-drill`

```
$ npm run backup:restore-drill

Restore drill — validando el backup más reciente de cada tenant y el de plataforma...

Tenants (12 verificados):
  ✓ tenant — backup a2e72472-...
  ✗ tenant — backup 6fe247d5-...: no se pudo leer (ENOENT: ...)
  ...

Plataforma:
  ✓ plataforma — backup 03f7dd18-...

13 backups verificados, 1 fallaron.
```

`scripts/restoreDrill.ts` reusa exactamente `correrRestoreDrill()` — no reimplementa ninguna lógica de validación, solo la invoca y formatea el resultado. Termina con código de salida **1** si algún backup falló, para poder engancharlo a un chequeo de CI/cron sin parsear logs.

### Tres bugs reales de concurrencia, encontrados persiguiendo la intermitencia de la suite

Construir el drill y estabilizar `platform-backup.test.ts` en la suite completa (corriendo en paralelo con el resto de los archivos, contra el mismo Postgres) destapó tres bugs que un entorno de un solo proceso nunca iba a mostrar. Vale la pena dejarlos documentados porque los tres son del mismo género — código que asume que nada más está tocando la base al mismo tiempo — y es el tipo de bug que reaparece si no se tiene presente el patrón:

- **Colisión de keys de storage.** `timestampParaKey()` recortaba los milisegundos del timestamp ISO. Dos backups del mismo tenant (o dos de plataforma) creados dentro del mismo segundo terminaban compartiendo key, y el segundo write pisaba el archivo del primero — la fila de metadata del primero quedaba "completa" pero apuntando al contenido del otro backup. Corregido agregando milisegundos + un sufijo random corto a la key (ver [backups en S3](backups-s3.md)). Encontrado por el restore drill.
- **Restore de plataforma con FK stale.** `restaurarTablasPlataforma()` pre-chequeaba en JS "¿existe este usuario hoy?" con un `SELECT` al principio de la transacción, y confiaba en ese resultado más tarde. Si el usuario se borraba (por otro tenant, en paralelo) en el medio, el `INSERT` reventaba con FK violation y abortaba el restore **completo** — un tenant borrado por otro motivo, un rato antes, tiraba abajo el restore de todos los demás. Corregido con `SAVEPOINT` por fila: se deja que la FK real de Postgres decida en el momento exacto del `INSERT`, nunca un chequeo previo que puede quedar viejo.
- **`setval()` a ciegas en el restore por tenant.** `restaurarTablas()` (restore sobre el mismo tenant, preservando ids) hacía `setval(secuencia, MAX(id))` después de insertar filas con id explícito. `equipos.id` es una secuencia **global** (no por tenant): mientras este restore corría, cualquier OTRO tenant insertando una fila nueva por su cuenta avanzaba la secuencia de verdad — y un `setval` que ignora eso puede **retrocederla**, haciendo que el próximo `nextval()` de una inserción totalmente ajena choque contra una fila que ya existía. Corregido tomando el `GREATEST` contra el valor actual de la secuencia (`pg_sequence_last_value`), nunca un valor a ciegas.

---

## 5. Restore drill de escritura: probando el camino real, sin dejar rastro

El drill de la sección anterior responde "¿el archivo todavía se puede leer?". No responde "¿el camino de escritura de un restore real todavía funciona?" — esas son preguntas distintas, y la segunda solo se puede responder escribiendo de verdad. `platformBackupWriteDrill.worker.ts` hace exactamente eso, apagado por default (`BACKUP_WRITE_DRILL_ENABLED`).

Reusa las mismas funciones que `restaurarBackupService()` usa en un restore real (`vaciarDatosDeTenant()`, `restaurarTablas()`, exportadas de `platformBackup.service.ts` para este propósito) — nunca una reimplementación paralela, para que un cambio futuro en la lógica de restore no pueda quedar sin ejercitar por el drill sin que nadie se entere.

**Aislamiento:** este sistema no es schema-per-tenant (es RLS de fila sobre un único esquema, ver `withTenant()`), así que "tenant descartable" es una fila nueva en `tenants`, con `nombre`/`slug` marcados (`__drill__<uuid>`) y un UUID propio generado en el momento — nunca un id que llegue de otro lado, así es estructuralmente imposible apuntar por error a un tenant real.

**Por qué nunca hace `COMMIT`, ni siquiera cuando sale bien:** todo el flujo (crear el tenant descartable, vaciar, restaurar, comparar conteos contra el manifiesto) corre sobre un único `client`, dentro de una única transacción que siempre termina en `ROLLBACK`. Es más fuerte que "insertar y borrar en un `finally`": un `finally` no corre si el proceso entero crashea; una transacción sin `COMMIT` se aborda sola al cerrarse la conexión, así que no hay escenario —ni siquiera un crash a mitad de camino— que deje un tenant huérfano o filas de prueba en producción.

Dos piezas de infraestructura compartida necesitaron un ajuste para soportar esto, ninguna cambia el comportamiento default de sus otros usos:

- `withTenant()` siempre comitea — no sirve para este flujo (abriría su propia conexión/transacción, ajena a la que sostiene el drill). Por eso el drill maneja su transacción a mano en vez de usar `withTenant()`.
- `runSiPrimero()` (el advisory lock que comparten todos los workers periódicos) ahora acepta `{ siempreRollback: true }`: fuerza `ROLLBACK` en vez de `COMMIT` cuando `fn` resuelve sin error, sin tocar el comportamiento de los demás callers (`particionado`, `backupRetention`, `auditRetention`, el drill de lectura), que siguen comiteando normal.

Corre un solo backup por ejecución —el más reciente completo, de cualquier tenant— a propósito: el objetivo es certificar que el CAMINO de escritura funciona, no volver a verificar cada backup individual (eso ya lo cubre el drill de lectura, que sí itera por tenant).

---

## 5. Lo que sigue pendiente

- **PgBouncer en modo transacción**: decisión de infraestructura, no de código — el código ya es compatible (ver la sección 3). Falta decidir dónde corre (Railway managed vs. autogestionado) antes de desplegarlo.
- **Fase de escala real**: réplicas de lectura, Redis en alta disponibilidad, ajuste fino de `max` del pool y de los TTL de cache — todo esto espera a tener tráfico/concurrencia real que lo justifique.
