-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: fundación multi-tenant + autenticación
--
-- A diferencia del CRM Zincel (donde tenant_id se agregó después, ya con
-- datos, y por eso necesitó un DEFAULT retroactivo), este ERP arranca
-- multi-tenant desde el día uno: tenant_id es NOT NULL sin DEFAULT en las
-- tablas de negocio, así que cada INSERT nuevo está obligado a declararlo
-- explícitamente y es imposible que una fila quede huérfana de tenant.
--
-- EJECUTAR:
--   psql -d cushuro_erp -f migrations/0001_tenants_usuarios.sql
--
-- Requiere que el usuario que ejecuta esto sea el owner de las tablas del
-- ERP (o superusuario). A diferencia de Zincel, NO uses `postgres` como
-- owner de las tablas de la app — crea un usuario de aplicación dedicado
-- y que sea owner desde esta primera migración, para no depender de sudo
-- en cada ALTER TABLE futuro.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Tenants ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre     TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  activo     BOOLEAN NOT NULL DEFAULT true,
  creado_en  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenant inicial (la propia empresa, primer cliente del ERP)
INSERT INTO tenants (id, nombre, slug)
VALUES ('00000000-0000-4000-8000-000000000001', 'Cushuro', 'cushuro')
ON CONFLICT (id) DO NOTHING;

-- ── Roles y usuarios ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE rol_usuario AS ENUM ('admin', 'operador', 'lectura');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS usuarios (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id),
  nombre         VARCHAR(100) NOT NULL,
  email          VARCHAR(150) NOT NULL,
  password_hash  VARCHAR(255) NOT NULL,
  rol            rol_usuario NOT NULL DEFAULT 'operador',
  activo         BOOLEAN NOT NULL DEFAULT true,
  creado_en      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- el email es único DENTRO de un tenant, no globalmente: dos empresas
  -- distintas usando el ERP como SaaS pueden tener cada una un admin@empresa.com
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS idx_usuarios_tenant ON usuarios(tenant_id);

-- ── tenant_id en el resto de tablas de negocio ya existentes ────────────
-- (repuestos, combustible, documentos, etc. — lo que exista al momento de
-- correr esto). Sin DEFAULT: si alguna tabla ya tiene filas, este paso
-- fallará y hay que decidir a mano a qué tenant pertenecen esas filas
-- (usualmente el tenant inicial de arriba) antes de quitar el DEFAULT.
--
-- refresh_tokens EXCLUIDA a propósito: se relaciona con el tenant de forma
-- indirecta (a través de usuario_id → usuarios.tenant_id), no directo. Si
-- esta migración se re-corre después de que 0004_refresh_tokens.sql ya creó
-- esa tabla (ej. reaplicando migraciones fuera de orden), este loop se la
-- agregaría por error — ya pasó una vez en desarrollo local y rompía el
-- INSERT de emitirRefreshToken() en auth.service.ts al quedar NOT NULL sin
-- default.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('tenants', 'usuarios', 'refresh_tokens')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'tenant_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id UUID REFERENCES tenants(id)', t);
      EXECUTE format(
        'UPDATE %I SET tenant_id = ''00000000-0000-4000-8000-000000000001'' WHERE tenant_id IS NULL', t
      );
      EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(tenant_id)', 'idx_' || t || '_tenant', t);
    END IF;
  END LOOP;
END $$;

-- Verificación rápida
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'tenant_id'
ORDER BY table_name;
