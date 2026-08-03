# ADR-0001: Arquitectura de multi-tenancy y panel de plataforma

- **Estado**: Aceptado — implementado y probado; **pendiente de commit** (ver [Estado de entrega](#estado-de-entrega)).
- **Fecha de esta versión**: 2026-08-02
- **Alcance**: todo lo construido sobre la fundación multi-tenant original (`migrations/0001`–`0007`) hasta SSO/SCIM.

---

## Resumen ejecutivo

MinCore ERP pasó de un multi-tenancy básico (una tabla `tenants`, RLS activado, sin más infraestructura de plataforma) a un modelo con las piezas que un SaaS B2B maduro necesita para vender a clientes corporativos: **aislamiento de datos verificado por base de datos** (no solo por código de aplicación), **administración propia separada del login de negocio**, **trazabilidad completa de quién hizo qué** (tanto humanos como integraciones), **alta de tenants segura ante fallas de red** (Idempotency-Key + outbox transaccional), **verificación real de propiedad de dominio**, **control de features por cliente con despliegue gradual**, **observabilidad mínima por tenant**, **backup/restore self-service**, y **inicio de sesión corporativo (SSO) + aprovisionamiento automático de usuarios (SCIM)** — el requisito que suelen pedir las empresas medianas/grandes antes de firmar un contrato.

Todo esto se construyó de forma incremental, en 9 rondas de trabajo, cada una validada con tests contra Postgres y Redis reales (no mocks) antes de pasar a la siguiente. **Nada de esto rompió compatibilidad**: el secreto compartido de emergencia sigue funcionando, los tenants sin dominio propio siguen entrando por subdominio, los módulos ya asignados no cambiaron de comportamiento, y el login por contraseña sigue siendo el camino por default en todos los tenants.

**Lo que falta para producción**: nada bloqueante a nivel de código — falta decidir un proveedor SMTP real (para el correo de recuperación de contraseña), y falta el trabajo de "conectar un IdP de verdad" con un cliente real la primera vez que alguien pida SSO (la integración está lista, pero nunca se probó contra Okta/Azure AD reales, solo contra un mock del protocolo OIDC).

---

## Contexto

MinCore arrancó como un ERP para una sola empresa (minería/mantenimiento, con checklists de pre-uso e IPERC como núcleo de negocio) y se transformó en una plataforma multi-cliente. La fundación (`0001`–`0007`) ya daba aislamiento por `tenant_id` + Row-Level Security. Lo que faltaba, identificado en un diagnóstico inicial de arquitectura, era todo lo que separa "un ERP que atiende a varios clientes" de "una plataforma que se puede operar y vender de forma repetible":

- No había forma de saber **quién** administraba la plataforma — un solo secreto compartido (`PLATFORM_ADMIN_TOKEN`), sin auditoría de individuo.
- La creación de un tenant no era segura ante reintentos de red (podía duplicar un tenant).
- No había verificación real de que un cliente controlara el dominio que decía ser suyo.
- Los módulos contratados eran un booleano por tenant, sin forma de hacer un rollout gradual ni versionado.
- Cero observabilidad por tenant — un incidente en un cliente era invisible hasta que ese cliente se quejaba.
- Sin backup/restore self-service — cualquier recuperación de datos era manual, contra la base de producción entera.
- Sin SSO/SCIM — un bloqueante conocido para vender a clientes con IT propio.

## Decisiones

### 1. Aislamiento: RLS como red de seguridad, no el único control

**Decisión**: cada tabla de negocio tiene `FORCE ROW LEVEL SECURITY` con una policy `tenant_id = current_setting('app.tenant_id')::uuid`. Toda lectura/escritura pasa por `withTenant(tenantId, ...)`, que fija ese GUC dentro de una transacción antes de tocar la tabla. `usuarios` se sumó a este esquema en `0010` (venía fuera desde `0001` porque el login todavía no sabía a qué tenant pertenecía un usuario antes de resolverlo).

**Alternativas consideradas**: confiar solo en `WHERE tenant_id = ?` en cada query (rechazado — un solo `WHERE` olvidado en cualquier endpoint filtra datos entre clientes, y no hay forma de detectarlo en code review de forma confiable). RLS lo convierte en un error de *base de datos*, no un bug silencioso.

**Consecuencia aceptada**: cualquier código nuevo que toque una tabla con RLS y use `pool` en vez de `withTenant()` falla en runtime con `invalid input syntax for type uuid: ""` — un error reproducible y detectado por la suite de tests, pero que se sigue cometiendo por descuido (pasó varias veces durante este trabajo, en código de aplicación y en tests). Es el costo aceptado de que la protección sea real.

### 2. Autenticación de plataforma: modo dual, nunca solo uno

**Decisión**: el panel de plataforma acepta dos formas de identificarse, resueltas al mismo `actor` interno:
- **Secreto compartido** (`PLATFORM_ADMIN_TOKEN`) — modo de emergencia, siempre disponible, sin sesión revocable individualmente si Redis no está arriba.
- **Cuentas individuales** (`platform_admins`, `0016`) — email + contraseña (bcrypt), roles `admin`/`super_admin`, sesión en Redis (`sid.<uuid>`) revocable por sesión puntual o por cuenta completa.

**Decisión de diseño explícita**: el secreto compartido **nunca se retira** — es el mecanismo de recuperación si todos los `super_admin` quedan bloqueados. Se protegió con una invariante a nivel de dato: no se puede desactivar al último `super_admin` activo (`pg_advisory_xact_lock` para cerrar la carrera de dos desactivaciones concurrentes).

**Consecuencia**: cada acción de plataforma queda atribuida a un `actor_type` (`platform_admin` | `emergency_shared_secret` | `unauthenticated` | `system` | `scim`, ver más abajo) — la auditoría nunca depende de adivinar quién hizo qué.

### 3. Auditoría estructurada como ciudadano de primera clase

**Decisión**: `platform_audit_log` (`0012`–`0015`, `0017`, `0019`, `0029`) registra cada acción mutante con `actor_type`/`actor_id`/`actor_label` (foto tomada al momento, no resuelta por JOIN — un admin que cambia de nombre no reescribe el historial), `resultado` (success/failure), `session_id`, `request_id`, `user_agent`, paginación por cursor `(creado_en DESC, id ASC)`. `registrarAuditoria()` **nunca lanza** — un fallo al auditar no debe romper la acción real.

**Decisión de retención** (`0019`): documentada pero **no forzada por default** (`PLATFORM_AUDIT_RETENTION_DAYS=0` = desactivada) — guardar de más nunca rompe compliance, borrar de menos sí. Particionado evaluado y descartado por ahora (volumen no lo justifica).

**Rate limiting de auditoría**: un intento de fuerza bruta contra el secreto compartido audita como máximo un rechazo por IP cada 5 minutos (`registrarSesionRechazada`) — sin esto, un script de ataque infla la tabla con filas casi idénticas.

### 4. Idempotencia + Outbox transaccional

**Problema cerrado**: un retry de `POST /tenants` (timeout de red, doble click) podía crear dos tenants — el `UNIQUE(slug)` no alcanza si el segundo intento usa un slug distinto o si el primero sí llegó a la base pero la respuesta se perdió en el camino.

**Decisión** (`0018`, endurecido en `0024`): `platform_outbox` — cualquier evento que necesite un efecto fuera de la transacción principal (cachear una respuesta idempotente en Redis, una alerta futura) se escribe **dentro de la misma transacción** que el cambio de negocio. El índice único `(tipo, clave)` es el backstop de correctitud: dos transacciones concurrentes con la misma `Idempotency-Key` nunca vista, la segunda choca ahí y se revierte entera — tenant incluido. Un worker simple (`setInterval`, sin colas externas) drena la tabla con `FOR UPDATE SKIP LOCKED` + lease de 30s (seguro con más de una instancia del server corriendo el worker), backoff exponencial ante fallos, y `ultimo_error` para diagnóstico.

**Alternativas descartadas**: Kafka/Debezium/CDC — sobredimensionado para un panel de administración, no un pipeline de eventos de alto tráfico.

### 5. Dominio propio con verificación real

**Decisión** (`0009`, `0020`): un tenant puede pedir un dominio propio (`cushuro.pe`), pero **no resuelve logins hasta que se verifica** vía TXT record DNS (`_mincore-verification.<dominio>`, subdominio dedicado para no chocar con SPF/DKIM existentes). Estados: `pendiente_verificacion` → `activo` | `fallido` → `desactivado`. `resolveTenantSubdomain.ts` solo resuelve por Host si `dominio_estado = 'activo'`.

**Por qué importa**: sin esto, asignar un dominio a un tenant lo hacía resolver logins de inmediato, sin confirmar que el cliente controlara ese dominio de verdad — un problema de seguridad real (alguien podría reclamar un dominio ajeno).

### 6. Módulos por tenant: estado granular + rollout gradual

**Decisión** (`0008` → `0021`): de un booleano `habilitado` se pasó a `estado` (`habilitado`|`deshabilitado`|`rollout`) + `rollout_porcentaje` + `version`. El efectivo en login es la intersección `tenant_modulos ∩ usuario_modulos`, con bucketing determinístico (`md5(tenantId:modulo:usuarioId) % 100`) para que un usuario en rollout no vea el módulo aparecer/desaparecer al azar entre logins.

**Compatibilidad**: backfill automático de `habilitado=true` → `estado='habilitado'` en la misma migración — ningún tenant existente cambió de comportamiento.

### 7. Observabilidad básica por tenant

**Decisión** (`0022`): métricas **agregadas por hora**, no un log de eventos completo (`tenant_metricas_horarias`: requests, errores 5xx, recursos creados) — bounded growth, suficiente para un endpoint de salud (`usuariosActivos`, `ultimoAcceso`, `tasaError`, `alertas[]` con umbrales fijos: `UMBRAL_TASA_ERROR=5%`, mínimo 20 requests para alertar). **Explícitamente no** un sistema Prometheus/Grafana completo — eso es una decisión a futuro, no tomada acá.

### 8. Backup/restore por tenant

**Decisión** (`0023`): exportación completa a JSON (no `pg_dump`) de las 13 tablas de negocio del tenant, con **remapeo condicional de IDs**: preserva IDs originales al restaurar sobre el mismo tenant, genera IDs nuevos + reescribe FKs al clonar hacia un tenant distinto (evita colisión con datos que ya existen ahí). Cada backup/restore queda auditado; restaurar bump-ea `token_version` de los usuarios restaurados (invalida JWTs viejos). Storage local por default, `platformBackupStorage.ts` aislado para poder pasar a S3-compatible sin tocar el resto del flujo.

### 9. SSO (OIDC) + SCIM

**Decisión**: dos dominios de identidad separados, cada uno con su propio modelo — nunca se cruzan `platform_admins` con `usuarios` de un tenant.

| | Platform Admin | Tenant |
|---|---|---|
| Proveedores | Uno global (env `PLATFORM_SSO_*`) | Uno por tenant (`tenant_sso_config`, cifrado) |
| Migración | `0025` | `0026`, `0027` |
| Secreto | Env var (operado por el equipo) | Cifrado en BD (AES-256-GCM, `APP_ENCRYPTION_KEY`) |

**Sin auto-provisioning en ningún caso** — mismo criterio que el login con Google, precedente ya existente: el SSO solo *verifica identidad*, nunca decide *si alguien puede entrar*. La cuenta tiene que existir de antes. El primer login exitoso *linkea* por email (si el usuario no tiene `sso_subject` de ese proveedor todavía); de ahí en más entra por `sub`, más robusto que el email ante un cambio en el IdP.

**SCIM** (`0028`, router `/scim/v2/*`) es un problema *distinto* — provisioning, no autenticación: un token de bearer por tenant (hash sha256, mismo criterio que `refresh_tokens`), que reusa los services ya existentes de alta/baja de usuario (`crearUsuarioEnTenantService`, `cambiarEstadoUsuarioService`) con `actor_type='scim'` en la auditoría (`0029`).

**Seguridad, protocolo real**: `openid-client` (Authorization Code + PKCE), `state`/`nonce` en Redis con TTL de 5 min y uso único (anti-replay).

---

## Tabla de migraciones (referencia)

| # | Qué agrega |
|---|---|
| 0001–0007 | Fundación: tenants/usuarios, tablas de negocio, token_version, refresh tokens, RLS inicial, checklists/IPERC |
| 0008 | Módulos por tenant/usuario (panel de plataforma) |
| 0009 | Dominio propio (sin verificación todavía) |
| 0010 | RLS en `usuarios` |
| 0011 | Recuperación de contraseña |
| 0012–0015, 0017, 0019 | Auditoría de plataforma (evolución completa) |
| 0016 | Cuentas individuales de Platform Admin |
| 0018, 0024 | Outbox transaccional (+ backoff/lease) |
| 0020 | Verificación de dominio (DNS TXT) |
| 0021 | Módulos granulares + rollout |
| 0022 | Métricas horarias (observabilidad) |
| 0023 | Backups de tenant |
| 0025–0029 | SSO (Platform Admin + tenant) y SCIM |

## Estado de entrega

Todo lo descrito está **implementado, tipado sin errores (server + client) y cubierto por tests** (120 tests + 3 skip intencional, contra Postgres y Redis reales). **Nada está commiteado a git todavía** — es trabajo de sesión, listo para revisar y commitear en el orden en que se construyó (ver el detalle de cada ronda en las conversaciones previas).

## Fuera de alcance / deuda técnica conocida

- **SAML** — solo el modelo lo deja preparado (`tenant_sso_config.proveedor CHECK IN ('oidc','saml')`), sin implementación.
- **KMS real** para `APP_ENCRYPTION_KEY` — hoy es una sola clave de aplicación en env, sin rotación gestionada ni HSM.
- **Observabilidad completa** (Prometheus/Grafana, tracing distribuido) — lo que existe es un endpoint de salud mínimo, a propósito.
- **SMTP real** — el envío de correo de recuperación de contraseña está implementado pero nunca se probó con credenciales reales.
- **SSO/SCIM contra un IdP real** — la integración está probada contra un mock del protocolo OIDC (tests), no contra Okta/Azure AD/Google Workspace en producción.
- **Mapeo de grupos del IdP a roles** vía SCIM — no implementado, todo usuario provisionado por SCIM entra con rol default.
- **Particionado de `platform_audit_log`** — evaluado y descartado por volumen insuficiente; revisar si el volumen cambia.
