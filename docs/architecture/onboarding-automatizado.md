# Onboarding automatizado de tenants

- **Estado**: vigente desde 2026-08-04.
- **Relacionado**: [cuotas-por-tenant.md](cuotas-por-tenant.md) (planes y resolución de límites), [particionado-de-tablas.md](particionado-de-tablas.md) (por qué el particionado no participa acá), `tests/tenant-onboarding.test.ts`.

---

## Qué había antes de esto

`POST /api/platform/tenants` (`crearTenantConAdminService`) ya hacía la mayor parte de "dar de alta un cliente" en un solo paso: crea el `tenant`, habilita todos los módulos, crea el usuario admin inicial con hash seguro de contraseña (bcrypt, vía `auth.service.ts`) — todo en **una transacción**, con soporte de `Idempotency-Key` y auditoría. Es lo que ya usa `tests/helpers.ts` (`crearTenantDePrueba`) para armar tenants de prueba en toda la suite.

Lo que faltaba: asignar un **plan** inicial. Existía `asignarPlanATenantService`, pero como paso manual y separado — un tenant recién creado quedaba con `plan_id = NULL` (cae a los defaults del registry, ver `cuotas-por-tenant.md`) hasta que alguien lo asignaba después desde el panel.

## Qué agrega el onboarding

`POST /api/platform/tenants/onboard` (`tenantOnboardingService.ts`) es lo mismo que `/tenants` **más** un `planCodigo` opcional, resuelto y aplicado **en la misma transacción** que la creación del tenant — nunca es un estado posible tener un tenant creado sin su plan si se pidió uno, ni siquiera transitoriamente.

Por qué no es simplemente "llamar a `crearTenantConAdminService` y después a `asignarPlanATenantService`": esa segunda función corre contra el pool directo, en su propia transacción implícita — llamarla después dejaría una ventana real donde el tenant existe sin plan, y si esa segunda llamada fallara (plan inválido, por ejemplo), el tenant ya habría quedado creado sin poder deshacerlo limpiamente. En cambio, `crearTenantConAdminService` ahora acepta un `planId` opcional (ya resuelto/validado por `tenantOnboardingService.ts`) y lo aplica ella misma, adentro de su propio `BEGIN`/`COMMIT`: si el plan no es válido, el `AppError` se lanza ANTES de siquiera abrir la transacción (la validación de `obtenerPlanService` corre primero), así que el tenant nunca llega a existir.

```
tenantOnboardingService.onboardTenantService(input, contexto, idempotencyKey)
  1. Si viene planCodigo: obtenerPlanService(planCodigo) — valida que exista y esté activo (si no, 404/400, nada se crea)
  2. crearTenantConAdminService(..., planId) — UNA transacción:
       INSERT tenant → UPDATE plan_id (si aplica) → habilitar módulos → crear admin → COMMIT
  3. Auditoría (crear_tenant, con el planId aplicado en el detalle)
```

## Endpoint vs. servicio: por qué dos rutas y no una

`/tenants` (sin plan) sigue abierta a cualquier platform admin — es el alta simple que ya usaban los tests y cualquier flujo que no necesita decidir un plan en el momento. `/tenants/onboard` está gateado a **super-admin** (`platformSuperAdminMiddleware`) porque es la operación real de alta de cliente pagante — más sensible que crear un tenant de prueba o interno. Ambas rutas comparten el mismo manejo de `Idempotency-Key` (`crearTenantConIdempotencia`, un helper local en `routes/platform.ts`) para no duplicar esa lógica dos veces.

## CLI: `npm run tenant:create`

```bash
npm run tenant:create -- --tenantNombre="Minera Cushuro" --tenantSlug=cushuro \
  --adminNombre="Admin Cushuro" --adminEmail=admin@cushuro.com --adminPassword=... \
  [--planCodigo=mediana]
```

Llama al mismo `onboardTenantService` directo (sin pasar por HTTP ni necesitar el token de super-admin) — pensado para el alta inicial de un cliente desde una terminal con acceso a la base (deploy, soporte), igual que `migrate.ts`/`scripts/diagnosticoQueries.ts` son wrappers finos sobre servicios ya probados, sin lógica propia que testear aparte. La auditoría queda con `actorType: "system"`, `actorLabel: "cli:tenant:create"` — se sabe que fue un alta por CLI, no por el panel.

## Dos pasos del pedido original que NO se implementaron, y por qué

Evaluado contra el código real antes de escribir nada (no asumido):

1. **"Aprovisionar particiones iniciales si aplica"** — no aplica. El particionado de `checklists`/`ipercs` (migración 0037) es por **mes**, no por tenant: todos los tenants comparten las mismas particiones mensuales, que ya garantiza `particionado.worker.ts` corriendo con margen de 3 meses. Un tenant nuevo no necesita ninguna partición propia.
2. **"Sembrar datos maestras (roles, permisos, catálogos base)"** — no existe ese concepto en este sistema. Los roles son un enum fijo (`admin`/`operador`/`lectura`), y ningún módulo tiene un "catálogo base" por tenant — cada cliente arma su propio catálogo de equipos, plantillas de checklist y línea base de IPERC desde cero, a propósito: son mineras distintas, con equipos y procesos de riesgo distintos. Sembrar datos de ejemplo acá inventaría un requisito que ningún módulo pide, y que probablemente el cliente tendría que borrar antes de cargar los suyos.

## Tests

`tests/tenant-onboarding.test.ts` cubre lo que este trabajo agrega (no reprueba `/tenants`, que ya está cubierto en otros lados):

- Alta completa con `planCodigo` — 201, plan aplicado, módulos habilitados, admin con rol `admin`.
- Sin `planCodigo` — sigue funcionando igual que antes (`plan_id` queda `NULL`).
- `planCodigo` inexistente (404) o desactivado (400) — en ambos casos el tenant **no** queda creado (se verifica consultando por `slug` después del fallo): la atomicidad real, no solo el mensaje de error.
- `Idempotency-Key` repetida — misma respuesta, un solo tenant.
- Sin autenticación — 401.
- Gate de super-admin (solo con Redis real disponible, igual que el resto de los tests de sesión individual): un platform admin normal recibe 403 en `/onboard` pero sigue pudiendo usar `/tenants`.
