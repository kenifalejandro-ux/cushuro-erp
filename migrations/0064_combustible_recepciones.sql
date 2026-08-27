-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: Fase C de control de combustible -- combustible_recepciones
--
-- Ver docs/architecture/control-de-combustible.md (hoja de ruta, fila C) y
-- la memoria de diseño de Fase C. Hasta acá el módulo sabía cuánto SALE del
-- tanque (Fase B, `combustible_despachos`) y cuánto HAY (Fase A, medido con
-- varilla en `combustible_lecturas`) -- pero no cuánto ENTRA ni a qué costo.
-- Sin ese dato, `combustible.costo_promedio` (columna reservada desde 0057)
-- nunca se podía calcular: quedaba en 0 para siempre y el inventario de
-- combustible no se podía valorizar.
--
-- Una recepción es "llegó la cisterna y cargó el tanque X con Y galones a Z
-- de costo". SOLO existe para tanque propio: una compra en un grifo de la
-- ruta (origen='compra_externa') ya es el evento completo en
-- `combustible_despachos` -- no pasa por acá, no hay tanque que valorizar.
--
-- ── Tres decisiones que conviene leer antes de tocar esta tabla ──────────
--
-- 1. NO HAY TALONARIO NI N°VALE. El punto 2 del documento (la secuencia por
--    N°VALE) existe para detectar combustible que SALE sin quedar
--    declarado. Una recepción es el movimiento opuesto: la fuga sería
--    combustible que entra y no se registra, y eso no lo detecta ninguna
--    secuencia propia -- se detecta cruzando el nivel medido con varilla
--    contra lo esperado, que es conciliación (Fase D).
--
-- 2. REGISTRAR UNA RECEPCIÓN NO MUEVE EL NIVEL DEL TANQUE. El nivel sigue
--    saliendo exclusivamente de la última lectura vigente (0059). Es la
--    misma decisión que ya se tomó para los despachos, por el mismo motivo:
--    si una declaración de papel moviera el nivel, el nivel dejaría de ser
--    un dato medido y pasaría a ser "lo que alguien dijo", y un tanque así
--    nunca podría delatar una fuga real. Recepción y lectura son dos actos
--    independientes.
--
-- 3. EL DOCUMENTO ES CONFIGURABLE, POR ESO ES NULLABLE ACÁ. Kenif pidió que
--    factura/guía sea obligatoria por defecto PERO con forma de
--    desactivarla (el cliente todavía no confirmó si en la práctica siempre
--    hay papel a mano cuando llega la cisterna). Un NOT NULL duro haría
--    imposible desactivarla, así que la obligatoriedad vive en el service,
--    leyendo `combustible.requiere_documento`. Lo que la base SÍ impone es
--    la coherencia: no puede haber número sin tipo, ni tipo sin número.
--
-- EJECUTAR (después de 0063):
--   psql -d mincoreerp -f migrations/0064_combustible_recepciones.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── combustible: dos columnas de configuración por tanque ────────────────
-- Las dos con default constante -> Postgres 11+ no reescribe la tabla, y el
-- default reproduce EXACTAMENTE el comportamiento anterior a esta migración
-- (sin tolerancia, documento exigido), así que ningún tanque existente
-- cambia de conducta al aplicarla.

-- Margen de tolerancia para el bloqueo por capacidad, en PORCENTAJE de
-- capacidad_total. Porcentaje y no litros fijos porque escala solo con el
-- tamaño del tanque: 2% es un margen razonable tanto en uno de 500 gal como
-- en uno de 20.000, un "±50 gal" fijo no.
--
-- Va por TANQUE y no por tenant porque el error de medición con varilla es
-- una propiedad física de ESE tanque (su geometría, su regla, dónde está
-- apoyado), no una política administrativa de la empresa.
--
-- DEFAULT 0 = estricto, el comportamiento de hoy. El cliente definirá su
-- margen real después y lo maneja él desde el ABM -- por eso es un dato
-- editable y no una constante en el código.
ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS tolerancia_capacidad_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

-- Si este tanque exige factura/guía al registrar una recepción. Ver la
-- decisión 3 del encabezado. Por tanque (y no por tenant) de yapa da
-- granularidad útil: el tanque de planta puede exigir sustento tributario y
-- uno de obra no.
ALTER TABLE combustible
  ADD COLUMN IF NOT EXISTS requiere_documento BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_tolerancia_capacidad_pct_check'
  ) THEN
    ALTER TABLE combustible
      ADD CONSTRAINT combustible_tolerancia_capacidad_pct_check
      -- Techo de 100%: una "tolerancia" que permita cargar más del doble de
      -- la capacidad ya no es tolerancia de medición, es no tener control.
      CHECK (tolerancia_capacidad_pct >= 0 AND tolerancia_capacidad_pct <= 100);
  END IF;
END $$;

-- ── combustible_recepciones ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS combustible_recepciones (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         UUID NOT NULL REFERENCES tenants(id),

  -- A diferencia de combustible_despachos, acá NO es polimórfico ni
  -- nullable: una recepción sin tanque no existe (ver el encabezado). Sin
  -- ON DELETE, misma convención que combustible_despachos/combustible_precios
  -- -- un tanque con recepciones en su historial no se puede borrar, y por
  -- eso `combustible` se elimina con soft-delete (activo = false).
  combustible_id    INTEGER NOT NULL REFERENCES combustible(id),

  -- Proveedor/cisterna, SIEMPRE del catálogo -- nunca texto libre. Es el
  -- mismo `combustible_grifos` que ya usa Fase B para compra externa: un
  -- proveedor que vende tanto en ruta como a granel al tanque fijo es UNA
  -- fila, no dos. Alta previa obligatoria (decisión de Kenif: "primero dar
  -- de alta al grifo, mayor orden"), y ya hay ABM para eso desde 0063.
  grifo_id          INTEGER NOT NULL REFERENCES combustible_grifos(id),

  cantidad          NUMERIC(12,2) NOT NULL,
  -- Costo de ESTA compra puntual, no el promedio del tanque. Misma
  -- precisión que combustible_precios.precio_unitario y que
  -- combustible_despachos.costo_unitario (0063).
  costo_unitario    NUMERIC(10,4) NOT NULL,

  -- Sustento del ingreso. Nullable en la base A PROPÓSITO -- ver la
  -- decisión 3 del encabezado: la obligatoriedad la aplica el service según
  -- combustible.requiere_documento, no un NOT NULL que la volvería
  -- imposible de desactivar.
  tipo_documento    VARCHAR(20),
  numero_documento  TEXT,

  -- Cuándo entró FÍSICAMENTE el combustible, no cuándo se cargó al sistema
  -- -- mismo criterio que despachado_en/leido_en. Define contra qué lectura
  -- se calcula el costo ponderado, así que una recepción cargada tarde se
  -- valoriza con el nivel que el tanque tenía ESE día, no con el de hoy.
  recibido_en       TIMESTAMPTZ NOT NULL,

  -- Nullable a propósito: un usuario borrado no debe borrar el historial
  -- -- mismo criterio que combustible_lecturas.usuario_id.
  usuario_id        UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Anulación con motivo obligatorio -- mismo mecanismo exacto que
  -- combustible_lecturas (0058) y combustible_precios (0063). Una recepción
  -- mal tipeada NUNCA se borra ni se edita: se marca, y el costo promedio
  -- se recalcula ignorándola (ver el replay en combustible.repository.ts).
  anulada_en        TIMESTAMPTZ,
  anulada_por       UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  motivo_anulacion  TEXT
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_cantidad_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_cantidad_check CHECK (cantidad > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_costo_unitario_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_costo_unitario_check CHECK (costo_unitario > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_tipo_documento_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_tipo_documento_check
      -- En Perú el consumo de combustible se sustenta casi siempre con
      -- factura; la guía de remisión aparece cuando el papel que llega con
      -- la cisterna es el de traslado. Son documentos distintos: guardar
      -- solo el número perdería cuál de los dos es, que es justo el dato
      -- que importa para el sustento tributario.
      CHECK (tipo_documento IS NULL OR tipo_documento IN ('factura', 'guia_remision'));
  END IF;
END $$;

-- Coherencia del par: no puede haber número sin tipo ni tipo sin número, y
-- un número en blanco ("   ") no cuenta como número. Esto es lo único que
-- la base impone sobre el documento -- si es OBLIGATORIO o no lo decide
-- `combustible.requiere_documento` en el service (decisión 3).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_documento_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_documento_check
      CHECK (
        (tipo_documento IS NULL AND numero_documento IS NULL)
        OR (tipo_documento IS NOT NULL AND length(trim(numero_documento)) > 0)
      );
  END IF;
END $$;

-- Motivo obligatorio al anular -- copia exacta del constraint de 0058. A
-- nivel de base y no solo de Zod: un INSERT/UPDATE directo (script de
-- soporte, migración futura) tampoco puede dejar una anulación sin razón.
-- Es lo único que distingue "me equivoqué al tipear" de "estoy borrando un
-- número que no me conviene".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'combustible_recepciones_anulacion_check'
  ) THEN
    ALTER TABLE combustible_recepciones
      ADD CONSTRAINT combustible_recepciones_anulacion_check
      CHECK (
        (anulada_en IS NULL AND anulada_por IS NULL AND motivo_anulacion IS NULL)
        OR (anulada_en IS NOT NULL AND length(trim(motivo_anulacion)) > 0)
      );
  END IF;
END $$;

-- ── Índices ──────────────────────────────────────────────────────────────

-- La consulta central de esta tabla: "todas las recepciones VIGENTES de
-- este tanque, en orden cronológico" -- es exactamente lo que recorre el
-- replay del costo promedio en cada alta y en cada anulación. Parcial
-- porque las anuladas son la excepción y el replay las ignora por
-- definición (mismo criterio que idx_combustible_lecturas_vigentes, 0058).
CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_vigentes
  ON combustible_recepciones(tenant_id, combustible_id, recibido_en ASC, id ASC)
  WHERE anulada_en IS NULL;

-- Cobertura de FK: sin esto, borrar un grifo obliga a Postgres a escanear
-- esta tabla entera para validar el constraint (ver
-- docs/architecture/database-performance-guidelines.md y
-- tests/db-index-coverage.test.ts, que lo hace fallar en CI si falta).
-- combustible_id ya queda cubierto por el índice de arriba.
CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_grifo
  ON combustible_recepciones(grifo_id);

CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_usuario
  ON combustible_recepciones(usuario_id) WHERE usuario_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_combustible_recepciones_anulada_por
  ON combustible_recepciones(anulada_por) WHERE anulada_por IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- Mismo criterio que el resto de las tablas propias de un tenant: FORCE es
-- imprescindible, si no el owner de la tabla (el rol con el que se conecta
-- la app) queda exento de la política.
ALTER TABLE combustible_recepciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE combustible_recepciones FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'combustible_recepciones'
      AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON combustible_recepciones
      USING (tenant_id = current_setting('app.tenant_id')::uuid)
      WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
  END IF;
END $$;
