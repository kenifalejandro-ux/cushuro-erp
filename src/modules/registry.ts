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
 */
import dashboardRoutes from "./dashboard/dashboard.routes";
import repuestosRoutes from "./repuestos/repuestos.routes";
import combustibleRoutes from "./combustible/combustible.routes";
import documentosRoutes from "./documentos/documentos.routes";
import equiposRoutes from "./equipos/equipos.routes";
import checklistsRoutes from "./checklists/checklists.routes";
import ipercRoutes from "./iperc/iperc.routes";
import type { ModuloDefinicion } from "./types";

export const MODULOS: ModuloDefinicion[] = [
  {
    id: "repuestos",
    label: "Repuestos",
    icono: "🔧",
    version: "v1",
    router: repuestosRoutes,
    tablas: [{ nombre: "repuestos", pk: "serial" }],
    raices: ["repuestos"],
    cuota: { tabla: "repuestos", porDefecto: 50_000 },
  },
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
    id: "documentos",
    label: "Documentos",
    icono: "📄",
    version: "v1",
    router: documentosRoutes,
    tablas: [
      { nombre: "documentos", pk: "serial" },
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
];

export const MODULOS_ERP = MODULOS.map((m) => m.id);

export function obtenerModulo(id: string): ModuloDefinicion | undefined {
  return MODULOS.find((m) => m.id === id);
}
