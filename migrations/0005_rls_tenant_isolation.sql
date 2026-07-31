-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: Row-Level Security como red de seguridad multi-tenant
--
-- Hasta ahora, el aislamiento entre tenants dependía 100% de que cada query
-- en el código de la app se acuerde de filtrar por tenant_id. Un olvido en
-- una query nueva = un cliente viendo datos de otro. Esta migración hace
-- que la base de datos misma rechace cualquier fila que no sea del tenant
-- activo en la sesión, sin importar si la query de la app lo filtró o no.
--
-- Requiere que la app setee app.tenant_id en cada transacción antes de
-- consultar estas tablas (ver withTenant() en src/server/config/database.ts).
-- Sin `missing_ok` en current_setting: si una query llega a tocar estas
-- tablas sin haber seteado app.tenant_id, Postgres lanza un error en vez
-- de devolver una lista vacía silenciosa — un bug así se nota de inmediato
-- (500 en desarrollo/pruebas), no se queda escondido como "el tenant no
-- tiene datos".
--
-- EJECUTAR (después de 0002_business_tables.sql):
--   psql -d mincoreerp -f migrations/0005_rls_tenant_isolation.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ── repuestos: si la BD ya tenía un UNIQUE(codigo) global (de antes de que
-- existiera tenant_id), lo reemplaza por UNIQUE(tenant_id, codigo) — dos
-- tenants deben poder tener ambos, por ejemplo, el código "FIL-001".
-- En una BD nueva (creada ya con el constraint compuesto en
-- 0002_business_tables.sql) este bloque no encuentra nada que cambiar.
DO $$
DECLARE v_old_constraint text;
BEGIN
  SELECT tc.constraint_name INTO v_old_constraint
  FROM information_schema.table_constraints tc
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
   AND tc.table_schema = ccu.table_schema
  WHERE tc.table_schema = 'public'
    AND tc.table_name = 'repuestos'
    AND tc.constraint_type = 'UNIQUE'
    AND ccu.column_name = 'codigo'
  GROUP BY tc.constraint_name
  HAVING COUNT(*) = 1;

  IF v_old_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE repuestos DROP CONSTRAINT %I', v_old_constraint);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'repuestos'
      AND constraint_name = 'repuestos_tenant_id_codigo_key'
  ) THEN
    ALTER TABLE repuestos ADD CONSTRAINT repuestos_tenant_id_codigo_key UNIQUE (tenant_id, codigo);
  END IF;
END $$;

-- ── Row-Level Security en las tablas de negocio ─────────────────────────
-- FORCE es imprescindible: sin él, el owner de la tabla (el mismo usuario
-- con el que se conecta la app, ver 0001_tenants_usuarios.sql) queda
-- exento de RLS por default en Postgres, y la política nunca aplicaría a
-- las queries de la propia app.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['repuestos', 'combustible', 'documentos'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I
           USING (tenant_id = current_setting(''app.tenant_id'')::uuid)
           WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;
