# ADR-0002: Contrato de Módulo

- **Estado**: Aceptado — implementado y probado (tests + smoke test manual en navegador).
- **Fecha**: 2026-08-02
- **Alcance**: cómo se registra, construye y opera un módulo del ERP (Repuestos, Combustible, Documentos, Dashboard, Equipos, Checklists, IPERC, y cualquiera que se agregue después). No toca multi-tenancy/plataforma en sí (ver [ADR-0001](0001-multi-tenancy-plataforma.md)), que ya está resuelto — este documento asume esa fundación y construye sobre ella.

---

## Resumen ejecutivo

Hasta hoy, "qué módulos tiene el ERP" no era una lista — eran **cinco listas separadas que nadie sincronizaba**: el enum `modulo_erp` de Postgres, la constante `MODULOS_ERP` en el backend, el montaje de rutas en `routes/index.ts`, el array de pestañas del `Sidebar.tsx`, y el `switch` de pantallas en `App.tsx`. La consecuencia real, no hipotética: **Equipos, Checklists e IPERC tenían backend completo (rutas, RLS, permisos) pero eran invisibles en el cliente** — nadie los agregó al Sidebar ni a `App.tsx` después de construirlos, y nada fallaba para avisarlo.

Este ADR define un Contrato de Módulo y lo hace cumplir con código, no solo con documentación:

- **Un registry por lado** (`src/modules/registry.ts` en el backend, `client/src/modules/registry.tsx` en el cliente) es ahora la única fuente de verdad de la que se _derivan_ rutas, validación, backup/restore y el menú — en vez de mantenerse a mano en cada lugar.
- **Dos tests de CI nuevos** (`tests/module-registry.test.ts`, `tests/rls-coverage.test.ts`) convierten el drift de "alguien agregó un módulo a medias" en un fallo de test, no en un bug que se descubre meses después.
- Equipos, Checklists e IPERC ya tienen pantalla en el cliente (mínima, no el flujo completo — ver "Fuera de alcance").
- Todo módulo de negocio ahora audita sus acciones de escritura en `platform_audit_log` (antes solo el panel de plataforma auditaba algo).

**Lo que se preservó tal cual, porque ya funcionaba bien**: el patrón de RLS por tabla, el enum de Postgres como guardia real a nivel de BD, `tenantMetricsMiddleware` (cobertura automática de salud/métricas para cualquier módulo sin tocar nada), y la UI del panel de plataforma para módulos por tenant/usuario (ya era 100% data-driven, nunca tuvo una lista hardcodeada de módulos).

---

## El problema, con evidencia concreta

Antes de este cambio, registrar un módulo requería tocar a mano:

1. `migrations/0008_platform_modulos.sql` (después, cualquier migración que ampliara el enum `modulo_erp`).
2. `MODULOS_ERP` en `src/server/schemas/platform.schema.ts` — con un comentario literal diciendo "mantenerlos sincronizados".
3. `routes/index.ts` — un `router.use("/x", requireModulo("x"), xRoutes)` por módulo.
4. `Sidebar.tsx` — un array `TODAS_LAS_PESTAÑAS` hardcodeado.
5. `App.tsx` — un union type + un `if` por pestaña.

Nada fallaba si alguno de los 5 quedaba desactualizado. Resultado real: Equipos, Checklists e IPERC (migrations `0006`/`0007`, con RLS, permisos por rol y rutas completas) nunca llegaron a `Sidebar.tsx` ni a `App.tsx` — invisibles para cualquier usuario del ERP desde que se crearon, hasta este cambio.

Otros dos gaps encontrados durante el diagnóstico:

- **Backup/restore**: `TABLAS_TENANT` en `platformBackup.service.ts` era un array mantenido a mano. Un módulo nuevo cuyas tablas no se agregaran ahí quedaba fuera del backup **en silencio** — sin error, solo sin exportar esas filas.
- **Auditoría**: `registrarAuditoria()` solo se usaba en `platform.service.ts`. Ningún módulo de negocio (ni los 4 viejos ni los 3 nuevos) auditaba create/update/delete — el panel de plataforma podía ver _sus propias_ acciones, pero nada de lo que pasaba dentro de un tenant.

---

## Decisiones

### 1. Registro del módulo

**Decisión**: `src/modules/registry.ts` es la fuente de verdad en código. Cada entrada (`ModuloDefinicion`, ver `src/modules/types.ts`) declara `id`, `label`, `icono`, `version`, su `router` de Express, y sus tablas de backup (`tablas` + `raices`, ver más abajo). De ahí se derivan:

- `MODULOS_ERP` en `platform.schema.ts` (para validación con Zod) — antes era una constante hardcodeada.
- El montaje de rutas en `routes/index.ts` — antes era un `router.use()` por módulo escrito a mano.
- `TABLAS_TENANT` y el orden de wipe en `platformBackup.service.ts` — antes eran arrays hardcodeados.

**El enum `modulo_erp` de Postgres sigue existiendo aparte, a propósito.** No se generó dinámicamente desde el registry porque da algo que TypeScript no puede dar: un `CHECK` real a nivel de base de datos, que sigue protegiendo `tenant_modulos`/`usuario_modulos` incluso si algún día algo escribe ahí sin pasar por el código de la app. El costo de mantener dos listas se paga con `tests/module-registry.test.ts` (ver más abajo), no evitándolo.

**Versionado**: `version` es un string libre por módulo en el registry (hoy: `"v1"` en los 7). Es la misma semántica que ya existía en `tenant_modulos.version` (migración `0021`) — puramente informativo, ningún consumidor de `modulosPermitidos` lo lee todavía. No se construyó nada más elaborado (semver, migraciones de versión) porque nadie lo necesita hoy — ver "Fuera de alcance".

### 2. Base de datos

**Convención** (ya existía, ahora reforzada por test): toda tabla de negocio de un módulo lleva `tenant_id UUID NOT NULL REFERENCES tenants(id)`, incluidas las tablas "hijas" de detalle (no solo el header) — así RLS aplica parejo sin depender de que cada query haga JOIN hasta el padre. Índice `idx_<tabla>_tenant_id` en cada una. Un módulo nuevo agrega su propia migración `NNNN_nombre_del_modulo.sql`.

**RLS desde el día uno — ahora garantizado por test, no por convención.** `tests/rls-coverage.test.ts` recorre `pg_class`/`pg_policies` directamente (no una lista mantenida a mano) y falla si aparece una tabla con `tenant_id` sin `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + una policy `tenant_isolation`, salvo que esté en una allowlist explícita y documentada (las tablas de plataforma que a propósito no tienen RLS: `tenant_modulos`, `platform_audit_log`, `tenant_scim_config`, `refresh_tokens`, `reset_tokens`, `tenant_metricas_horarias`, `tenant_backups`, `tenant_sso_config`). Antes de este test, que una tabla nueva tuviera RLS dependía 100% de que el desarrollador copiara el bloque `DO $$ ... $$` de una migración anterior.

**Backup/restore automático.** Cada módulo declara `tablas: TablaBackupMeta[]` (nombre, tipo de PK, columnas `GENERATED` a excluir al restaurar, y sus FKs hacia otras tablas del mismo backup) en orden seguro de INSERT — padres antes que hijos. `platformBackup.service.ts` concatena `usuarios` (núcleo de auth, no es de ningún módulo) + las tablas de todos los módulos, en el orden del registry. El wipe (`vaciarDatosDeTenant`) usa `raices` — el subconjunto de tablas de un módulo que necesita `DELETE` explícito porque no cascadea desde otra tabla del mismo backup — invertido automáticamente (invertir un orden válido de INSERT siempre da un orden válido de DELETE). Un módulo nuevo que declare mal sus tablas ya no rompe el backup en silencio: si `raices` referencia un nombre que no está en `tablas`, `tests/module-registry.test.ts` lo detecta.

### 3. Permisos y features

**Sin cambios en el mecanismo, ya funcionaba bien**: `requireModulo(id)` sigue siendo el gate a nivel de router — bloquea el módulo entero si `usuario.modulosPermitidos` (intersección `tenant_modulos ∩ usuario_modulos`, calculada en login/refresh) no lo incluye. `requireRole(...)` sigue siendo el control fino por ruta dentro de un módulo (ej. `admin` para borrar, `admin`+`operador` para crear).

**Sub-features**: no existe un mecanismo dedicado, y se decidió **no construir uno** en esta ronda — ver "Fuera de alcance". Hoy la granularidad más fina que un módulo completo es el rol por ruta (`requireRole`), que ya cubre el caso real que existe (ej. solo `admin` aprueba/rechaza un IPERC).

### 4. Backend

**Estructura de carpetas** (ya existía, se formaliza como parte del contrato): `src/modules/<id>/<id>.routes.ts` + `.controller.ts` + `.service.ts` + `.repository.ts`. El `router` de `<id>.routes.ts` es lo único que el registry necesita importar.

**Montaje de rutas**: automático, vía `for (const modulo of MODULOS) router.use(`/${modulo.id}`, requireModulo(modulo.id), modulo.router)` en `routes/index.ts`. Agregar un módulo ya no toca este archivo.

**Auditoría — nueva, parte de este contrato.** `src/server/shared/utils/moduleAudit.ts` expone `contextoAuditoriaModulo(req)`, que arma un `ContextoAuditoria` con el nuevo `actorType: "tenant_usuario"` (migración `0030`, extiende el `CHECK` de `platform_audit_log`). Todo `create`/`update`/`delete`/cambio de estado en Equipos, Checklists e IPERC ahora llama `registrarAuditoria(...)` con ese contexto — antes ningún módulo de negocio dejaba rastro. `detalle` lleva solo ids/referencias, nunca contenido de negocio, mismo criterio que ya usaba `platform.service.ts`.

### 5. Frontend

**Registro**: `client/src/modules/registry.tsx` — un archivo sin lógica, solo `{ id, label, icono, componente }` por módulo. `id` debe coincidir con el `id` del registry del backend (con un enum de 7 elementos, mantenerlo a mano no es un problema real hoy; ver "Decisiones forzadas por código vs. convención" sobre por qué no se comparte el archivo entre server y cliente).

**Menú**: `Sidebar.tsx` ya no tiene un array hardcodeado — itera `MODULOS_CLIENTE` filtrado por `usuario.modulosPermitidos`, igual que antes pero data-driven.

**Lazy loading**: cada `componente` en el registry es un `React.lazy(() => import(...))`. `App.tsx` busca el módulo activo por `id` y lo renderiza dentro de `<Suspense>`. Verificado con `vite build`: cada módulo (`EquiposTable`, `ChecklistsView`, `IpercView`, `Dashboard`, etc.) generó su propio chunk — el código de un módulo que un usuario no tiene habilitado, o que no abrió, no viaja a su navegador.

**Convención de rutas del cliente**: no hay router (SPA de una sola vista con tabs, decisión ya tomada antes de este ADR — ver `password_reset_audit_platform_ui`, que evaluó agregar uno solo para `/reset-password` y decidió no hacerlo). Un módulo nuevo no necesita rutas de cliente, solo un `id` en el registry.

### 6. Panel de plataforma

**Ya cumplía el contrato antes de este ADR — no se tocó.** `client/src/platform/TenantDetalleView.tsx` obtiene la lista de módulos de un tenant desde `GET /api/platform/tenants/:id/modulos` (que a su vez lee `MODULOS_ERP`, ahora derivado del registry) — nunca tuvo una lista hardcodeada en el cliente. Un módulo nuevo aparece automáticamente en el panel apenas existe en el registry + su migración de enum, sin tocar el frontend de plataforma.

**Rollout y versión**: ya soportado desde la migración `0021` (`estado`: habilitado/deshabilitado/rollout con `rollout_porcentaje`, bucketing determinístico por tenant+módulo+usuario; `version`: string libre). Sin cambios en este ADR.

### 7. Observabilidad y operación

**Métricas — ya automático, no se tocó.** `tenantMetricsMiddleware` cuelga del router genérico en `routes/index.ts`, antes de `requireModulo`, así que registra tráfico (incluidos los 403 de módulo no habilitado) para cualquier módulo sin que este declare nada. `obtenerSaludTenantService` (`platformTenantHealth.service.ts`) sigue siendo por tenant, no por módulo — un módulo nuevo queda cubierto por el mismo mecanismo sin código adicional.

**Auditoría de acciones**: ver sección 4 (Backend) — `contextoAuditoriaModulo` + `registrarAuditoria` es lo que un módulo debe llamar en cada mutación.

**Métrica mínima que un módulo debe exponer**: ninguna adicional — el tráfico/errores/recursos-creados de `tenantMetricsMiddleware` ya es automático por diseño de middleware, no algo que cada módulo tenga que declarar.

### 8. Checklist de "Nuevo Módulo"

1. Migración `NNNN_<nombre>.sql`: tablas con `tenant_id NOT NULL REFERENCES tenants(id)` (header e hijas), índices, bloque RLS (`ENABLE` + `FORCE ROW LEVEL SECURITY` + policy `tenant_isolation` — copiar el bloque `DO $$` de `migrations/0006` o `0007`), y `ALTER TYPE modulo_erp ADD VALUE '<id>'`.
2. `src/modules/<id>/`: `routes.ts` + `controller.ts` + `service.ts` + `repository.ts`, siguiendo el patrón de un módulo existente (ej. `equipos/`).
3. Controllers: cada `create`/`update`/`delete`/cambio de estado llama `registrarAuditoria({ accion: "<id>.<accion>", tenantId, usuarioId: req.usuario!.id, detalle: { ...solo ids }, contexto: contextoAuditoriaModulo(req) })`.
4. Agregar el módulo a `src/modules/registry.ts`: `id` (igual al valor del enum del paso 1), `label`, `icono`, `version`, `router`, `tablas` (orden seguro de INSERT, con `fks` si referencia tablas de otro módulo), `raices` (subconjunto que necesita DELETE explícito al vaciar un tenant).
5. Agregar el módulo a `client/src/modules/registry.tsx`: mismo `id`, `label`, `icono`, `componente: lazy(() => import(...))`.
6. Construir la pantalla en `client/src/components/<id>/`.
7. Correr `npm run migrate`, luego `npx vitest run tests/module-registry.test.ts tests/rls-coverage.test.ts` — deben pasar antes de tocar nada más. Después, la suite completa.
8. `npm run build` en `client/` y confirmar que el módulo nuevo generó su propio chunk (code-splitting).
9. Smoke test manual: login, el módulo aparece en el Sidebar, CRUD básico funciona, sin errores en consola.
10. El panel de plataforma (`/plataforma`) ya lo va a mostrar solo — no requiere ningún cambio si los pasos 1 y 4 están bien hechos.

---

## Decisiones forzadas por código vs. dejadas como convención

**Forzado por código (falla un test o el tipo no compila si se rompe):**

- Que `MODULOS_ERP` (código) y el enum `modulo_erp` (BD) coincidan exactamente — `tests/module-registry.test.ts`.
- Que toda tabla con `tenant_id` tenga RLS completo, salvo allowlist explícita — `tests/rls-coverage.test.ts`.
- Que `raices` de un módulo sea subconjunto de `tablas` — mismo test de arriba.
- Que las rutas de un módulo respeten `requireModulo` — estructural, viven dentro del loop de `routes/index.ts`, no hay forma de montarlas sin pasar por ahí.

**Dejado como convención (nada lo hace cumplir automáticamente):**

- Que el `id` del registry del cliente coincida con el del backend — un typo ahí produce un módulo que el backend permite pero el Sidebar nunca muestra (el mismo bug que originó este ADR, pero ahora acotado a un solo archivo de una sola línea por módulo, en vez de repartido en 3).
- Que un controller llame `registrarAuditoria` en cada mutación — no hay lint ni test que lo exija. Se decidió no automatizarlo (ej. con un middleware genérico) porque `detalle` necesita criterio humano por acción (qué ids son relevantes, qué NO incluir).
- El orden de `tablas`/`raices` dentro de un módulo respeta las FK reales — si un desarrollador declara un orden incorrecto, el error aparece recién al _restaurar_ un backup (INSERT falla por FK), no antes. Aceptado porque backup/restore ya corre dentro de una transacción (`withTenant`) — un orden incorrecto falla ruidoso, nunca deja datos a medias.

## Fuera de alcance de esta primera versión

- **No se retrofitó auditoría a Repuestos/Combustible/Documentos** (los 4 módulos que ya existían antes de este ADR, sin contar Dashboard que no muta nada). Quedan sin auditoría hasta que se toquen por otro motivo — el contrato exige auditoría para módulos nuevos; los viejos son deuda conocida, no bloqueante.
- **No se construyó un sistema de sub-features** dentro de un módulo (feature flags por función, no por módulo completo). Nadie lo necesita hoy — el rol por ruta (`requireRole`) cubre el único caso real (aprobar/rechazar IPERC solo por `admin`).
- **No se generó el enum `modulo_erp` dinámicamente desde el registry** — sigue siendo una migración manual por módulo nuevo, a propósito (ver Decisión 1).
- **No se compartió un único archivo de registry entre backend y cliente** — son dos builds de Vite/tsx separados; forzar un import cruzado (`client/` importando de `src/modules/registry.ts`, que a su vez importa Express/pg) habría sido más complejidad que el problema que resuelve, para un set de 7 módulos.
- **Las pantallas de Checklists e IPERC son mínimas, no el flujo completo**: cubren listar, crear (plantilla/línea base/checklist/IPERC con ítems manuales) y aprobar/rechazar/eliminar. No cubren editar una plantilla o línea base existente, ni el flujo de "referenciar un ítem ya aprobado de la línea base" al crear un IPERC específico (el backend ya lo soporta vía `linea_base_item_id`, la UI no lo expone todavía) — se dejó así para no inflar el alcance de esta ronda; el backend no tiene ninguna limitación pendiente, es trabajo de UI puro cuando alguien lo necesite.
- **No se versiona el comportamiento por `version`** — sigue siendo metadata informativa (igual que antes de este ADR), no algo que el código lea para branchear lógica.
