/** src/modules/registry.ts
 *
 * Fuente única de verdad para "qué módulos tiene el ERP" — ver
 * docs/adr/0002-contrato-de-modulo.md. Antes de este archivo, un módulo se
 * registraba a mano en 5 lugares que nadie sincronizaba (enum de Postgres,
 * MODULOS_ERP en platform.schema.ts, routes/index.ts, Sidebar.tsx,
 * App.tsx) — así fue como Equipos/Checklists/IPERC terminaron con backend
 * completo pero invisibles en el cliente.
 *
 * De acá se derivan: MODULOS_ERP (platform.schema.ts), el montaje de
 * rutas (routes/index.ts) y la lista de tablas de backup/restore
 * (platformBackup.service.ts). El enum `modulo_erp` de Postgres sigue
 * existiendo aparte (da un CHECK real a nivel de base de datos que este
 * archivo no puede dar) — tests/module-registry.test.ts falla si alguna
 * vez este array y el enum divergen.
 *
 * Agregar un módulo nuevo: ver el checklist en el ADR. En resumen, un
 * `ModuloDefinicion` acá + una migración que sume el valor al enum
 * `modulo_erp` (y le dé RLS a sus tablas) son los dos únicos lugares que
 * hace falta tocar a mano.
 *
 * ── Orden del array: importa, no es solo estético ────────────────────────
 * `platformBackup.service.ts` concatena las `tablas` de todos los módulos
 * EN ESTE ORDEN para el INSERT de un restore -- padres antes que hijos
 * (ver ADR sección 2), y `restaurarTablas()` NO usa
 * `SET CONSTRAINTS ALL DEFERRED` -- el orden real importa, no es solo una
 * guía de lectura. Encadenado hoy: `equipos`/`iperc` antes que
 * `ordenes_trabajo` (FK a ambos), `ordenes_trabajo` antes que `repuestos`
 * (repuestos_movimientos.orden_trabajo_id) y antes que `documentos`
 * (documentos.orden_trabajo_id). `repuestos` se movió de la posición 1 a
 * después de `ordenes_trabajo` en el PR que agregó ese vínculo -- nada más
 * depende de que `repuestos` esté temprano, así que no rompió nada.
 */
import dashboardRoutes from "./dashboard/dashboard.routes";
import repuestosRoutes from "./repuestos/repuestos.routes";
import combustibleRoutes from "./combustible/combustible.routes";
import documentosRoutes from "./documentos/documentos.routes";
import equiposRoutes from "./equipos/equipos.routes";
import checklistsRoutes from "./checklists/checklists.routes";
import ipercRoutes from "./iperc/iperc.routes";
import ordenesTrabajoRoutes from "./ordenes_trabajo/ordenes_trabajo.routes";
import type { ModuloDefinicion } from "./types";

export const MODULOS: ModuloDefinicion[] = [
  {
    id: "combustible",
    label: "Combustible",
    icono: "⛽",
    version: "v1",
    router: combustibleRoutes,
    tablas: [
      { nombre: "combustible", pk: "serial" },
      {
        nombre: "combustible_lecturas",
        pk: "serial",
        fks: { combustible_id: "combustible", usuario_id: "usuarios" },
      },
    ],
    // combustible_lecturas cascadea desde su padre (ON DELETE CASCADE, ver
    // migrations/0045) -- no necesita DELETE propio.
    raices: ["combustible"],
    // Se cuenta el histórico de LECTURAS, no los tanques: los tanques son
    // configuración (unos pocos por tenant, se cargan directo en la base),
    // las lecturas crecen con cada carga en campo -- mismo criterio que
    // checklists (llenados, no plantillas) e iperc (creaciones, no líneas
    // base).
    cuota: { tabla: "combustible_lecturas", porDefecto: 100_000 },
    // Solo registrar una lectura califica para offline -- ver ADR-0002 §8.
    // combustible_id viaja en el body porque rutasOffline.ts solo matchea
    // rutas literales, sin parámetros de URL.
    offline: { escrituras: [{ metodo: "POST", ruta: "/lecturas" }] },
  },
  {
    id: "dashboard",
    label: "Dashboard",
    icono: "📊",
    version: "v1",
    router: dashboardRoutes,
    // Solo lee/agrega datos de otros módulos, no tiene tablas propias.
    tablas: [],
    raices: [],
  },
  {
    id: "equipos",
    label: "Equipos",
    icono: "🚜",
    version: "v1",
    router: equiposRoutes,
    tablas: [{ nombre: "equipos", pk: "serial" }],
    raices: ["equipos"],
    cuota: { tabla: "equipos", porDefecto: 2_000 },
    // Solo crear el equipo califica para offline -- ver ADR-0002 §8. Dar de
    // alta un equipo nuevo en cancha, sin señal, es un caso de campo real
    // (mismo criterio que checklists/iperc/ordenes_trabajo). `PUT`/`DELETE`
    // NO están acá a propósito: editar sobreescribe campos existentes y
    // borrar no debe reintentarse a ciegas.
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "checklists",
    label: "Checklists",
    icono: "✅",
    version: "v1",
    router: checklistsRoutes,
    tablas: [
      { nombre: "checklist_plantillas", pk: "serial" },
      {
        nombre: "checklist_plantilla_items",
        pk: "serial",
        fks: { plantilla_id: "checklist_plantillas" },
      },
      {
        nombre: "checklists",
        pk: "serial",
        fks: { equipo_id: "equipos", plantilla_id: "checklist_plantillas", usuario_id: "usuarios" },
      },
      { nombre: "checklist_items", pk: "serial", fks: { checklist_id: "checklists" } },
    ],
    // checklist_plantilla_items y checklist_items cascadean desde su padre
    // (ON DELETE CASCADE, ver migrations/0006) — no necesitan DELETE propio.
    raices: ["checklist_plantillas", "checklists"],
    // Se cuentan los checklists LLENADOS, no las plantillas: las plantillas
    // son configuración (unas pocas por tenant), los llenados crecen a
    // razón de uno por equipo por turno.
    cuota: { tabla: "checklists", porDefecto: 200_000 },
    // Llenar un checklist es EL flujo de campo: pasa en la cancha, con el
    // equipo delante y muchas veces sin señal. Califica para la cola
    // porque ChecklistsService.crear pasa por idempotentInsert() — un
    // reintento con el mismo cliente_uuid no duplica (migración 0044).
    //
    // Las plantillas NO están acá a propósito: son configuración, se
    // arman desde la oficina con red, y un DELETE encolado a ciegas es
    // justo el tipo de operación que no debe reintentarse sola.
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "iperc",
    label: "IPERC",
    icono: "⚠️",
    version: "v1",
    router: ipercRoutes,
    tablas: [
      {
        nombre: "iperc_lineas_base",
        pk: "serial",
        fks: { aprobado_por: "usuarios", creado_por: "usuarios" },
      },
      {
        nombre: "iperc_linea_base_items",
        pk: "serial",
        columnasExcluidasAlRestaurar: ["nivel_riesgo"],
        fks: { linea_base_id: "iperc_lineas_base" },
      },
      {
        nombre: "ipercs",
        pk: "serial",
        fks: {
          equipo_id: "equipos",
          usuario_id: "usuarios",
          aprobado_por: "usuarios",
          linea_base_id: "iperc_lineas_base",
        },
      },
      {
        nombre: "iperc_items",
        pk: "serial",
        columnasExcluidasAlRestaurar: ["nivel_riesgo"],
        fks: { iperc_id: "ipercs", linea_base_item_id: "iperc_linea_base_items" },
      },
    ],
    // iperc_linea_base_items e iperc_items cascadean desde su padre.
    raices: ["iperc_lineas_base", "ipercs"],
    // Ídem: se cuentan los IPERC, no las líneas base (que son el catálogo
    // de riesgos aprobado, deliberadamente acotado).
    cuota: { tabla: "ipercs", porDefecto: 200_000 },
    // Solo la creación del IPERC califica para offline -- ver ADR-0002 §8.
    // Aprobar/rechazar y crear línea base quedan fuera a propósito (esos
    // NO deben encolarse: ver fix_race_condition_iperc_estado).
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "ordenes_trabajo",
    label: "Órdenes de Trabajo",
    icono: "🛠️",
    version: "v1",
    router: ordenesTrabajoRoutes,
    tablas: [
      {
        nombre: "ordenes_trabajo",
        pk: "serial",
        fks: {
          equipo_id: "equipos",
          iperc_id: "ipercs",
          creado_por: "usuarios",
          asignado_a: "usuarios",
        },
      },
    ],
    raices: ["ordenes_trabajo"],
    cuota: { tabla: "ordenes_trabajo", porDefecto: 50_000 },
    // Solo la creación (`POST /`) califica para offline -- es de los casos
    // más claros del ERP para trabajar sin señal (el equipo se rompe en
    // cancha, se abre la OT ahí mismo). `PATCH /:id/estado` (iniciar/
    // completar/cancelar) NO está acá: es una transición de estado, no una
    // creación, mismo motivo que aprobar/rechazar en IPERC (encolarla a
    // ciegas choca con la misma carrera que resolvió
    // fix_race_condition_iperc_estado). `PUT /:id` tampoco: sobreescribe
    // campos existentes, mismo riesgo que tenía Combustible antes de 0045.
    offline: { escrituras: [{ metodo: "POST", ruta: "/" }] },
  },
  {
    id: "repuestos",
    label: "Repuestos",
    icono: "🔧",
    version: "v1",
    router: repuestosRoutes,
    tablas: [
      { nombre: "repuestos", pk: "serial" },
      {
        nombre: "repuestos_movimientos",
        pk: "serial",
        // orden_trabajo_id referencia una tabla de OTRO módulo (ver
        // migrations/0050) -- hace falta declararlo para que un clonado a
        // otro tenant remapee bien el id, mismo criterio que
        // documentos.orden_trabajo_id. Es la razón por la que `repuestos`
        // tiene que aparecer DESPUÉS de `ordenes_trabajo` en este array
        // (ver el comentario de arriba sobre el orden).
        fks: {
          repuesto_id: "repuestos",
          usuario_id: "usuarios",
          orden_trabajo_id: "ordenes_trabajo",
        },
      },
    ],
    // repuestos_movimientos cascadea desde su padre (ON DELETE CASCADE, ver
    // migrations/0046) -- no necesita DELETE propio.
    raices: ["repuestos"],
    // `cuota` (el catálogo) NO se mueve a repuestos_movimientos -- a
    // diferencia de lo que hizo Combustible con combustible_lecturas en
    // 0045/PR #73, acá el módulo SÍ tiene POST que crea el recurso base
    // (`POST /`, `POST /bulk`), así que un solo `cuota.tabla` compartido
    // habría dejado esas altas sin límite real. En vez de mover el
    // recurso, se declara uno NUEVO y aparte con `cuotasPorRuta` -- ver el
    // comentario largo en modules/types.ts.
    cuota: { tabla: "repuestos", porDefecto: 50_000 },
    // El histórico de movimientos crece con el trabajo de campo (entradas/
    // salidas), no con el catálogo -- mismo criterio que
    // combustible_lecturas, pero como recurso PROPIO en vez de reemplazar
    // el de catálogo (ver el comentario de `cuota` arriba).
    cuotasPorRuta: [
      {
        ruta: "/movimientos",
        metodo: "POST",
        recurso: "repuestos_movimientos",
        tabla: "repuestos_movimientos",
        porDefecto: 100_000,
      },
    ],
    // Solo registrar un movimiento de stock califica para offline -- ver
    // ADR-0002 §8. `repuesto_id` viaja en el body porque rutasOffline.ts
    // solo matchea rutas literales, sin parámetros de URL. Editar (PUT) y
    // la carga masiva por Excel NO están acá a propósito: editar
    // sobreescribe campos existentes (mismo riesgo que tenía Combustible
    // antes de 0045) y el bulk es un flujo de oficina.
    offline: { escrituras: [{ metodo: "POST", ruta: "/movimientos" }] },
  },
  {
    id: "documentos",
    label: "Documentos",
    icono: "📄",
    version: "v1",
    router: documentosRoutes,
    tablas: [
      {
        nombre: "documentos",
        pk: "serial",
        // orden_trabajo_id referencia una tabla de OTRO módulo (evidencia
        // del trabajo -- ver migrations/0049) -- hace falta declararlo acá
        // para que un clonado a otro tenant remapee bien el id, mismo
        // criterio que repuestos_movimientos referenciando repuestos/
        // usuarios. Es la razón por la que `ordenes_trabajo` tiene que
        // aparecer ANTES que `documentos` en este array (ver el comentario
        // de arriba sobre el orden).
        fks: { orden_trabajo_id: "ordenes_trabajo" },
      },
      // El archivo adjunto en sí (PDF/imagen) NO viaja en el backup — vive
      // en R2/disco, aparte de Postgres. Lo que se respalda acá es la fila
      // que lo referencia, que es justo lo que hace falta para que una
      // restauración sobre el MISMO tenant vuelva a enlazar los archivos
      // (que nunca se movieron del storage) con sus documentos.
      //
      // `omitirAlClonar` NO es opcional acá: sin él, clonar a otro tenant
      // le daría al destino filas con storage_key apuntando a los archivos
      // del tenant origen. Ver el comentario largo en modules/types.ts.
      {
        nombre: "documentos_versiones",
        pk: "serial",
        fks: { documento_id: "documentos", subido_por: "usuarios" },
        omitirAlClonar: true,
      },
    ],
    raices: ["documentos"],
    cuota: { tabla: "documentos", porDefecto: 20_000 },
    // Crear el registro (metadata) Y subir el archivo adjunto califican
    // para offline -- ver ADR-0002 §8. `/` cubre también pólizas, SOAT,
    // etc.: son `documentos` con otro `nombre_documento`, no un tipo
    // aparte. `/:id/versiones` es la ruta con archivo binario -- el motor
    // offline lo guarda como Blob en IndexedDB, no como JSON (ver
    // client/src/offline/offlineQueue.ts, CampoFormData). Editar y la
    // carga masiva por Excel quedan FUERA a propósito: editar sobreescribe
    // campos existentes, y el bulk es un flujo de oficina con array grande.
    offline: {
      escrituras: [
        { metodo: "POST", ruta: "/" },
        { metodo: "POST", ruta: "/:id/versiones" },
      ],
    },
  },
];

export const MODULOS_ERP = MODULOS.map((m) => m.id);

export function obtenerModulo(id: string): ModuloDefinicion | undefined {
  return MODULOS.find((m) => m.id === id);
}
