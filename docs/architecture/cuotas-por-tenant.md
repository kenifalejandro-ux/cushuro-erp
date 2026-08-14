# Cuotas operativas por tenant

- **Estado**: vigente desde 2026-08-03 (migraciones `0033_tenant_cuotas.sql` y `0034_planes.sql`).
- **Relacionado**: [ADR-0002](../adr/0002-contrato-de-modulo.md) (cada módulo declara su cuota en el registry), [backups en S3](backups-s3.md) (la cuota de almacenamiento existe por el costo que introdujo S3).

---

## Qué limita, y qué NO

Limita el **volumen** que un tenant puede acumular:

| Recurso                    | Se mide                                          | Default         |
| --------------------------- | ------------------------------------------------ | --------------- |
| `usuarios`                  | Usuarios **activos** del tenant                  | 100             |
| `backup_bytes`               | Suma de `tamano_bytes` de sus backups existentes | 5 GiB           |
| Uno o más por módulo        | Filas en la tabla que el módulo declare          | Ver el registry |

**No** limita frecuencia de requests: eso es rate limiting, un sistema aparte (ver más abajo). Y **no cobra nada**: los planes segmentan y aplican límites, pero no hay billing. Levantar un límite es una decisión que se toma en el panel, no pagando.

### Los defaults por módulo viven en el registry

```ts
{
  id: "equipos",
  // ...
  cuota: { tabla: "equipos", porDefecto: 2_000 },
}
```

`tabla` hay que declararla porque un módulo suele tener varias y solo una representa el volumen del cliente: en checklists se cuentan los **checklists llenados**, no las plantillas (que son configuración y son pocas); en iperc se cuentan los **IPERC**, no las líneas base.

Un módulo sin `cuota` no tiene límite — correcto para `dashboard`, que no crea registros propios, solo agrega los de otros.

**Subir el límite de todos los clientes es cambiar ese número y desplegar.** No hay que correr ningún UPDATE masivo.

### Un módulo puede tener MÁS de un recurso: `cuotasPorRuta`

`cuota` da un único recurso por módulo (`recurso` = el id del módulo), lo que alcanza casi siempre. Pero `requireCuota()` (`src/server/shared/middlewares/cuota.middleware.ts`) se monta **una sola vez por módulo, sobre TODO su router** (`routes/index.ts`) — así que un módulo con más de una escritura que hace crecer recursos DISTINTOS necesita más de una cuota, no una compartida.

El caso real que forzó esto: **Repuestos**. `POST /` y `POST /bulk` crean filas de catálogo (pocas, configuración); `POST /movimientos` crea filas de un histórico de campo (entradas/salidas de stock, que crece sin parar). Si las tres compartieran el mismo `cuota.tabla`, mover ese `tabla` al histórico habría dejado las altas de catálogo sin límite real (el histórico no crece con un `POST /`), y al revés, un tenant con mucho volumen de movimientos podría quedar bloqueado para dar de alta un SKU nuevo — dos recursos sin relación real, atados por accidente de implementación.

`cuotasPorRuta` declara recursos ADICIONALES, cada uno atado a una ruta específica del módulo:

```ts
{
  id: "repuestos",
  // ...
  cuota: { tabla: "repuestos", porDefecto: 50_000 }, // recurso base: "repuestos" (catálogo)
  cuotasPorRuta: [
    {
      ruta: "/movimientos",
      metodo: "POST",
      recurso: "repuestos_movimientos", // recurso propio, NO el id del módulo
      tabla: "repuestos_movimientos",
      porDefecto: 100_000,
    },
  ],
}
```

`requireCuota()` resuelve el recurso de cada request mirando si la ruta matchea alguna entrada de `cuotasPorRuta` (mismo criterio de comparación por segmentos que `offline.escrituras`/`rutasOffline.ts`, duplicado del lado servidor a propósito); si ninguna matchea, cae al recurso base de `cuota`. Cada recurso nuevo (`recurso`, acá `"repuestos_movimientos"`) participa del resto del mecanismo igual que cualquier otro: tiene su propia fila posible en `tenant_cuotas` (override) y en `plan_limites` (por plan), y aparece aparte en `resumenCuotasTenant()`/el panel.

---

## Planes: los tres niveles de resolución

El límite efectivo de un tenant se resuelve en **tres niveles**, en este orden:

| #   | Nivel                               | Para qué sirve                                          |
| --- | ----------------------------------- | ------------------------------------------------------- |
| 1   | `tenant_cuotas`                     | Excepción negociada con **ese** cliente                 |
| 2   | Plan del tenant (`tenants.plan_id`) | Segmento comercial: MYPE, Pequeña, Mediana, Corporativo |
| 3   | `src/modules/registry.ts`           | Default de última instancia                             |

Sin el nivel 2, dar de alta una PYME era cargar ~8 overrides a mano, sin que quedara registrado **qué categoría** es ese cliente — y cambiar los límites de un segmento obligaba a actualizar cliente por cliente.

El campo `origen` de cada cuota (en `GET /tenants/:id/cuotas` y en la salud del tenant) dice de qué nivel salió el número. Importa: "500 equipos" sin saber si viene del plan o de una excepción es un dato a medias, porque cambiar el plan mueve uno y no el otro.

### Planes iniciales

| código        | usuarios | equipos | checklists / iperc | combustible | repuestos | ordenes_trabajo | documentos | backups |
| ------------- | -------: | ------: | -----------------: | ----------: | --------: | ---------------: | ---------: | ------: |
| `mype`        |       10 |      20 |             40.000 |      20.000 |    10.000 |             2.000 |      5.000 |   1 GiB |
| `pequena`     |       50 |     100 |            200.000 |     100.000 |    50.000 |            10.000 |     20.000 |   5 GiB |
| `mediana`     |      200 |     500 |          1.000.000 |     500.000 |   200.000 |            50.000 |     50.000 |  20 GiB |
| `corporativo` |        ∞ |       ∞ |                  ∞ |           ∞ |         ∞ |                 ∞ |          ∞ | 100 GiB |

`ordenes_trabajo` no escala como el resto de la tabla (que sigue el
criterio de `equipos` × frecuencia diaria/turno) -- una OT es un evento de
mantenimiento (correctivo + preventivo), no una rutina por turno. Estimado
en ~2 OT por equipo por mes, con la misma holgura de varios años que el
resto: ver el comentario de `migrations/0052_ordenes_trabajo_plan_limites.sql`
para la cuenta completa.

Los números salen de que **casi todo escala con la cantidad de equipos**: un checklist de pre-uso es ~1 por equipo por turno, así que 20 equipos × 2 turnos × 365 días ≈ 14.600/año. Por eso `equipos` define cada segmento y el resto se deriva con holgura de varios años. Son un punto de partida ajustable desde el panel sin tocar código.

**Corporativo topea solo `backup_bytes`** porque es el único recurso con costo directo y recurrente (S3 se paga por GB-mes); el resto son filas en una base que ya se paga igual.

### Por qué `plan_limites` y no una columna por recurso

Con columnas, agregar el módulo 8 exigiría una migración para sumar la columna **más** actualizar el seed de cada plan — justo el trabajo repartido que el Contrato de Módulo ([ADR-0002](../adr/0002-contrato-de-modulo.md)) existe para eliminar. Normalizado, un módulo nuevo simplemente no tiene fila en ningún plan y su límite cae al nivel 3. Eso no es un agujero: es la resolución funcionando.

### Cambiar de plan nunca destruye datos

- **Subir de plan** solo levanta topes.
- **Bajar de plan** puede dejar al tenant **excedido**: no se borra nada, solo deja de poder crear hasta que baje volumen o vuelva a subir.

`PUT /tenants/:id/plan` devuelve `recursosExcedidos` justamente para que el panel lo advierta **en el momento**, en vez de que aparezca después como creaciones rechazadas sin explicación.

**Desactivar un plan** impide asignarlo a clientes nuevos; los que ya lo tienen conservan sus límites. Lo contrario cambiaría en silencio los topes de clientes que nadie tocó. **Borrar un plan** deja a sus tenants sin plan (`ON DELETE SET NULL`), cayendo al nivel 3 — nunca se lleva puesto a un tenant.

---

## Los tres estados de una cuota

Aplican igual en `tenant_cuotas` (nivel 1) y en `plan_limites` (nivel 2). Para un tenant/plan y recurso dados:

| Estado en la tabla       | Significado                                                    |
| ------------------------ | -------------------------------------------------------------- |
| Sin fila                 | Se aplica el default del código                                |
| Fila con `limite = N`    | Ese tenant tiene exactamente N                                 |
| Fila con `limite = NULL` | Ese tenant es **ilimitado**, aunque el código tenga un default |

Los tres son distintos y hacen falta los tres: sin el tercero, "a este cliente no le apliqués el límite" habría que expresarlo con un número gigante que después nadie sabría si era un límite real o un "sin límite" disfrazado.

En la API:

```jsonc
PUT /api/platform/tenants/:id/cuotas
{ "recurso": "equipos", "limite": 500 }   // 500
{ "recurso": "equipos", "limite": null }  // ilimitado
{ "recurso": "equipos" }                  // borra el override → vuelve al default
```

---

## Qué pasa al excederse

**Se bloquea la creación del siguiente registro. Nunca se toca lo existente.**

Una cuota es un tope de crecimiento, no una excusa para tocarle los datos a un cliente. Consecuencia deliberada: **leer y borrar siguen funcionando siempre**, incluso excedido. Si el bloqueo alcanzara al `DELETE`, un tenant en el límite quedaría atrapado sin forma de bajar por debajo — el peor diseño posible.

Por eso el middleware solo actúa sobre `POST`.

La respuesta es `403` con cuerpo estructurado, para que el cliente pueda mostrar "usaste X de Y" sin parsear texto:

```json
{
  "ok": false,
  "error": "cuota_excedida",
  "recurso": "equipos",
  "limite": 2000,
  "uso": 2000,
  "message": "Cuota de \"equipos\" excedida: 2000 de 2000 en uso."
}
```

**Por qué 403 y no 402/429**: `402 Payment Required` promete que pagando se desbloquea, y acá no hay billing. `429` es para frecuencia de requests, no para volumen acumulado.

### El caso de las importaciones masivas

`POST /repuestos/bulk` y `POST /documentos/bulk` reciben un array y crean N filas de un saque. Un chequeo ingenuo ("¿hay lugar para una más?") dejaría pasar una importación de 10.000 filas con un solo cupo libre. El incremento sale del largo del array, y el chequeo corre **antes** del insert: si el lote no entra, no se inserta nada.

Un `POST` que crea un padre con hijos (un checklist con sus ítems) cuenta como **1** — la cuota se define sobre la entidad principal, no sobre las filas de detalle.

---

## Dónde se aplica

| Recurso        | Punto de enforcement                                                   |
| -------------- | ---------------------------------------------------------------------- |
| Módulos        | `requireCuota(moduloId)` en `routes/index.ts`, junto a `requireModulo` |
| `usuarios`     | `crearUsuarioEnTenantService`                                          |
| `backup_bytes` | `exportarTenantService`, antes de leer nada                            |

Dos detalles que importan:

- **El alta de usuarios tiene un solo punto de enforcement aunque haya dos vías.** SCIM (`routes/scim.ts`) reutiliza `crearUsuarioEnTenantService`, así que si el IdP de un cliente empuja más usuarios de los contratados, se rechaza con el mismo criterio que un alta manual.
- **`requireCuota` va después de `requireModulo`.** A un tenant que no contrató el módulo hay que decirle "no disponible", no "te quedaste sin cupo" — lo segundo admitiría que el módulo existe y solo está lleno.

Un módulo nuevo queda cubierto por el solo hecho de declarar `cuota` en el registry: no hay que tocar sus controllers ni el middleware.

### Se cuentan usuarios **activos**, no filas

Desactivar a alguien libera su cupo. En este sistema "eliminar" un usuario es desactivarlo (nunca un `DELETE`: hay historial que lo referencia). Si se contaran filas, un tenant con rotación de personal se quedaría sin cupo para siempre.

---

## Garantía real bajo concurrencia

El chequeo es "contar y después insertar". Bajo concurrencia, **dos requests simultáneos pueden ver el mismo conteo y pasar los dos**: el exceso posible está acotado a la cantidad de requests en vuelo, no es ilimitado.

Cerrarlo del todo exigiría una fila contador con lock por tenant y recurso, serializando todas las altas de ese tenant — un costo permanente en el camino caliente para evitar un desvío de unas pocas filas sobre límites de decenas de miles. **No se hizo, a propósito**, y se documenta en vez de fingir una exactitud que no hay.

---

## Observabilidad

`GET /api/platform/tenants/:id/salud` incluye ahora `cuotas` con uso, límite y porcentaje de cada recurso, más dos alertas:

- `cuota_cerca_del_limite` — algún recurso al **80%** o más. Señal comercial: hay margen para ampliar el límite o hablar con el cliente **antes** de que le moleste.
- `cuota_excedida` — ya hay operaciones bloqueándose.

Son alertas separadas a propósito: mezclarlas escondería la primera, que es justamente la accionable a tiempo.

Cada bloqueo se audita en `platform_audit_log` con `accion = 'cuota.bloqueo'` y `resultado = 'failure'`. Que un cliente choque contra su límite es una señal comercial, no un error más.

---

## Endpoints

| Método | Ruta                               | Permiso                                               |
| ------ | ---------------------------------- | ----------------------------------------------------- |
| `GET`  | `/api/platform/planes`             | platform admin (`?soloActivos=true` para el selector) |
| `GET`  | `/api/platform/planes/:idOCodigo`  | platform admin (acepta código o UUID)                 |
| `GET`  | `/api/platform/tenants/:id/plan`   | platform admin                                        |
| `PUT`  | `/api/platform/tenants/:id/plan`   | **super_admin**                                       |
| `GET`  | `/api/platform/tenants/:id/cuotas` | platform admin                                        |
| `PUT`  | `/api/platform/tenants/:id/cuotas` | **super_admin**                                       |

El `GET` devuelve uso **y** límite juntos: un límite solo se interpreta contra el consumo real, y pedirlos por separado invitaría a mostrar uno sin el otro.

El `PUT` exige super_admin por el mismo criterio que el toggle global de módulos: cambia lo que un cliente puede consumir.

---

## Cuotas vs. rate limiting: dos sistemas distintos

Se confunden seguido, así que conviene tenerlo explícito:

|              | Cuotas                               | Rate limiting                                              |
| ------------ | ------------------------------------ | ---------------------------------------------------------- |
| Limita       | **Volumen** acumulado                | **Frecuencia** de requests                                 |
| Clave        | Tenant                               | Usuario y tenant (`/api/erp/*`) o ruta + IP (auth y panel) |
| Respuesta    | `403 cuota_excedida`                 | `429 rate_limit_usuario` / `rate_limit_tenant`             |
| Se resuelve  | Pidiendo más cupo / subiendo de plan | Esperando                                                  |
| Se configura | Panel, plan, o registry              | Variables de entorno                                       |

Un cliente puede chocar con los dos por motivos totalmente distintos, por eso el `error` del cuerpo los distingue sin que haya que parsear texto.

### Rate limit de `/api/erp/*`: dos niveles, por usuario

Hasta este esquema, **las rutas de negocio no tenían ningún rate limit**: el limitador genérico solo cubría auth y el panel. Las cuotas frenaban cuántos registros podía acumular un tenant, pero nada le impedía miles de `GET` por segundo.

| Nivel                | Clave               |                                  Default | Para qué                                                    |
| -------------------- | ------------------- | ---------------------------------------: | ----------------------------------------------------------- |
| 1 — fusible personal | `erp:u:{usuarioId}` |                                  120/min | Cortar un script en loop o una cuenta comprometida          |
| 2 — techo de empresa | `erp:t:{tenantId}`  | 3.000/min (configurable **por cliente**) | Que un tenant desbocado no degrade el servicio de los demás |

Cualquiera en `0` desactiva ese nivel.

#### Por qué por usuario y no por IP

**La IP no identifica a nadie en este despliegue.** Los operarios en oficina salen por el NAT de la empresa (una IP para 50 personas), y los de planta usan datos móviles, donde la operadora hace **CGNAT** (una IP para miles de abonados) y la IP además **cambia** al moverse entre antenas. Es demasiado gruesa y demasiado inestable a la vez.

Con población mixta el efecto es peor que un límite mal calibrado: el **mismo** límite se comportaría distinto según desde dónde se conecte cada uno — los de oficina bloqueándose de más, los de planta casi nunca. Imposible de explicar a un cliente y muy difícil de diagnosticar.

El argumento que cierra la discusión: **este middleware corre después de `authMiddleware`**, así que nunca ve tráfico anónimo (sin credenciales el request muere con 401 antes de llegar). No protege de un desconocido — protege de un cliente **autenticado** descontrolado. Y en ese caso siempre hay un usuario identificado, que es la identidad correcta para contar. La IP no aportaría nada.

#### El fusible personal no depende del plan

Un operario hace clic a la misma velocidad en una MYPE que en una Corporativo. Que el límite personal variara por plan sería castigar a la persona por el tamaño de su empresa. Es un **fusible técnico**, no una diferenciación comercial: 120/min es absurdo para un humano y evidente para un bucle.

#### Un usuario bloqueado no consume el presupuesto de su empresa

Cuando alguien choca contra su fusible, el request **no** incrementa el contador del tenant. Si lo hiciera, un solo script descontrolado se comería el presupuesto de toda la empresa y terminaría bloqueando a sus compañeros — exactamente el daño que el nivel 1 existe para contener. Por eso se evalúa usuario primero y se corta ahí.

#### Dos respuestas distintas

|                  | `rate_limit_usuario`       | `rate_limit_tenant`                         |
| ---------------- | -------------------------- | ------------------------------------------- |
| Qué pasó         | Esta persona va muy rápido | La empresa agotó su cupo                    |
| Cómo se resuelve | Esperar                    | Revisar integraciones o pedir más capacidad |

Con un solo mensaje, un cliente que necesita atención recibiría lo mismo que uno que solo tiene que esperar dos segundos.

#### El techo del tenant es configurable por cliente

Se resuelve en **dos capas**:

| #   | Capa                                                  |                              |
| --- | ----------------------------------------------------- | ---------------------------- |
| 1   | Override en `tenant_cuotas`, recurso `rate_limit_rpm` | El número de **ese** cliente |
| 2   | `ERP_RATE_LIMIT_TENANT_DEFAULT`                       | Fallback global (3.000/min)  |

`limite = NULL` en el override significa **sin techo** (el fusible personal sigue aplicando), no "usá el default" — misma semántica que el resto de las cuotas.

**No hay un nivel por plan ni una fórmula en vivo, y es una decisión.** Se evaluó `usuarios_activos * 100` y se descartó por tres motivos:

1. **Invertía los límites en tenants chicos.** Con 1 usuario activo daba 100 req/min, **por debajo** del fusible personal de 120: el techo de la empresa habría disparado antes que el de una sola persona, devolviendo además el mensaje equivocado ("tu empresa alcanzó el límite" cuando era él solo).
2. **Era un blanco móvil.** El límite cambiaba solo al activar o desactivar usuarios. Dar de baja a 3 operarios un viernes bajaba 300 req/min el lunes sin que nadie tocara la configuración.
3. **Metía un `COUNT` sobre `usuarios`** (que tiene RLS, o sea conexión dedicada) justo en el camino que el caché existe para evitar.

#### La fórmula sobrevive como sugerencia, no como regla

`GET /api/platform/tenants/:id/cuotas` devuelve, aparte de las cuotas de volumen:

```jsonc
"rateLimit": {
  "recurso": "rate_limit_rpm",
  "limiteRpm": 3000,            // vigente (override o fallback); null = sin techo
  "limiteSugeridoRpm": 4700,
  "usuariosActivos": 47,
  "picoRpmEstimado": 216,
  "motivo": "Basado en 47 usuarios activos (100 req/min por usuario)."
}
```

Un humano lo mira, lo ajusta si hace falta, y lo guarda. **El número queda explícito, auditado y explicable** — se puede justificar ante el cliente ("te pusimos 5.000 porque tu pico medido fue 3.240") en vez de ser el resultado de una fórmula que cambia sola.

`picoRpmEstimado` sale de `tenant_metricas_horarias` multiplicado por un factor de ráfaga (×4). Es necesario porque esa tabla agrega **por hora**: dividir por 60 da un promedio, no un pico, y una ráfaga de cambio de turno queda diluida entre los otros 59 minutos. **Es una estimación, no una medición** — otra razón para que sea sugerencia y no regla.

La sugerencia nunca queda por debajo del fallback global: a un cliente que hoy funciona bien no se le sugiere un recorte.

#### El caché

El techo se cachea en **Redis** (TTL 300s) **e** se invalida explícitamente al guardarlo desde el panel. Hacen falta las dos cosas:

- Solo TTL → cambiás el límite y no pasa nada por 5 minutos; el admin cree que falló y lo cambia de nuevo.
- Solo invalidación → si se pierde (Redis caído en ese instante), el valor viejo queda para siempre.

**Redis y no memoria**: con más de una instancia, un caché en memoria haría que la invalidación no se propague — una instancia respetaría el límite nuevo y otra el viejo. El costo marginal es casi nulo porque el rate limiter ya le pega a Redis para el `INCR`.

Sin Redis se degrada a un caché en memoria con TTL de 30s: la invalidación no cruza instancias, pero evita pegarle a Postgres en cada request, que es lo inaceptable.

#### Limitaciones conocidas

- **Ventana fija, no deslizante** (`INCR` + `PEXPIRE`, igual que el limitador genérico del proyecto). Tiene el problema clásico de borde: 120 requests al final de una ventana y 120 al principio de la siguiente son 240 en pocos segundos, ninguno bloqueado. Aceptable para el propósito (cortar bucles, no medir con precisión), pero conviene saberlo al elegir los números.
- **El fusible personal sí es global.** Solo el techo del tenant se puede ajustar por cliente; los 120 req/min por persona son iguales para todos, a propósito (es un fusible técnico, no una diferenciación comercial).
- **No frena un DoS volumétrico real.** Para cuando el request llega acá ya consumió una conexión, ya pasó por Express, ya validó un JWT y ya tocó Redis. Eso se frena antes de Node: reverse proxy, CDN o infraestructura. Este limitador protege de **abuso autenticado**, que es un problema distinto.

---

## Fuera de alcance

- **Billing.** Los planes segmentan y aplican límites, pero no cobran nada: no hay integración de pagos, ni fechas de vigencia, ni upgrade automático al excederse. Levantar un límite es una acción del panel, no un pago.
- **ABM de planes desde el panel.** Se pueden listar, ver y asignar; crear/editar/borrar planes se hace por SQL. Los 4 iniciales cubren la segmentación pensada, y agregar uno es raro.
- **Avisar al cliente al acercarse al límite.** Hoy la señal es la alerta en la salud del tenant, visible para el dueño de la plataforma, no para el cliente.
- **Rate limit por plan o por tenant.** Los dos niveles son constantes globales. Se evaluó atarlos a los planes y se descartó: el fusible personal no debe variar por plan (castigaría a la persona por el tamaño de su empresa), y para el techo de empresa conviene medir el tráfico real antes de fijar números por tier. `tenant_metricas_horarias.requests_total` ya tiene esos datos.
- **Rate limiting por tenant.** Es otro problema (frecuencia, no volumen) y ya hay rate limiters aparte.
- **Cuota de almacenamiento de archivos de usuario.** Hoy no existen: `documentos` guarda solo metadata, no archivos. La única superficie de almacenamiento real son los backups.
