-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: cuotas operativas por tenant
--
-- Límites de VOLUMEN por cliente: cuántos usuarios activos puede tener,
-- cuántos registros por módulo, y cuánto puede ocupar el total de sus
-- backups. Ver docs/architecture/cuotas-por-tenant.md.
--
-- ── Por qué esta tabla guarda solo EXCEPCIONES ──────────────────────────
--
-- El límite por defecto de cada recurso vive en CÓDIGO, no acá: los de
-- módulo en el propio registry (`cuota` en ModuloDefinicion, igual que ya
-- declara sus tablas — ver ADR-0002), y los de usuarios/backups como
-- constantes en platformCuotas.service.ts. Esta tabla solo registra el
-- override de un tenant puntual.
--
-- La consecuencia práctica es la que importa: subirle el límite por
-- defecto a TODOS los clientes es un cambio de una línea en el registry y
-- un deploy, no un UPDATE masivo sobre esta tabla que haya que acordarse
-- de correr. Y un tenant sin filas acá no significa "sin límite", significa
-- "los límites estándar" — que es el default seguro.
--
-- ── Tres estados, los tres con significado propio ───────────────────────
--
--   sin fila          → se aplica el límite por defecto del código.
--   fila con limite=N → ese tenant tiene exactamente N.
--   fila con NULL     → ese tenant es ILIMITADO en ese recurso, aunque el
--                       código tenga un default. Hace falta poder decir
--                       "a este cliente no le apliques el límite" sin
--                       inventar un número gigante que después nadie sepa
--                       si era un límite real o un "sin límite" disfrazado.
--
-- Sin RLS, igual que tenant_modulos y el resto de las tablas de plataforma:
-- el panel necesita leerlas/escribirlas para cualquier tenant, fuera de
-- toda transacción con app.tenant_id seteado.
--
-- EJECUTAR (después de 0032):
--   psql -d mincoreerp -f migrations/0033_tenant_cuotas.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tenant_cuotas (
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'usuarios', 'backup_bytes', o el id de un módulo del registry
  -- ('equipos', 'repuestos', ...). Deliberadamente TEXT y no un enum: a
  -- diferencia de modulo_erp —que necesita el CHECK de la base porque
  -- gobierna qué ve cada usuario—, acá un valor desconocido simplemente no
  -- matchea ningún recurso y se ignora al resolver el límite. Un enum
  -- obligaría a una migración por cada módulo nuevo, justo lo que el
  -- Contrato de Módulo evita.
  recurso       TEXT NOT NULL,
  -- NULL = ilimitado a propósito (ver arriba). No confundir con "sin fila".
  limite        BIGINT,
  -- Por qué este tenant tiene un límite distinto: queda en la tabla y no
  -- solo en la auditoría, para que quien mire las cuotas mañana entienda
  -- el porqué sin tener que cruzar con platform_audit_log.
  motivo        TEXT,
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, recurso)
);

DO $$ BEGIN
  ALTER TABLE tenant_cuotas ADD CONSTRAINT tenant_cuotas_limite_no_negativo
    CHECK (limite IS NULL OR limite >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- La PK (tenant_id, recurso) ya cubre la lectura por tenant, que es el
-- único acceso real: siempre se resuelven todas las cuotas de UN tenant.
