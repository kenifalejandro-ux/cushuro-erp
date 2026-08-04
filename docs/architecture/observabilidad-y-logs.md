# Observabilidad, logs estructurados y trazabilidad multi-tenant

- **Estado**: vigente desde 2026-08-03 (migración `0036_tenant_metricas_latencia.sql`).
- **Relacionado**: [cuotas-por-tenant.md](cuotas-por-tenant.md) (misma tabla `tenant_metricas_horarias` que ya alimentaba "salud del tenant"), `tests/observability.test.ts`.

---

## El problema

Con muchos tenants en el mismo proceso, un log suelto (`"Error al procesar el pago"`) no sirve para nada si no se sabe **de qué tenant, de qué usuario y de qué request** salió. Antes de esto, esa información solo estaba disponible si el código que logueaba tenía `req` a mano (un controller con `req.log`) — un `logger.info()` llamado desde un service, dos capas más abajo, quedaba ciego.

## AsyncLocalStorage: contexto sin pasar `req` por parámetro

`src/server/shared/requestContext.ts` guarda el `req` de la petición en curso en un `AsyncLocalStorage`. Se llena una sola vez, en `requestContext.middleware.ts`, montado en `app.ts` justo después de `pino-http` (necesita que `req.id` ya exista) y antes de cualquier otro middleware:

```ts
app.use(requestLogger);        // pino-http: asigna req.id, setea x-request-id en la respuesta
app.use(requestContextMiddleware); // envuelve el resto de la cadena en el ALS
```

`runWithRequestContext(req, next)` hace que **todo lo que corra después** —el resto de los middlewares, el controller, cualquier service que llamen, y también callbacks async encadenados desde ahí (`res.on("finish")`, promesas, `setTimeout`)— vea el mismo `req` sin que nadie tenga que pasarlo explícitamente.

Se guarda el `req` completo, no una copia de `{tenantId, usuarioId}`. La razón: `tenantId` lo resuelve `tenantMiddleware` y `usuarioId` lo resuelve `authMiddleware`, ambos **después** de que arrancó el ALS (el contexto arranca en la petición HTTP entera, no solo en las rutas de `/api/erp`). Si se copiaran los campos a un objeto aparte al momento de crear el contexto, habría que volver a escribir ese objeto en cada punto donde se resuelve un campo nuevo (`tenantMiddleware`, `authMiddleware`, `resolveTenantSubdomain.ts`, `scim.middleware.ts`, `platformAdmin.middleware.ts`...). Guardando el `req` mismo, `getRequestContext()` simplemente lee `req.tenantId` / `req.usuario?.id` en el momento del log — siempre el valor más reciente, sin sincronizar nada en ningún otro middleware.

## El logger se enriquece solo (`mixin`)

`src/server/config/logger.ts` configura pino con:

```ts
mixin() {
  const ctx = getRequestContext();
  return ctx ? { requestId: ctx.requestId, tenantId: ctx.tenantId, usuarioId: ctx.usuarioId } : {};
}
```

`mixin` corre en cada llamada a `logger.info/warn/error(...)` y sus resultados se mergean en el objeto logueado. Como los child loggers de pino heredan el `mixin` del logger raíz, esto también enriquece automáticamente `req.log` (el logger por-request de `pino-http`) sin configuración aparte.

```ts
// Dentro de cualquier service, sin recibir req como parámetro:
import { logger } from "../config/logger";
logger.info({ repuestoId }, "Repuesto dado de baja");
// → { ..., "tenantId": "…", "usuarioId": "…", "requestId": "…", "repuestoId": "…", "msg": "Repuesto dado de baja" }
```

Fuera de una petición HTTP (arranque del server, un cron futuro), `getRequestContext()` devuelve `undefined` y esos tres campos simplemente no aparecen — no hay que ramificar el código de logging para ese caso.

## `x-request-id`: trazabilidad de punta a punta

`pino-http` (en `app.ts`) genera un id por request (o reusa el que mande el cliente en el header `x-request-id`) y lo devuelve en la respuesta con ese mismo header. Un cliente (frontend, integración, soporte) que recibe un error puede mandar ese id de vuelta al reportarlo, y buscarlo tal cual en los logs — es el mismo valor que `mixin` agrega como `requestId`.

## Redacción de campos sensibles: dos capas

1. **Paths fijos** (`redact.paths` de pino) — para casos que no se detectan por nombre de key: `req.headers.cookie`, y los dos campos honeypot anti-bot (`body.website`, `validatedBody.website`) que además de sensibles no deben verse en logs porque revelarían el mecanismo anti-spam.
2. **Recursiva por nombre** (`src/server/shared/security/sanitizeLog.ts`, enganchada como `formatters.log`) — recorre el objeto logueado **en cualquier profundidad** y enmascara cualquier key que matchee `password|token|authorization|secret|creditcard` (case-insensitive). A diferencia de los paths fijos, no hace falta saber de antemano dónde va a aparecer el campo: cubre un `token` adentro de un objeto anidado sin tener que listar esa ruta.

Ambas capas conviven: la recursiva es la defensa general, los paths fijos cubren lo que no se puede detectar por nombre.

## Métricas de rendimiento y errores por tenant

`tenant_metricas_horarias` (agregado por `tenant_id` + hora, no un log de requests — ver `migrations/0022_tenant_metricas_horarias.sql`) ahora también guarda:

| Columna | Qué es |
|---|---|
| `latencia_total_ms` | Suma (no promedio) de la latencia de cada request de esa hora |
| `requests_error_4xx` | Requests con status 400-499 |
| `requests_error_5xx` | Requests con status ≥500 (ya existía) |

`latencia_total_ms` es una suma a propósito: promediar promedios por hora pondera mal si una hora tuvo 5 requests y otra 5000. El promedio real se calcula al leer, en `platformTenantHealth.service.ts`:

```ts
latenciaPromedioMs = requests > 0 ? latenciaTotalMs / requests : null;
```

(`null`, no `0`, cuando no hubo tráfico — `0ms` se leería como "está rápido", no como "no hay datos".) No hay columna aparte para 2xx: esta API no emite 3xx, así que `2xx = requests_total - 4xx - 5xx` alcanza sin mantener una columna más en el `UPDATE`.

`tenantMetricsMiddleware` mide con `process.hrtime.bigint()` (monotónico — no se ve afectado por un ajuste del reloj del sistema durante el request) y escribe en `res.on("finish")`, después de que la respuesta ya salió: nunca agrega latencia real al request, y si falla el `INSERT` no tira abajo la respuesta (`registrarMetricaRequest` atrapa sus propios errores).

`GET /api/platform/tenants/:id/salud` expone `latenciaPromedioMsUltimas24h` y `errores4xxUltimas24h` junto a los campos que ya existían.

## Errores no manejados

`errorHandler` (`shared/middlewares/error.middleware.ts`) ya no arma manualmente `{err, requestId}` para loguear — con el `mixin`, `req.log.error({err}, ...)` alcanza para que el log incluya `tenantId`/`usuarioId`/`requestId` automáticamente. El `requestId` sigue devolviéndose en el body de la respuesta JSON (eso no es logging, es lo que el cliente necesita para poder reportarlo).

## Tests

`tests/observability.test.ts` cubre:

- El header `x-request-id` se inyecta siempre, y se reusa el que mande el cliente.
- Con `runWithRequestContext(fakeReq, ...)`, cualquier log dentro incluye `requestId`/`tenantId`/`usuarioId`; fuera de contexto, no aparecen.
- La redacción recursiva enmascara `password`/`token`/`authorization`/`creditCard`/`secret` en cualquier profundidad, sin tocar el resto de los campos.
- Una request real contra el ERP suma `latencia_total_ms`, y una bloqueada por módulo no habilitado (403) cuenta como `requests_error_4xx`, no `requests_error_5xx`.

Los tests del logger arman su propia instancia de pino con `loggerOptions` (exportado por separado de `logger` en `config/logger.ts`) apuntando a un stream en memoria, en vez de parsear stdout — `loggerOptions` no incluye `transport` porque pino no permite combinar `transport` con un stream propio.
