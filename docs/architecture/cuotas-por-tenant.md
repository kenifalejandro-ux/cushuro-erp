# Cuotas operativas por tenant

- **Estado**: vigente desde 2026-08-03 (migración `0033_tenant_cuotas.sql`).
- **Relacionado**: [ADR-0002](../adr/0002-contrato-de-modulo.md) (cada módulo declara su cuota en el registry), [backups en S3](backups-s3.md) (la cuota de almacenamiento existe por el costo que introdujo S3).

---

## Qué limita, y qué NO

Limita el **volumen** que un tenant puede acumular:

| Recurso | Se mide | Default |
|---|---|---|
| `usuarios` | Usuarios **activos** del tenant | 100 |
| `backup_bytes` | Suma de `tamano_bytes` de sus backups existentes | 5 GiB |
| Uno por módulo | Filas en la tabla que el módulo declare | Ver el registry |

**No** limita frecuencia de requests (eso es rate limiting, que ya existe aparte y resuelve otro problema), ni introduce planes, ni cobra nada. Sin billing, una cuota es un tope operativo — no monetización. Levantar un límite es una decisión que se toma en el panel, no pagando.

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

---

## Los tres estados de una cuota

`tenant_cuotas` guarda **solo excepciones**. Para un tenant y recurso dados:

| Estado en la tabla | Significado |
|---|---|
| Sin fila | Se aplica el default del código |
| Fila con `limite = N` | Ese tenant tiene exactamente N |
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

| Recurso | Punto de enforcement |
|---|---|
| Módulos | `requireCuota(moduloId)` en `routes/index.ts`, junto a `requireModulo` |
| `usuarios` | `crearUsuarioEnTenantService` |
| `backup_bytes` | `exportarTenantService`, antes de leer nada |

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

| Método | Ruta | Permiso |
|---|---|---|
| `GET` | `/api/platform/tenants/:id/cuotas` | platform admin |
| `PUT` | `/api/platform/tenants/:id/cuotas` | **super_admin** |

El `GET` devuelve uso **y** límite juntos: un límite solo se interpreta contra el consumo real, y pedirlos por separado invitaría a mostrar uno sin el otro.

El `PUT` exige super_admin por el mismo criterio que el toggle global de módulos: cambia lo que un cliente puede consumir.

---

## Fuera de alcance

- **Planes / tiers.** Sin billing, un plan es una etiqueta. Cuando exista cobro, un plan puede ser una capa que fija defaults por encima del registry, sin cambiar nada de lo de acá.
- **Rate limiting por tenant.** Es otro problema (frecuencia, no volumen) y ya hay rate limiters aparte.
- **Cuota de almacenamiento de archivos de usuario.** Hoy no existen: `documentos` guarda solo metadata, no archivos. La única superficie de almacenamiento real son los backups.
- **Avisar al cliente por email al acercarse al límite.** Hoy la señal es la alerta en la salud del tenant, visible para el dueño de la plataforma, no para el cliente.
