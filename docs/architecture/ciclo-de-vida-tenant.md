# Ciclo de vida del tenant

`tenants.estado` reemplaza al viejo booleano `activo` como fuente de verdad
(migración `0038_tenant_estado_ciclo_vida.sql`). Cuatro estados posibles:

| Estado | Significado | Quién lo asigna hoy |
|---|---|---|
| `provisioning` | La fila existe, el tenant todavía no está operativo del todo. | **Nadie** — ver "Lo que falta" abajo. |
| `active` | Operación normal. | `crearTenantConAdminService` (default de todo tenant nuevo) y `cambiarEstadoTenantService` con `activo: true`. |
| `suspended` | Acceso cortado — no puede loguear, sesiones abiertas se cortan en ≤60s (mismo mecanismo que la revocación por `token_version`). Reversible. | `cambiarEstadoTenantService` con `activo: false`. |
| `pending_deletion` | Baja programada, en camino a purgarse. | **Nadie** — ver "Lo que falta" abajo. |

## `activo` es una columna calculada, no independiente

```sql
activo BOOLEAN GENERATED ALWAYS AS (estado = 'active') STORED
```

Postgres la recalcula sola en cada cambio de `estado` — no hay forma de que
diverjan, porque ya no se puede escribir `activo` directo (cualquier
`INSERT`/`UPDATE` que lo intente falla). Todo el código que hoy **lee**
`activo` (`auth.middleware.ts`, `auth.service.ts`,
`resolveTenantSubdomain.ts`) sigue funcionando exactamente igual: `activo =
true` es, por definición de la columna, lo mismo que `estado = 'active'`.
No hizo falta tocar esos chequeos para que sigan siendo correctos.

## Por qué el endpoint sigue recibiendo `activo: boolean`

`PATCH /api/platform/tenants/:id/estado` (`cambiarEstadoTenantService`)
sigue aceptando `{ activo: boolean, motivo }` — el mismo contrato que ya
usa el panel (`CambiarEstadoDialog.tsx`). Interno, se traduce a
`estado: activo ? 'active' : 'suspended'`. Es deliberado: esta migración
llevó el ciclo de vida completo al esquema sin tener que tocar el
frontend. `provisioning` y `pending_deletion` quedan disponibles en la
base, pero **ningún camino de código los asigna todavía**.

## Lo que falta (fuera de alcance de esta migración a propósito)

- **`provisioning`**: hoy `crearTenantConAdminService` deja el tenant
  usable de inmediato (admin puede loguear apenas se crea) — no hay un
  paso de onboarding intermedio real. Asignar este estado tiene sentido
  recién cuando exista algo que bloquear mientras tanto (ej. verificación
  de dominio, aprobación manual).
- **`pending_deletion` + worker de hard-delete**: no existe ningún proceso
  que purgue un tenant en este estado. Antes de asignarlo a un tenant real
  hace falta decidir (fuera del alcance de código, es una decisión de
  producto/compliance):
  - Cuánto tiempo vive un tenant en `pending_deletion` antes del borrado
    real (período de gracia).
  - Si el hard-delete borra todo de una (reutilizar el mismo grafo de
    `raices`/`tablas` del registry de módulos que ya usa
    `platformBackup.service.ts` para backup/restore, en el orden inverso)
    o si primero fuerza un backup final.
  - Quién puede sacar a un tenant de `pending_deletion` antes de que se
    cumpla el plazo (arrepentimiento del cliente, error del operador).
- **UI del panel**: `CambiarEstadoDialog.tsx` sigue ofreciendo solo
  activar/desactivar (`active`/`suspended`). Exponer `provisioning` y
  `pending_deletion` en la interfaz no tiene sentido hasta que exista el
  código que lea/actúe sobre esos estados — antes de eso sería un botón
  que no hace nada distinto de lo que ya hace.

## Verificación

`tests/tenant-deactivation.test.ts` prueba el flujo activo↔suspended de
punta a punta (login bloqueado, sesión cortada, reactivación) contra el
endpoint tal como está hoy — no hizo falta tocarlo, es la prueba de que el
contrato externo no cambió.
