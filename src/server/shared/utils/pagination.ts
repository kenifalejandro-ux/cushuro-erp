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
