// client/src/modules/offlineRegistry.ts
//
// Qué escrituras de cada módulo participan de la cola offline, del lado del
// cliente. Es el espejo de `ModuloDefinicion.offline` del backend
// (src/modules/types.ts) — ver el ADR-0002, sección "Offline-first".
//
// ── Por qué está acá y no dentro de registry.tsx ─────────────────────────
//
// Conceptualmente pertenece a la entrada de cada módulo, junto a su `label`
// y su `componente`. Vive aparte por una razón concreta y no estética:
// registry.tsx es un .tsx (usa React.lazy), y tanto el motor offline como
// tests/offline-registry.test.ts —que corre con el vitest de la RAÍZ, donde
// no hay ni JSX configurado ni @types/react— necesitan leer esta
// declaración. Importar el .tsx desde ahí rompe `tsc --noEmit` del backend.
//
// Como efecto secundario bueno: el motor de client/src/offline/ no arrastra
// el grafo de componentes lazy solo para saber qué rutas encolar.
//
// Sigue siendo UNA sola fuente por lado (esta, en el cliente; el registry en
// el backend), y tests/offline-registry.test.ts falla si las dos divergen.

export interface EscrituraOffline {
  metodo: "POST" | "PUT" | "PATCH";
  /** Relativa al montaje del módulo — routes/index.ts monta cada uno bajo
   *  /api/erp/<id>, igual que en su archivo de rutas del backend. */
  ruta: string;
}

/** Clave = id del módulo (el mismo del registry y del enum modulo_erp).
 *  Un módulo ausente de este mapa no participa del offline: sus escrituras
 *  fallan como siempre cuando no hay red.
 *
 *  Requisito para agregar uno: el servicio que atiende esa ruta tiene que
 *  pasar por idempotentInsert() en el backend. Encolar una escritura que no
 *  sea idempotente es peor que no tener offline — el reintento duplica en
 *  silencio. */
export const ESCRITURAS_OFFLINE: Record<string, EscrituraOffline[]> = {
  // Llenar un checklist es EL flujo de campo: pasa en la cancha, con el
  // equipo delante y muchas veces sin señal.
  //
  // Las plantillas NO están acá a propósito: son configuración, se arman
  // desde la oficina con red, y un DELETE encolado a ciegas es justo el
  // tipo de operación que no debe reintentarse sola.
  checklists: [{ metodo: "POST", ruta: "/" }],

  // Solo crear el IPERC. Las líneas base son catálogo de oficina (mismo
  // criterio que las plantillas de checklists), y aprobar/rechazar NO debe
  // encolarse nunca: son transiciones de estado, no creaciones, y el 409
  // anti-carrera del backend haría que un reintento tardío se descarte
  // igual.
  iperc: [{ metodo: "POST", ruta: "/" }],

  // Solo registrar una lectura de tanque. `/lecturas`, NO `/:id/nivel` --
  // el motor offline (rutasOffline.ts) solo matchea rutas literales, sin
  // parámetros de URL, así que combustible_id viaja en el body.
  combustible: [{ metodo: "POST", ruta: "/lecturas" }],
};
