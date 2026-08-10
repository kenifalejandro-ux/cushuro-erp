-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: billing / cobro recurrente
--
-- Primera pieza del sistema de facturación. Ver
-- docs/architecture (o el hilo de diseño, si no hay doc todavía) para el
-- resto de las decisiones de producto — acá solo el resumen que explica
-- las columnas:
--
--   • Precio de lista SIEMPRE en USD (columnas nuevas en `planes`, son
--     solo referencia, editable a mano, no se valida contra lo que
--     realmente se cobra).
--   • Cada suscripción (`suscripciones`) guarda su propio precio
--     negociado en USD — puede apartarse del de lista.
--   • El COBRO real puede ser en USD (transferencia) o en PEN (tarjeta,
--     porque Culqi opera nativo en soles) — por eso `moneda` y
--     `tipo_cambio_aplicado` viven en `cobros`, no en `suscripciones`.
--   • `tipo = 'implementacion'` es el cobro único de puesta en marcha,
--     que puede partirse en varias filas (adelanto/saldo, o por módulo)
--     — cada fila es su propia cuota con su propia `descripcion`. Por
--     eso `cobros.suscripcion_id` es NULLABLE: la implementación puede
--     cobrarse antes de que exista la suscripción.
--   • `facturas` es lo que el TENANT descarga desde su propia sección de
--     Facturación -- distinto del Recibo por Honorarios que yo emito para
--     mi propia declaración a SUNAT (ese no vive acá, es un trámite mío
--     por fuera del sistema). Tres tipos posibles
--     (`comprobante_tipo`): 'comprobante_pago' (generado por el sistema,
--     el único que funciona hoy -- "Factura"/"Boleta" son términos
--     reservados por SUNAT, no se pueden emitir sin RUC de empresa) y
--     'boleta'/'factura' (esquema ya listo para cuando haya empresa
--     formal, pero sin generación real todavía -- ver docs o el ticket de
--     facturación electrónica cuando corresponda).
--   • La suspensión por impago NO vive acá: reusa
--     `tenants.estado = 'suspended'` vía cambiarEstadoTenantService()
--     (migración 0038), que ya corta login/sesiones. `suscripciones.estado`
--     es la fuente de verdad de NEGOCIO (por qué está suspendido), pero el
--     ENFORCEMENT sigue siendo el mecanismo de tenants que ya existe.
--
-- Sin RLS, mismo criterio que tenants/planes/tenant_cuotas: lo gestiona el
-- panel de plataforma para cualquier tenant, fuera de una transacción con
-- app.tenant_id seteado (ver feedback_trampa_rls_withtenant en memoria).
--
-- `cobros` y `facturas` NO tienen ON DELETE CASCADE en tenant_id a
-- propósito: son registro contable/tributario (sustento ante SUNAT), tiene
-- que sobrevivir aunque el tenant se dé de baja algún día — a diferencia
-- de `suscripciones`/`metodos_pago`, que sí son operativas y pueden
-- borrarse junto con el tenant.
--
-- EJECUTAR (después de 0040):
--   psql -d mincoreerp -f migrations/0041_billing.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Precios de referencia por plan (USD, editables a mano) ─────────────────
-- NULL hasta que se carguen a propósito — no se inventan números acá.
ALTER TABLE planes ADD COLUMN IF NOT EXISTS precio_implementacion_referencia NUMERIC(12, 2);
ALTER TABLE planes ADD COLUMN IF NOT EXISTS precio_mensual_referencia NUMERIC(12, 2);
ALTER TABLE planes ADD COLUMN IF NOT EXISTS precio_anual_referencia NUMERIC(12, 2);

-- ── Suscripción: una por tenant ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suscripciones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES planes(id),
  estado TEXT NOT NULL DEFAULT 'trialing'
    CHECK (estado IN ('trialing', 'activa', 'en_gracia', 'suspendida', 'cancelada')),
  -- Cadencia por defecto; no impide que una suscripción "mensual" reciba en
  -- algún momento un cobro que cubra el año completo (ver cobros.periodo_*)
  -- sin tener que cambiar este valor.
  ciclo TEXT NOT NULL CHECK (ciclo IN ('mensual', 'anual')),
  metodo_facturacion TEXT NOT NULL CHECK (metodo_facturacion IN ('tarjeta', 'transferencia')),
  -- Precio negociado en USD, snapshot al contratar/renegociar. Independiente
  -- de planes.precio_*_referencia -- ese es solo el punto de partida.
  precio_referencia NUMERIC(12, 2) NOT NULL CHECK (precio_referencia >= 0),
  trial_termina_en TIMESTAMPTZ,
  periodo_actual_inicio TIMESTAMPTZ NOT NULL DEFAULT now(),
  periodo_actual_fin TIMESTAMPTZ NOT NULL,
  gracia_termina_en TIMESTAMPTZ,
  cancelada_en TIMESTAMPTZ,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Tarjeta guardada (solo aplica a metodo_facturacion = 'tarjeta') ─────────
CREATE TABLE IF NOT EXISTS metodos_pago (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pasarela TEXT NOT NULL DEFAULT 'culqi',
  -- Id de la tarjeta tokenizada EN LA PASARELA. Nunca el PAN ni el CVV --
  -- eso no debe existir en esta base bajo ninguna circunstancia.
  token_pasarela TEXT NOT NULL,
  marca TEXT,
  ultimos4 TEXT,
  vence_mes SMALLINT,
  vence_anio SMALLINT,
  es_default BOOLEAN NOT NULL DEFAULT true,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Cobros: suscripción recurrente O implementación (una o varias cuotas) ──
CREATE TABLE IF NOT EXISTS cobros (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  -- NULL para implementación cobrada antes de que exista la suscripción.
  suscripcion_id UUID REFERENCES suscripciones(id),
  -- NULL si el pago fue por transferencia (no hay tarjeta involucrada).
  metodo_pago_id UUID REFERENCES metodos_pago(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('suscripcion', 'implementacion')),
  -- Ej. "Adelanto 50% implementación", "Módulo Equipos". NULL en un cobro
  -- de suscripción estándar, donde no hace falta aclarar nada.
  descripcion TEXT,
  moneda TEXT NOT NULL CHECK (moneda IN ('USD', 'PEN')),
  monto NUMERIC(12, 2) NOT NULL CHECK (monto >= 0),
  -- Solo cuando se convirtió de USD a PEN para cobrar por tarjeta (Culqi
  -- opera en soles) -- tipo de cambio SUNAT del día, para que cuadre con
  -- el comprobante. NULL si el cobro ya estaba en su moneda nativa
  -- (transferencia en USD).
  tipo_cambio_aplicado NUMERIC(10, 4),
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'exitoso', 'fallido')),
  id_pasarela TEXT,
  intento_numero SMALLINT NOT NULL DEFAULT 1,
  motivo_fallo TEXT,
  -- Solo tiene sentido para tipo = 'suscripcion': qué período cubre este
  -- pago puntual (así un tenant "mensual" que paga el año completo de una
  -- sola vez no necesita 12 filas ni cambiar su ciclo).
  periodo_inicio TIMESTAMPTZ,
  periodo_fin TIMESTAMPTZ,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Comprobante que el TENANT descarga desde su panel ───────────────────────
CREATE TABLE IF NOT EXISTS facturas (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  cobro_id UUID NOT NULL UNIQUE REFERENCES cobros(id),
  -- NULL hasta generarlo. Solo 'comprobante_pago' tiene generación real hoy
  -- -- 'boleta'/'factura' quedan en el CHECK para no migrar de nuevo el
  -- día que haya empresa formal, pero no hay código que los emita todavía.
  comprobante_tipo TEXT CHECK (comprobante_tipo IN ('comprobante_pago', 'boleta', 'factura')),
  -- Numeración interna propia (ej. "CP-2026-000123"), NO la serie de SUNAT
  -- -- esa recién existe para boleta/factura cuando se automaticen.
  comprobante_numero TEXT,
  comprobante_emitido_en TIMESTAMPTZ,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Eventos crudos de la pasarela, para procesamiento idempotente ──────────
CREATE TABLE IF NOT EXISTS webhooks_pasarela (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pasarela TEXT NOT NULL,
  -- Id que manda la pasarela -- UNIQUE junto con `pasarela` es lo que
  -- vuelve idempotente el reintento de un webhook (la pasarela reintenta
  -- si no responde 200 rápido).
  evento_id TEXT NOT NULL,
  tipo TEXT NOT NULL,
  payload JSONB NOT NULL,
  procesado_en TIMESTAMPTZ,
  creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pasarela, evento_id)
);

CREATE INDEX IF NOT EXISTS idx_cobros_tenant ON cobros(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cobros_suscripcion ON cobros(suscripcion_id) WHERE suscripcion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cobros_metodo_pago ON cobros(metodo_pago_id) WHERE metodo_pago_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facturas_tenant ON facturas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_metodos_pago_tenant ON metodos_pago(tenant_id);
CREATE INDEX IF NOT EXISTS idx_suscripciones_plan ON suscripciones(plan_id);
