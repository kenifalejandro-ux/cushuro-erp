/** src/server/shared/utils/pagination.ts */

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

export interface Paginacion {
  page: number;
  pageSize: number;
  offset: number;
}

/** Lee page/pageSize de req.query con defaults seguros — pageSize nunca
 *  supera PAGE_SIZE_MAX, para que nadie pida "todo en una sola página" y
 *  vuelva a tumbar la pantalla que esto vino a arreglar. */
export function parsePaginacion(query: Record<string, unknown>): Paginacion {
  const pageRaw = Number.parseInt(String(query?.page ?? ""), 10);
  const pageSizeRaw = Number.parseInt(String(query?.pageSize ?? ""), 10);

  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(pageSizeRaw, PAGE_SIZE_MAX)
      : PAGE_SIZE_DEFAULT;

  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Separa el total (viene de COUNT(*) OVER() en cada fila) del resto de
 *  columnas, y arma el objeto de paginación para la respuesta HTTP. */
export function armarRespuestaPaginada<T extends { total_count?: string | number }>(
  filas: T[],
  { page, pageSize }: Paginacion
) {
  const total = filas.length > 0 ? Number(filas[0].total_count) : 0;
  const data = filas.map(({ total_count, ...resto }) => resto);

  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

// ── Paginación por cursor (keyset) ────────────────────────────────────────
//
// Para listados que ya pueden crecer mucho (checklists e IPERC llenados,
// las dos únicas tablas particionadas — ver migrations/0037): OFFSET
// obliga a Postgres a recorrer y descartar todas las filas anteriores al
// offset pedido, y COUNT(*) OVER() cuenta la tabla entera en cada página.
// Los dos se vuelven caros juntos justo cuando el volumen empieza a
// importar. Keyset (WHERE id < cursor ORDER BY id DESC LIMIT n) no tiene
// ese problema: el índice ya ordenado por id resuelve cualquier página en
// tiempo constante, sin importar cuán atrás esté.
//
// El costo es real y es a propósito: sin OFFSET no se puede "saltar a la
// página 8", solo avanzar/retroceder de a una — igual que ya hacen
// Equipos/Repuestos/Documentos en el cliente (botones Anterior/Siguiente,
// nunca un selector de página). Y sin COUNT(*) OVER() no hay total exacto:
// se pide una fila de más (`pageSize + 1`) para saber si hay más sin
// contarlas todas.

export interface CursorPaginacion {
  pageSize: number;
  /** `null` = primera página. Es el id de la última fila que ya se vio —
   *  la query trae lo que sigue después de esa, nunca esa misma fila. */
  cursor: number | null;
}

/** Lee pageSize/cursor de req.query — mismos defaults y tope que
 *  parsePaginacion(), para que ambos esquemas se sientan consistentes. */
export function parseCursorPaginacion(query: Record<string, unknown>): CursorPaginacion {
  const pageSizeRaw = Number.parseInt(String(query?.pageSize ?? ""), 10);
  const pageSize =
    Number.isFinite(pageSizeRaw) && pageSizeRaw > 0
      ? Math.min(pageSizeRaw, PAGE_SIZE_MAX)
      : PAGE_SIZE_DEFAULT;

  const cursorRaw = Number.parseInt(String(query?.cursor ?? ""), 10);
  const cursor = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  return { pageSize, cursor };
}

/** El repository tiene que pedir `pageSize + 1` filas (ver el comentario de
 *  arriba) — esta función es la que sabe cortar esa fila de más y
 *  convertirla en `hasMore`/`nextCursor`, así el repository no tiene que
 *  saber nada de paginación, solo ejecutar la query que le dan. */
export function armarRespuestaCursor<T extends { id: number }>(filas: T[], pageSize: number) {
  const hasMore = filas.length > pageSize;
  const data = hasMore ? filas.slice(0, pageSize) : filas;
  const nextCursor = hasMore ? data[data.length - 1].id : null;

  return {
    data,
    pagination: { pageSize, nextCursor, hasMore },
  };
}
