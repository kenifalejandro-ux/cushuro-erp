# Backups en S3: estructura, cifrado, retención y restore

- **Estado**: vigente desde 2026-08-03 (migración `0032_backups_s3.sql`).
- **Relacionado**: [ADR-0001](../adr/0001-multi-tenancy-plataforma.md) (RLS y aislamiento), [ADR-0002](../adr/0002-contrato-de-modulo.md) (el inventario de tablas de un backup de tenant sale del registry de módulos), [guía de rendimiento](database-performance-guidelines.md).

---

## Qué cambió y por qué

Los backups vivían como JSON **plano y sin cifrar** en `BACKUPS_DIR` (disco local). Tres problemas: no sobreviven a la pérdida del servidor, contienen `usuarios.password_hash` en texto legible para cualquiera con acceso al filesystem, y no había ninguna política de retención (crecían para siempre).

Ahora: **gzip + AES-256-GCM del lado del cliente → subida multipart a S3** (o Cloudflare R2 / MinIO / Backblaze B2), con retención GFS automatizada y un backup nuevo de la capa de plataforma.

### Una aclaración sobre el formato

**El backup no es un `pg_dump` ni contiene SQL.** Es un documento JSON armado con `SELECT * FROM <tabla> WHERE tenant_id = $1` por cada tabla declarada en el registry de módulos, dentro de una sola transacción `withTenant()`. Fue una decisión explícita desde el día uno (no depender de `pg_dump` ni de ningún binario externo), y es lo que permite que el restore **remapee ids** para clonar un tenant sobre otro.

Por eso las keys terminan en **`.json.gz.enc`** y no en `.sql.gz.enc`: la extensión describe lo que hay adentro.

---

## 1. Estructura de keys

```
backups/tenants/{tenant_id}/{YYYY}/{MM}/backup_{tenant_id}_{TIMESTAMP}.json.gz.enc
backups/platform/{YYYY}/{MM}/platform_{TIMESTAMP}.json.gz.enc
```

Ejemplo real:

```
backups/tenants/11111111-2222-4333-8444-555555555555/2026/03/backup_11111111-2222-4333-8444-555555555555_20260309T014530.421Z-a1b2c3.json.gz.enc
backups/platform/2026/12/platform_20261231T235959.007Z-9f0e1d.json.gz.enc
```

Decisiones detrás de la convención:

- **Un subárbol por tenant.** Permite listar/podar los backups de un cliente sin recorrer los de los demás, y hace posible escribir una IAM policy acotada a `backups/tenants/{id}/*` si alguna vez hay que darle a un cliente acceso de solo lectura a sus propios backups.
- **`{YYYY}/{MM}` con cero a la izquierda.** El orden lexicográfico de las keys coincide con el cronológico, y la poda mensual es un `ListObjectsV2` con prefijo acotado en vez de listar todo el histórico.
- **Timestamp sin `:`** (`20260309T014530.421Z`). S3 los admite, pero rompen las descargas a disco en Windows y complican las URLs firmadas.
- **Milisegundos + sufijo random al final del timestamp.** Sin esto, dos backups del mismo tenant (o dos de plataforma) creados dentro del mismo segundo comparten key y el segundo write pisa el archivo del primero en el storage — la fila de metadata del primero queda apuntando a un archivo que en realidad es el del segundo. Se encontró con el restore drill (ver más abajo), que comparó el contenido leído contra su propio manifiesto y encontró un backup "completo" cuyo archivo no era el suyo.
- **Plataforma en un prefijo separado.** No pertenece a ningún tenant y su contenido es mucho más sensible — conviene poder darle una política de acceso distinta.

Las keys son idénticas en el driver local, así que `BACKUPS_DIR` es un espejo exacto del layout del bucket: migrar puede ser literalmente un `aws s3 sync`.

---

## 2. Cifrado

### Formato del objeto

```
[ "MCB1" 4 bytes ][ IV 12 bytes ][ gzip(json) cifrado con AES-256-GCM ][ authTag 16 bytes ]
└──── cabecera, en claro ──────┘                                       └──── trailer ────┘
```

- **El authTag va al final**, no en la cabecera, porque no existe hasta cifrar el último byte. Es lo que autentica el contenido completo: si alguien altera un solo bit del objeto en el bucket, el descifrado falla en vez de devolver basura.
- **El magic `MCB1`** permite detectar el formato al leer. Un backup viejo (JSON plano) no empieza con esos bytes, así que se sigue restaurando sin tocarlo — la compatibilidad hacia atrás no depende de la extensión del archivo ni de ninguna columna en la base.

### Dos capas, no una

| Capa | Qué protege | Configuración |
|---|---|---|
| **Cifrado de cliente** (AES-256-GCM, antes de salir del proceso) | Un bucket mal configurado como público, credenciales filtradas, y al proveedor de S3 mismo | `BACKUP_ENCRYPTION_KEY` |
| **SSE del servidor** (SSE-S3 / SSE-KMS) | Acceso al almacenamiento físico; da controles de auditoría a nivel bucket | `S3_SERVER_SIDE_ENCRYPTION` |

> ### ⚠ SSE y proveedores S3-compatible
>
> **MinIO rechaza `S3_SERVER_SIDE_ENCRYPTION=AES256`** (el default) con `NotImplemented: Server side encryption specified but KMS is not configured`, salvo que tenga KMS configurado. Cloudflare R2 y Backblaze B2 tienen comportamientos parecidos.
>
> Verificado contra MinIO real: el default rompe out-of-the-box en esos proveedores. **Dejá `S3_SERVER_SIDE_ENCRYPTION` vacío** — el backup igual viaja cifrado con AES-256-GCM del lado del cliente, que es la capa que de verdad importa.
>
> El default se dejó en `AES256` porque AWS S3 es el destino principal y ahí es lo correcto. El fallo es explícito y accionable: el error nombra la variable, cita lo que dijo el proveedor y dice qué hacer.

**Con driver `s3` el cifrado de cliente es obligatorio y falla cerrado**: sin `BACKUP_ENCRYPTION_KEY` el export corta con 503 *antes de mandar un solo byte*. Subir a almacenamiento de un tercero un JSON con `password_hash`, `client_secret` de OIDC y tokens SCIM sin cifrar no es una opción, ni con SSE activo.

**Con driver `local` es opcional**, solo por compatibilidad: los despliegues que ya venían haciendo backups a disco nunca configuraron esa clave, y volverlos irrestaurables de un deploy al otro sería peor que el riesgo que se mitiga. Se emite un `WARN` en **cada** backup sin cifrar (no una sola vez al arrancar, para que no se pierda en el ruido).

`BACKUP_ENCRYPTION_KEY` está deliberadamente separada de `APP_ENCRYPTION_KEY`: un backup tiene que poder restaurarse en un entorno de disaster recovery donde la clave de secretos de la app ya rotó, o todavía no existe.

> **Perder `BACKUP_ENCRYPTION_KEY` = perder todos los backups cifrados con ella.** No hay recuperación. Guardala en el mismo gestor de secretos que `JWT_SECRET` y rotala con el mismo cuidado: rotarla no re-cifra lo viejo, así que hay que conservar la clave anterior mientras queden backups hechos con ella.

---

## 3. Memoria: qué resuelve el streaming y qué no

La subida usa `@aws-sdk/lib-storage`, que parte en multipart automáticamente cuando el contenido supera los 5 MiB (4 partes en paralelo). El pipeline `JSON → gzip → cipher → S3` es incremental: no se materializa ninguna copia completa del contenido comprimido ni cifrado.

**Pero el techo real de memoria no es ese.** El JSON se arma entero en RAM (`JSON.stringify` de todas las filas de todas las tablas del tenant) *antes* de que el streaming entre en juego. Lo que el streaming evita son las copias **adicionales** —comprimir y cifrar en pasos separados serían dos buffers completos más—, no el piso que impone construir el documento.

Bajar ese piso de verdad requiere exportar por cursor a NDJSON (una fila por línea, sin nunca tener el documento completo en memoria), lo cual cambia también el formato del backup y el restore. **Es un rediseño del export, no de esta capa, y queda fuera de alcance.** Para el volumen actual (piloto único) no hace falta; el punto en que empiece a importar se va a notar como picos de RSS durante el export de los tenants más grandes.

La descarga en el restore **sí buffea el objeto completo**, y no es una omisión: GCM no puede autenticar nada hasta tener el authTag del final, y `JSON.parse` necesita el documento entero de todas formas.

---

## 4. Retención

### La política (GFS)

| Antigüedad | Qué se conserva |
|---|---|
| Últimos `BACKUP_RETENTION_DIARIO_DIAS` días | **Todos** |
| Entre eso y `BACKUP_RETENTION_MENSUAL_MESES` meses | **Solo el primero de cada mes** |
| Más viejo | Nada |

Valores sugeridos: `BACKUP_RETENTION_DIARIO_DIAS=30`, `BACKUP_RETENTION_MENSUAL_MESES=12`.

Detalles que importan:

- **El "primero de cada mes" se calcula al podar, no se marca al crear.** Si el mensual de marzo desaparece por otra vía, el siguiente backup de marzo ocupa ese lugar solo. Marcarlo al crear dejaría meses sin ningún backup conservado.
- **El cupo mensual es por tenant.** El primer backup de marzo de un cliente no consume el cupo de los demás.
- **Las dos variables tienen que estar en > 0.** Con una sola configurada el worker no borra nada: el default `0` de la otra haría que "más viejo que 0 meses" borre todo lo que salga de la ventana diaria — exactamente el error que no se puede permitir en un borrado automático de backups.
- **Apagado por default** (ambas en `0`), mismo criterio que la retención de auditoría: activar el borrado automático es una decisión de negocio/compliance.

### Por qué un worker y no solo S3 Lifecycle Rules

Una lifecycle rule borra el objeto pero **no la fila** en `tenant_backups` / `platform_backups` que lo referencia. Quedarían filas huérfanas que el panel sigue ofreciendo restaurar y que fallan recién al intentarlo — durante un incidente, que es el peor momento posible.

El worker (`platformBackupRetention.worker.ts`) borra las dos cosas, y **solo borra la fila si el objeto se borró de verdad**: al revés, el objeto quedaría en el bucket sin nada que lo referencie, facturando de forma invisible.

### Lifecycle Rules como red de seguridad

Siguen siendo útiles a nivel bucket, con un umbral **más largo** que la política del worker para que no compitan. Configuración recomendada:

```json
{
  "Rules": [
    {
      "ID": "backups-red-de-seguridad",
      "Status": "Enabled",
      "Filter": { "Prefix": "backups/" },
      "Expiration": { "Days": 400 }
    },
    {
      "ID": "limpiar-multipart-incompletos",
      "Status": "Enabled",
      "Filter": { "Prefix": "backups/" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
    },
    {
      "ID": "archivar-mensuales-a-glacier",
      "Status": "Enabled",
      "Filter": { "Prefix": "backups/" },
      "Transitions": [{ "Days": 60, "StorageClass": "GLACIER_IR" }]
    }
  ]
}
```

- **400 días** (> 12 meses + margen): si el worker deja de correr, el bucket no crece para siempre, pero la regla nunca borra algo que el worker todavía debería conservar.
- **`AbortIncompleteMultipartUpload`** limpia partes de subidas que fallaron a mitad de camino. El código ya usa `leavePartsOnError: false`, pero un proceso que muere de golpe no ejecuta ese cleanup — esta regla es la que cubre ese caso.
- **Transición a Glacier IR** es opcional y solo tiene sentido si el volumen lo justifica; ojo que restaurar desde Glacier no es inmediato.

Complementá con **versionado del bucket + MFA delete** (o Object Lock en modo governance) si el modelo de amenaza incluye a alguien con credenciales intentando borrar los backups.

---

## 5. Backups de plataforma

Un backup de tenant no contiene el registro de **qué tenants existen**. Sin eso, ante la pérdida total de la base no habría ni siquiera a dónde restaurarlos.

| Entra | Por qué |
|---|---|
| `tenants` | Sin esto no hay a dónde restaurar ningún backup de tenant |
| `platform_admins` | Quién puede operar el panel (incluido su SSO) |
| `tenant_modulos`, `usuario_modulos` | Qué contrató cada cliente — información comercial que no vive en ningún otro lado |
| `tenant_sso_config`, `tenant_scim_config` | Reconstruirlas exige volver a coordinar con el IT de cada cliente |

| **No** entra | Por qué |
|---|---|
| Datos de negocio y `usuarios` | Ya viajan en el backup de cada tenant; duplicarlos acá copiaría todo el sistema en cada backup de plataforma |
| `platform_audit_log` | Append-only, crece sin techo y tiene su propia retención. Archivarlo es un problema distinto |
| `platform_outbox` | Cola transitoria: restaurar eventos viejos re-dispararía side effects ya procesados |
| `refresh_tokens`, `reset_tokens` | Estado de sesión efímero; restaurarlo revive sesiones que deberían estar muertas |

### El restore de plataforma es ADITIVO

A diferencia del restore por tenant (que vacía antes de restaurar, como punto de restauración), este **solo inserta lo que falta y nunca modifica ni borra lo existente** (`ON CONFLICT DO NOTHING`).

Vaciar sería catastrófico: un `DELETE` sobre `tenants` cascadea hacia todo el sistema, y un restore de plataforma se ejecuta justamente durante un incidente.

- **Sí resuelve**: reconstruir la plataforma sobre una base vacía (DR real), y recuperar filas borradas por error.
- **No resuelve**: revertir una *modificación*. Si a un tenant le cambiaron el nombre o los módulos, restaurar no lo vuelve atrás — la fila ya existe y se respeta. Deshacer eso es un cambio manual y puntual.

`usuario_modulos` referencia `usuarios`, que **no** viaja en este backup: las filas cuyo usuario no existe hoy se saltean y se reportan en `filasSalteadasPorFk` en vez de hacer fallar todo el restore. El orden correcto en un DR completo es: **restaurar plataforma → restaurar cada tenant → volver a restaurar plataforma** (la segunda pasada recupera los `usuario_modulos` que la primera salteó).

---

## 6. Endpoints

Los de tenant no cambiaron de contrato — solo agregan `storage` y `storageKey` a la respuesta:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/api/platform/tenants/:id/backups` | |
| `POST` | `/api/platform/tenants/:id/backups` | |
| `POST` | `/api/platform/backups/:backupId/restaurar` | super_admin + `confirmar: true`. **Destructivo** |

Nuevos:

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/api/platform/backups/plataforma` | |
| `POST` | `/api/platform/backups/plataforma` | **super_admin**: materializa los hashes de contraseña de todos los admins y los secretos SSO de todos los clientes en un solo archivo |
| `POST` | `/api/platform/backups/plataforma/:backupId/restaurar` | super_admin + `confirmar: true`. Aditivo |

---

## 7. Errores y auditoría

Cada fallo de backup o restore —`pg` caído, red con S3, credenciales inválidas, clave de cifrado ausente o equivocada, objeto inexistente— deja **las dos cosas**:

1. Una fila en `platform_audit_log` con `resultado = 'failure'` y el mensaje de error en `detalle`.
2. Un log estructurado de **nivel `ERROR`** (no `warn`): quedarse sin backup de un tenant es un incidente operativo, tiene que despertar a alguien.

Un backup que falla en silencio es peor que no tener backups, porque genera confianza infundada.

El restore corre dentro de la transacción de `withTenant()`, así que un fallo a mitad de camino hace `ROLLBACK` completo: **el tenant nunca queda a medio restaurar**.

---

## 8. Variables de entorno

Ver `.env.example` para la lista completa comentada.

| Variable | Default | Obligatoria |
|---|---|---|
| `BACKUP_STORAGE_DRIVER` | `local` | No |
| `BACKUP_ENCRYPTION_KEY` | — | **Sí con driver `s3`** |
| `BACKUPS_DIR` | `./backups` | No (driver local) |
| `S3_BUCKET_NAME` | — | Sí con driver `s3` |
| `S3_REGION` | `us-east-1` | No |
| `S3_ENDPOINT` | — | Sí para R2/MinIO/B2 |
| `S3_FORCE_PATH_STYLE` | `false` | Suele ser `true` para R2/MinIO |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | — | No — si están vacías el SDK usa IAM role (preferible en AWS) |
| `S3_SERVER_SIDE_ENCRYPTION` | `AES256` | No (vaciala si tu proveedor rechaza el header) |
| `S3_SSE_KMS_KEY_ID` | — | Sí con `aws:kms` |
| `BACKUP_RETENTION_DIARIO_DIAS` | `0` (apagado) | No |
| `BACKUP_RETENTION_MENSUAL_MESES` | `0` (apagado) | No |
| `BACKUP_RETENTION_CHECK_INTERVAL_MS` | `86400000` (24 h) | No |

### Migrar de local a S3

1. Configurar `BACKUP_ENCRYPTION_KEY`, `S3_BUCKET_NAME`, credenciales.
2. `BACKUP_STORAGE_DRIVER=s3` y desplegar.
3. Listo — no hay paso de migración de datos. Los backups nuevos van a S3; los viejos siguen en disco y se siguen pudiendo restaurar, porque cada fila recuerda su propio `storage`.
4. Opcional: `aws s3 sync ./backups s3://bucket/` y `UPDATE tenant_backups SET storage='s3'`. Solo si querés retirar el disco local — no hace falta para que el sistema funcione. Ojo: los backups viejos siguen sin cifrar aunque los muevas al bucket.

### IAM mínima

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
      "Resource": "arn:aws:s3:::mincore-backups/backups/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:ListBucketMultipartUploads"],
      "Resource": "arn:aws:s3:::mincore-backups"
    }
  ]
}
```

`s3:DeleteObject` solo hace falta si la retención por worker está activa; si se delega todo a lifecycle rules, se puede quitar (y conviene, para que un atacante con esas credenciales no pueda borrar backups).

---

## 9. Qué está probado y qué no

### Nivel 1 — tests con mock (`tests/platform-backup-s3.test.ts`, en CI)

Mockea `@aws-sdk/client-s3` con un bucket en memoria. **`@aws-sdk/lib-storage` (`Upload`) NO se mockea**: corre de verdad contra el cliente falso.

Cubre: la convención de keys, que lo que termina en el bucket está efectivamente comprimido y cifrado (verificado sobre los bytes), el roundtrip, la detección de manipulación por GCM, el rechazo de subir sin clave, la compatibilidad con backups viejos en JSON plano, que el driver de lectura sale de la fila y no del entorno, y la clasificación GFS de retención.

### Nivel 2 — verificación contra S3 real (MinIO, ejecutada 2026-08-03)

Se corrió un ciclo completo contra un MinIO local (protocolo S3 real: SigV4, HTTP, multipart). **11/11 pasos OK**, incluyendo: `verificarAccesoBucket`, backup de tenant subido y verificado con `HeadObject`, restore descargando desde el bucket, **multipart real con 14 MiB incompresibles** (3 partes), listado por prefijo, backup y restore de plataforma, y la retención borrando objeto + fila.

**Encontró dos bugs que el mock no podía encontrar**, ambos ya corregidos:

1. **SSE `AES256` rompe en MinIO** (ver el recuadro en la sección 2). Antes se veía como un `500` genérico con la causa solo en los logs; ahora es un `503` que nombra la variable y dice qué hacer.
2. **`tamanoBytes` era un `string`, no un `number`.** `tamano_bytes` es `BIGINT` y node-pg devuelve los BIGINT como string. El tipo TypeScript decía `number` y mentía: cualquier consumidor que sumara tamaños habría obtenido concatenación (`"100"+"200"="100200"`). Se detectó porque `HeadObject.ContentLength === tamanoBytes` daba `false` con ambos valores imprimiendo `4903`.

Para repetirlo: bajar el binario de MinIO, levantarlo (`minio server ./data --address 127.0.0.1:9100`) y correr el flujo con `BACKUP_STORAGE_DRIVER=s3 S3_ENDPOINT=http://127.0.0.1:9100 S3_FORCE_PATH_STYLE=true S3_SERVER_SIDE_ENCRYPTION=`.

### Nivel 3 — pendiente: contra el bucket real del proveedor

**Todavía no se hizo, y no se puede saltear.** MinIO valida el protocolo, no al proveedor. Falta verificar, una sola vez, contra el bucket de verdad (preferentemente de staging, o con prefijo `pruebas/`):

- [ ] Las credenciales/IAM alcanzan: `PutObject`, `GetObject`, `DeleteObject`, `AbortMultipartUpload`, `ListBucket`. La que más se olvida es `AbortMultipartUpload` — falla recién cuando una subida grande se corta.
- [ ] `S3_SERVER_SIDE_ENCRYPTION` es aceptado por ESE proveedor (en AWS sí; en R2/B2 verificalo).
- [ ] El endpoint y `S3_FORCE_PATH_STYLE` correctos (R2/MinIO suelen necesitar `true`).
- [ ] Un backup de tenant **y su restore** completos, sobre un tenant descartable.
- [ ] Un backup lo bastante grande para disparar multipart de verdad sobre la red (latencia y timeouts reales, que en localhost no existen).
- [ ] Las Lifecycle Rules quedaron aplicadas (`aws s3api get-bucket-lifecycle-configuration`).
- [ ] `BACKUP_ENCRYPTION_KEY` guardada en el gestor de secretos, con la certeza de que se puede recuperar. **Si se pierde, los backups cifrados con ella no se recuperan.**

`verificarAccesoBucket()` (`platformBackupS3.ts`) sirve para el chequeo rápido de credenciales/bucket, pero no reemplaza el ciclo completo.
