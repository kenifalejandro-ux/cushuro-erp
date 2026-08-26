/**src/modules/combutible/combustible.repository.ts */

import type { PoolClient } from "pg";
import type {
  CrearTanqueCombustibleInput,
  ActualizarTanqueCombustibleInput,
} from "../../server/schemas/combustible.schema";
import type { Paginacion } from "../../server/shared/utils/pagination";
import { esViolacionUnicidad, esViolacionForeignKey } from "../../server/shared/utils/pgError";

// Columnas comunes a findAll/findById/create/update/delete -- un tanque es
// el punto de abastecimiento completo, no solo el medidor de antes de la
// Fase A (ver docs/architecture/control-de-combustible.md).
//
// `nivel_actual`, `fecha_actualizacion` y `porcentaje` NO son columnas: se
// calculan desde la última lectura vigente (migración 0059). Antes se
// guardaban y se mantenían con un UPDATE condicional que fallaba en
// silencio -- ver el comentario largo de esa migración. Ahora el desfase es
// imposible: hay una sola fuente.
//
// Se devuelven con los mismos nombres de siempre para no romper el contrato
// con el cliente, que no tiene por qué enterarse de dónde sale el número.
//
// NULL cuando el tanque no tiene ninguna lectura vigente (todas anuladas):
// ahí el nivel es genuinamente desconocido, y decirlo es más honesto que
// mostrar un 0 que nadie midió.
const COLUMNAS_TANQUE = `
  c.id, c.codigo, c.tanque_nombre, c.tipo_combustible, c.unidad, c.tipo_punto,
  c.ubicacion, c.capacidad_total, c.nivel_minimo, c.totalizador_actual,
  c.costo_promedio, c.moneda, c.activo,
  ultima.nivel AS nivel_actual,
  ultima.leido_en AS fecha_actualizacion,
  ROUND((ultima.nivel / c.capacidad_total) * 100, 2) AS porcentaje
`;

// LEFT JOIN LATERAL y no un subquery por columna: así la última lectura se
// busca UNA vez por tanque y de ahí salen nivel y fecha juntos. LEFT (no
// INNER) para que un tanque sin lecturas vigentes siga apareciendo en el
// listado, con el nivel en NULL.
//
// El desempate por id importa: dos lecturas con el MISMO leido_en (mismo
// minuto, que es la precisión que manda el formulario) tienen que resolverse
// siempre igual, si no el nivel dependería del plan del query.
const JOIN_ULTIMA_LECTURA = `
  LEFT JOIN LATERAL (
    SELECT l.nivel, l.leido_en
    FROM combustible_lecturas l
    WHERE l.combustible_id = c.id AND l.anulada_en IS NULL
    ORDER BY l.leido_en DESC, l.id DESC
    LIMIT 1
  ) ultima ON true
`;

export class CombustibleRepository {
  async findAll(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT ${COLUMNAS_TANQUE} FROM combustible c ${JOIN_ULTIMA_LECTURA}
       WHERE c.tenant_id = $1 ORDER BY c.id ASC`,
      [tenantId]
    );

    return result.rows;
  }

  async findById(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT ${COLUMNAS_TANQUE} FROM combustible c ${JOIN_ULTIMA_LECTURA}
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [id, tenantId]
    );

    return result.rows[0] || null;
  }

  /** El nivel inicial del alta se guarda como una LECTURA (`origen =
   *  'inicial'`), no como una columna del tanque: desde la migración 0059 el
   *  nivel se deriva del historial, así que un tanque sin ninguna lectura no
   *  tendría nivel que mostrar. Además deja el arranque visible en el
   *  historial, que antes no figuraba en ningún lado. */
  async create(client: PoolClient, tenantId: string, data: CrearTanqueCombustibleInput) {
    const creado = await client.query<{ id: number }>(
      `
      INSERT INTO combustible (
        tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
        ubicacion, capacidad_total, nivel_minimo, moneda
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id
      `,
      [
        tenantId,
        data.codigo,
        data.tanque_nombre,
        data.tipo_combustible,
        data.unidad,
        data.tipo_punto,
        data.ubicacion ?? null,
        data.capacidad_total,
        data.nivel_minimo,
        data.moneda,
      ]
    );

    const id = creado.rows[0].id;
    await client.query(
      `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
       VALUES ($1, $2, $3, NOW(), 'inicial')`,
      [tenantId, id, data.nivel_actual]
    );

    // Se relee en vez de usar RETURNING: el nivel sale de un LATERAL JOIN
    // contra las lecturas, que RETURNING no puede hacer.
    return this.findById(client, tenantId, id);
  }

  /** Reemplaza la fila entera salvo `nivel_actual`/`totalizador_actual`/
   *  `costo_promedio` -- mismo motivo que en create(): esos tres tienen su
   *  propio camino de escritura, este endpoint no es ese camino. */
  async update(
    client: PoolClient,
    tenantId: string,
    id: number,
    data: ActualizarTanqueCombustibleInput
  ) {
    const result = await client.query(
      `
      UPDATE combustible SET
        codigo = $1,
        tanque_nombre = $2,
        tipo_combustible = $3,
        unidad = $4,
        tipo_punto = $5,
        ubicacion = $6,
        capacidad_total = $7,
        nivel_minimo = $8,
        moneda = $9,
        activo = $10
      WHERE id = $11 AND tenant_id = $12
      RETURNING id
      `,
      [
        data.codigo,
        data.tanque_nombre,
        data.tipo_combustible,
        data.unidad,
        data.tipo_punto,
        data.ubicacion ?? null,
        data.capacidad_total,
        data.nivel_minimo,
        data.moneda,
        data.activo,
        id,
        tenantId,
      ]
    );

    if (result.rows.length === 0) return null;
    return this.findById(client, tenantId, id);
  }

  /** Soft-delete exclusivamente: `combustible_lecturas.combustible_id`
   *  tiene ON DELETE CASCADE (0045_combustible_lecturas.sql) -- un DELETE
   *  real de SQL borraría en cascada todo el historial de lecturas del
   *  tanque. Desactivar dejando la fila (y su historial) intactos es la
   *  única forma segura de "eliminar" un tanque acá. */
  async softDelete(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `UPDATE combustible SET activo = false WHERE id = $1 AND tenant_id = $2
       RETURNING id`,
      [id, tenantId]
    );
    if (result.rows.length === 0) return null;
    return this.findById(client, tenantId, id);
  }

  /** Mismo patrón de lote de 1.000 + dedupe por `codigo` DENTRO del lote
   *  que RepuestosRepository.createBulk -- ver el comentario largo ahí. En
   *  la práctica un tenant nunca va a acercarse al tamaño de lote (los
   *  tanques son unos pocos por sitio), pero el molde es el mismo por
   *  consistencia y porque el tope real está en el schema (Zod), no acá. */
  async createBulk(client: PoolClient, tenantId: string, items: CrearTanqueCombustibleInput[]) {
    const TAMANO_LOTE = 1000;
    const results: unknown[] = [];

    for (let inicio = 0; inicio < items.length; inicio += TAMANO_LOTE) {
      const lote = items.slice(inicio, inicio + TAMANO_LOTE);

      const porCodigo = new Map<string, CrearTanqueCombustibleInput>();
      for (const fila of lote) porCodigo.set(fila.codigo, fila);
      const filasUnicas = [...porCodigo.values()];

      const placeholders = filasUnicas
        .map((_, i) => {
          const base = i * 9;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
        })
        .join(", ");

      const valores = filasUnicas.flatMap((d) => [
        tenantId,
        d.codigo,
        d.tanque_nombre,
        d.tipo_combustible,
        d.unidad,
        d.tipo_punto,
        d.ubicacion ?? null,
        d.capacidad_total,
        d.nivel_minimo,
      ]);

      // Qué códigos YA existían, antes de que el upsert los toque: es la
      // única forma de distinguir después un alta nueva de una edición, y de
      // eso depende si corresponde crearle su lectura inicial.
      const preexistentes = await client.query<{ id: number }>(
        `SELECT id FROM combustible WHERE tenant_id = $1 AND codigo = ANY($2::varchar[])`,
        [tenantId, filasUnicas.map((d) => d.codigo)]
      );
      const idsPreexistentes = new Set(preexistentes.rows.map((f) => f.id));

      const insertados = await client.query<{ id: number; codigo: string }>(
        `INSERT INTO combustible (
           tenant_id, codigo, tanque_nombre, tipo_combustible, unidad, tipo_punto,
           ubicacion, capacidad_total, nivel_minimo
         )
         VALUES ${placeholders}
         ON CONFLICT (tenant_id, codigo) DO UPDATE SET
           tanque_nombre = EXCLUDED.tanque_nombre,
           tipo_combustible = EXCLUDED.tipo_combustible,
           unidad = EXCLUDED.unidad,
           tipo_punto = EXCLUDED.tipo_punto,
           ubicacion = EXCLUDED.ubicacion,
           capacidad_total = EXCLUDED.capacidad_total,
           nivel_minimo = EXCLUDED.nivel_minimo
         RETURNING id, codigo`,
        valores
      );

      // Lectura `inicial` solo para los tanques NUEVOS: si el código ya
      // existía, esto fue un upsert sobre un tanque con historial propio, y
      // meterle una lectura del Excel le pisaría el nivel real medido en
      // campo con un número de planilla.
      const nivelPorCodigo = new Map(filasUnicas.map((d) => [d.codigo, d.nivel_actual]));
      const nuevos = insertados.rows.filter((f) => !idsPreexistentes.has(f.id));
      for (const fila of nuevos) {
        await client.query(
          `INSERT INTO combustible_lecturas (tenant_id, combustible_id, nivel, leido_en, origen)
           VALUES ($1, $2, $3, NOW(), 'inicial')`,
          [tenantId, fila.id, nivelPorCodigo.get(fila.codigo) ?? 0]
        );
      }

      for (const fila of insertados.rows) {
        results.push(await this.findById(client, tenantId, fila.id));
      }
    }

    return results;
  }

  /** GET /:id/lecturas -- a diferencia de los tanques (pocos, sin
   *  paginación), el histórico de lecturas SÍ crece con el trabajo de
   *  campo, mismo criterio que combustible_lecturas ya tiene declarada su
   *  propia cuota en el registry. */
  async findLecturas(
    client: PoolClient,
    tenantId: string,
    combustibleId: number,
    { pageSize, offset }: Paginacion
  ) {
    const result = await client.query(
      `
      SELECT l.id, l.combustible_id, l.nivel, l.leido_en, l.usuario_id, l.origen,
             l.metadata, l.creado_en,
             l.anulada_en, l.anulada_por, l.motivo_anulacion,
             anulador.nombre AS anulada_por_nombre,
             autor.nombre AS registrada_por_nombre,
        COUNT(*) OVER() AS total_count
      FROM combustible_lecturas l
      -- Dos LEFT JOIN sobre la misma tabla, por dos motivos distintos:
      -- quién ANULÓ y quién REGISTRÓ. Los dos LEFT y no INNER porque las
      -- dos columnas son nullable (usuario borrado deja SET NULL, ver 0045
      -- y 0058) y la mayoría de las lecturas no están anuladas -- un INNER
      -- las dejaría a todas fuera del listado.
      LEFT JOIN usuarios anulador ON anulador.id = l.anulada_por
      -- El autor del registro importa tanto como el de la anulación: en un
      -- módulo anti-fuga, "¿quién anotó esta lectura rara?" es justamente
      -- la pregunta que hay que poder responder.
      LEFT JOIN usuarios autor ON autor.id = l.usuario_id
      WHERE l.combustible_id = $1 AND l.tenant_id = $2
      ORDER BY l.leido_en DESC
      LIMIT $3 OFFSET $4
      `,
      [combustibleId, tenantId, pageSize, offset]
    );

    return result.rows;
  }

  /** Marca una lectura como anulada.
   *
   *  Ya no hace falta recalcular nada: desde la migración 0059 el nivel se
   *  deriva de la última lectura vigente al leerlo, así que anular la más
   *  reciente hace que el tanque vuelva solo a la anterior. Antes había un
   *  `recalcularNivelDesdeUltimaLectura()` acá justamente para eso.
   *
   *  El UPDATE lleva `anulada_en IS NULL` en el WHERE: si la lectura ya
   *  estaba anulada no afecta ninguna fila y devuelve null, así el
   *  controller responde 409 en vez de pisar el motivo y el autor de la
   *  anulación original (que son la evidencia de quién corrigió qué).
   *  Mismo patrón que `IpercRepository.cambiarEstado` -- ver
   *  fix_race_condition_iperc_estado: dos anulaciones simultáneas no pueden
   *  terminar las dos en 200. */
  async anularLectura(
    client: PoolClient,
    tenantId: string,
    lecturaId: number,
    usuarioId: string,
    motivo: string
  ) {
    const anulada = await client.query(
      `
      UPDATE combustible_lecturas
      SET anulada_en = now(), anulada_por = $1, motivo_anulacion = $2
      WHERE id = $3 AND tenant_id = $4 AND anulada_en IS NULL
      RETURNING id, combustible_id, nivel, leido_en, usuario_id, origen, metadata,
                creado_en, anulada_en, anulada_por, motivo_anulacion
      `,
      [usuarioId, motivo, lecturaId, tenantId]
    );

    if (anulada.rows.length === 0) return null;

    const lectura = anulada.rows[0];
    const tanque = await this.findById(client, tenantId, lectura.combustible_id);

    return { lectura, tanque };
  }

  /** Distingue "no existe / es de otro tenant" (404) de "ya estaba anulada"
   *  (409) -- sin esto, `anularLectura` devuelve null en los dos casos y el
   *  controller no puede decir cuál fue. */
  async findLecturaPorId(client: PoolClient, tenantId: string, lecturaId: number) {
    const result = await client.query(
      `SELECT id, combustible_id, anulada_en FROM combustible_lecturas
       WHERE id = $1 AND tenant_id = $2`,
      [lecturaId, tenantId]
    );
    return result.rows[0] ?? null;
  }

  /** Registra una lectura histórica. Nada más: el nivel del tanque sale de
   *  la última lectura vigente al leerlo (migración 0059), así que insertar
   *  la fila ES actualizar el nivel.
   *
   *  Antes había acá un UPDATE condicional sobre `combustible.nivel_actual`
   *  (`WHERE fecha_actualizacion < <leido_en>`) para que dos lecturas
   *  offline llegando desordenadas no se pisaran. Esa protección sigue
   *  existiendo, pero ahora es estructural en vez de defensiva: el ORDER BY
   *  del LATERAL JOIN elige la más reciente sin importar en qué orden se
   *  hayan insertado. Y de paso desaparecen los tres casos en que aquel
   *  UPDATE fallaba en silencio -- ver el comentario largo de 0059.
   *
   *  Lanza si `combustibleId` no existe en este tenant -- el controller lo
   *  distingue de un 500 genérico (mismo patrón que
   *  `IpercController.crear` con `linea_base_item_id`). */
  async registrarLectura(
    client: PoolClient,
    tenantId: string,
    data: {
      combustibleId: number;
      nivel: number;
      leidoEn: string;
      usuarioId: string | null;
      metadata: Record<string, unknown>;
    }
  ) {
    const tanqueExiste = await client.query<{ id: number; capacidad_total: string }>(
      `SELECT id, capacidad_total FROM combustible WHERE id = $1 AND tenant_id = $2`,
      [data.combustibleId, tenantId]
    );
    if (tanqueExiste.rows.length === 0) {
      throw new Error(`combustible_id ${data.combustibleId} no existe en este tenant`);
    }

    // Un tanque no puede contener más de lo que le entra: el dato se
    // contradice a sí mismo, no depende de ninguna otra lectura para saber
    // que está mal. Por eso BLOQUEA, a diferencia de un salto grande pero
    // posible (que solo se confirma en pantalla) -- ver el punto 5 de
    // docs/architecture/control-de-combustible.md.
    //
    // Va acá y no en el schema Zod porque el techo es dato del tanque, no
    // una constante: Zod valida la forma del body, no puede consultar la
    // capacidad. Y va en el repository y no solo en el cliente porque la
    // cola offline y cualquier llamada directa a la API tienen que chocar
    // con la misma pared.
    const capacidad = Number(tanqueExiste.rows[0].capacidad_total);
    if (data.nivel > capacidad) {
      throw new Error(`nivel ${data.nivel} supera la capacidad del tanque (${capacidad})`);
    }

    const lectura = await client.query(
      `
      INSERT INTO combustible_lecturas
        (tenant_id, combustible_id, nivel, leido_en, usuario_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en
    `,
      [
        tenantId,
        data.combustibleId,
        data.nivel,
        data.leidoEn,
        data.usuarioId,
        JSON.stringify(data.metadata),
      ]
    );

    const tanque = await this.findById(client, tenantId, data.combustibleId);
    return { lectura: lectura.rows[0], tanque };
  }

  /** Para el reintento de una lectura ya creada (mismo cliente_uuid) --
   *  responde igual que la primera vez, sin volver a tocar `combustible`. */
  async findLecturaConTanque(client: PoolClient, tenantId: string, lecturaId: number) {
    const lectura = await client.query(
      `SELECT id, combustible_id, nivel, leido_en, usuario_id, origen, metadata, creado_en
       FROM combustible_lecturas
       WHERE id = $1 AND tenant_id = $2`,
      [lecturaId, tenantId]
    );
    if (lectura.rows.length === 0) return null;

    const tanque = await this.findById(client, tenantId, lectura.rows[0].combustible_id);
    return { lectura: lectura.rows[0], tanque };
  }

  // ── Despachos (Fase B, ver docs/architecture/control-de-combustible.md
  // puntos 1, 2 y 5, y migrations/0062) ──────────────────────────────────

  private static readonly COLUMNAS_DESPACHO = `
    id, tenant_id, origen, combustible_id, grifo_externo, tipo_combustible,
    tipo_destino, equipo_id, serie_talonario, n_vale, cantidad,
    lectura_contometro, lectura_horometro, lectura_odometro, horas_abastecidas,
    usuario_id, despachado_en, creado_en
  `;

  /** Inserta un despacho. La unicidad de (tenant_id, serie_talonario,
   *  n_vale) la impone el constraint de 0062 -- acá se traduce la
   *  violación (23505) a un mensaje que el controller reconoce para
   *  responder 409, en vez de dejar pasar el error crudo de Postgres.
   *
   *  Las reglas de forma por origen/destino ya las validó el schema Zod
   *  (mensaje legible, antes de tocar la base); los CHECK de 0062 son la
   *  red de seguridad para cualquier insert que no pase por ahí. Lo que
   *  este método SÍ valida (porque necesita datos que Zod no tiene: la
   *  fila del tanque, la fila del equipo) va en combustible.service.ts. */
  async crearDespacho(
    client: PoolClient,
    tenantId: string,
    usuarioId: string | null,
    data: {
      origen: string;
      combustibleId: number | null;
      grifoExterno: string | null;
      tipoCombustible: string;
      tipoDestino: string;
      equipoId: number | null;
      serieTalonario: string;
      nVale: number;
      cantidad: number;
      lecturaContometro: number | null;
      lecturaHorometro: number | null;
      lecturaOdometro: number | null;
      horasAbastecidas: number | null;
      despachadoEn: string;
    }
  ) {
    try {
      const result = await client.query(
        `
        INSERT INTO combustible_despachos (
          tenant_id, origen, combustible_id, grifo_externo, tipo_combustible,
          tipo_destino, equipo_id, serie_talonario, n_vale, cantidad,
          lectura_contometro, lectura_horometro, lectura_odometro, horas_abastecidas,
          usuario_id, despachado_en
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        RETURNING ${CombustibleRepository.COLUMNAS_DESPACHO}
        `,
        [
          tenantId,
          data.origen,
          data.combustibleId,
          data.grifoExterno,
          data.tipoCombustible,
          data.tipoDestino,
          data.equipoId,
          data.serieTalonario,
          data.nVale,
          data.cantidad,
          data.lecturaContometro,
          data.lecturaHorometro,
          data.lecturaOdometro,
          data.horasAbastecidas,
          usuarioId,
          data.despachadoEn,
        ]
      );
      return result.rows[0];
    } catch (err) {
      if (esViolacionUnicidad(err)) {
        throw new Error(
          `el vale ${data.nVale} de la serie ${data.serieTalonario} ya está registrado`,
          { cause: err }
        );
      }
      // combustible_id (tanque) o equipo_id apuntan a una fila que no
      // existe en este tenant -- el nombre del constraint (Postgres lo
      // arma solo, `<tabla>_<columna>_fkey`) dice cuál de las dos FK fue.
      if (esViolacionForeignKey(err)) {
        const constraint = (err as { constraint?: string }).constraint ?? "";
        if (constraint.includes("combustible_id")) {
          throw new Error(`combustible_id ${data.combustibleId} no existe en este tenant`, {
            cause: err,
          });
        }
        if (constraint.includes("equipo_id")) {
          throw new Error(`equipo_id ${data.equipoId} no existe en este tenant`, { cause: err });
        }
      }
      throw err;
    }
  }

  /** Chequeo barato ANTES de validar la forma del despacho -- si el vale ya
   *  existe, eso tiene que ganarle a cualquier otro 400 (contómetro,
   *  medidor): "ya está registrado" es una señal más fuerte que un dato
   *  raro en el reintento, y es la misma que el grifero necesita ver para
   *  entender que esto fue un doble tipeo, no un error de forma. */
  async existeVale(
    client: PoolClient,
    tenantId: string,
    serieTalonario: string,
    nVale: number
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1 FROM combustible_despachos
       WHERE tenant_id = $1 AND serie_talonario = $2 AND n_vale = $3`,
      [tenantId, serieTalonario, nVale]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findDespachoPorId(client: PoolClient, tenantId: string, id: number) {
    const result = await client.query(
      `SELECT ${CombustibleRepository.COLUMNAS_DESPACHO}
       FROM combustible_despachos WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );
    return result.rows[0] ?? null;
  }

  async findDespachos(
    client: PoolClient,
    tenantId: string,
    filtros: { equipoId?: number; serieTalonario?: string },
    { pageSize, offset }: Paginacion
  ) {
    const condiciones: string[] = ["tenant_id = $1"];
    const valores: unknown[] = [tenantId];

    if (filtros.equipoId !== undefined) {
      valores.push(filtros.equipoId);
      condiciones.push(`equipo_id = $${valores.length}`);
    }
    if (filtros.serieTalonario !== undefined) {
      valores.push(filtros.serieTalonario);
      condiciones.push(`serie_talonario = $${valores.length}`);
    }

    valores.push(pageSize, offset);
    const result = await client.query(
      `
      SELECT ${CombustibleRepository.COLUMNAS_DESPACHO}, COUNT(*) OVER() AS total_count
      FROM combustible_despachos
      WHERE ${condiciones.join(" AND ")}
      ORDER BY despachado_en DESC, id DESC
      LIMIT $${valores.length - 1} OFFSET $${valores.length}
      `,
      valores
    );
    return result.rows;
  }

  /** Punto 1 reescrito: consulta bajo demanda, no persiste nada -- no hay
   *  período abierto/cerrado ni `combustible_anomalias` acá (eso es la
   *  "maquinaria de conciliación" del punto 4, Fase D). Si no hay ningún
   *  vale en esa serie, MIN/MAX dan NULL -- se corta antes de llamar
   *  generate_series(), que revienta con límites NULL. */
  async findHuecosTalonario(client: PoolClient, tenantId: string, serieTalonario: string) {
    const limites = await client.query<{ minimo: number | null; maximo: number | null }>(
      `SELECT MIN(n_vale) AS minimo, MAX(n_vale) AS maximo
       FROM combustible_despachos WHERE tenant_id = $1 AND serie_talonario = $2`,
      [tenantId, serieTalonario]
    );
    const { minimo, maximo } = limites.rows[0];
    if (minimo === null || maximo === null) {
      return { serie: serieTalonario, huecos: [] as number[], ultimo: null as number | null };
    }

    const huecos = await client.query<{ n_vale: number }>(
      `
      SELECT gs AS n_vale
      FROM generate_series($3::int, $4::int) AS gs
      WHERE NOT EXISTS (
        SELECT 1 FROM combustible_despachos d
        WHERE d.tenant_id = $1 AND d.serie_talonario = $2 AND d.n_vale = gs
      )
      ORDER BY gs
      `,
      [tenantId, serieTalonario, minimo, maximo]
    );

    return {
      serie: serieTalonario,
      huecos: huecos.rows.map((f) => f.n_vale),
      ultimo: maximo,
    };
  }
}
