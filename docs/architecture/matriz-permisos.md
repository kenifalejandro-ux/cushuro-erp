# Matriz de permisos por módulo

Generada automáticamente el 2026-08-10 por `npm run permisos:listar` (`scripts/permisosListar.ts`) — **no editar a mano**, se sobreescribe en cada corrida. Recorre los `*.routes.ts` reales y extrae `requireRole(...)`; no es una segunda fuente de verdad, es una vista legible sobre el código que ya aplica el permiso (ver docs/adr/0002-contrato-de-modulo.md sobre por qué el rol vive por ruta y no centralizado en el registry).

Todas las rutas bajo `/api/erp/*` ya pasan, antes de llegar a esto, por `authMiddleware` (JWT válido) + `tenantMiddleware` + `requireModulo(id)` (el módulo tiene que estar habilitado para ese tenant/usuario) + `requireCuota(id)` en los `POST` que crean recursos con cuota (ver `src/modules/registry.ts`). La columna **Roles** de abajo es la capa ADICIONAL de `requireRole()` por ruta — **"cualquiera"** significa cualquier rol autenticado (`admin`, `operador` o `lectura`), no ausencia de autenticación.

## Repuestos (`repuestos`)

| Método | Ruta | Roles |
|---|---|---|
| GET | /api/erp/repuestos | cualquiera |
| POST | /api/erp/repuestos | admin, operador |
| PUT | /api/erp/repuestos/:id | admin, operador |
| DELETE | /api/erp/repuestos/:id | admin |
| POST | /api/erp/repuestos/bulk | admin, operador |
| GET | /api/erp/repuestos/kpis/dashboard | cualquiera |

## Combustible (`combustible`)

| Método | Ruta | Roles |
|---|---|---|
| GET | /api/erp/combustible | cualquiera |
| GET | /api/erp/combustible/:id | cualquiera |
| PUT | /api/erp/combustible/:id/nivel | admin, operador |

## Documentos (`documentos`)

| Método | Ruta | Roles |
|---|---|---|
| GET | /api/erp/documentos | cualquiera |
| POST | /api/erp/documentos | admin, operador |
| PUT | /api/erp/documentos/:id | admin, operador |
| DELETE | /api/erp/documentos/:id | admin |
| POST | /api/erp/documentos/bulk | admin, operador |

## Dashboard (`dashboard`)

| Método | Ruta | Roles |
|---|---|---|
| GET | /api/erp/dashboard | cualquiera |
| GET | /api/erp/dashboard/kpis | cualquiera |
| GET | /api/erp/dashboard/repuestos-categoria | cualquiera |
| GET | /api/erp/dashboard/valor-categoria | cualquiera |
| GET | /api/erp/dashboard/documentos | cualquiera |
| GET | /api/erp/dashboard/stock-nivel | cualquiera |

## Equipos (`equipos`)

| Método | Ruta | Roles |
|---|---|---|
| GET | /api/erp/equipos | cualquiera |
| POST | /api/erp/equipos | admin, operador |
| PUT | /api/erp/equipos/:id | admin, operador |
| DELETE | /api/erp/equipos/:id | admin |

## Checklists (`checklists`)

| Método | Ruta | Roles |
|---|---|---|
| GET | /api/erp/checklists/plantillas | cualquiera |
| GET | /api/erp/checklists/plantillas/:id | cualquiera |
| POST | /api/erp/checklists/plantillas | admin, operador |
| DELETE | /api/erp/checklists/plantillas/:id | admin |
| GET | /api/erp/checklists | cualquiera |
| GET | /api/erp/checklists/:id | cualquiera |
| POST | /api/erp/checklists | admin, operador |
| DELETE | /api/erp/checklists/:id | admin |

## IPERC (`iperc`)

| Método | Ruta | Roles |
|---|---|---|
| GET | /api/erp/iperc/lineas-base | cualquiera |
| GET | /api/erp/iperc/lineas-base/:id | cualquiera |
| POST | /api/erp/iperc/lineas-base | admin, operador |
| PATCH | /api/erp/iperc/lineas-base/:id/estado | admin |
| DELETE | /api/erp/iperc/lineas-base/:id | admin |
| GET | /api/erp/iperc | cualquiera |
| GET | /api/erp/iperc/:id | cualquiera |
| POST | /api/erp/iperc | admin, operador |
| PATCH | /api/erp/iperc/:id/estado | admin |
| DELETE | /api/erp/iperc/:id | admin |

## Cómo regenerar

```bash
npm run permisos:listar
```
