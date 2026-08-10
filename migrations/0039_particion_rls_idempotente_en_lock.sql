-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: particion_rls_asegurar() idempotente también a nivel de LOCK
--
-- ── El bug ────────────────────────────────────────────────────────────────
--
-- particion_rls_asegurar() (migrations/0037_particionado_tablas.sql) hacía
-- `ALTER TABLE %I ENABLE/FORCE ROW LEVEL SECURITY` INCONDICIONALMENTE en
-- cada partición, en cada corrida de particiones_asegurar_futuras() —
-- incluidas las 9-19 particiones que YA tienen RLS activo desde que se
-- crearon. El resultado era idempotente en el DATO (dejaba el mismo
-- estado), pero no en el LOCK: cada ALTER, aunque sea un no-op semántico,
-- exige AccessExclusiveLock real sobre esa partición — incluida la del MES
-- ACTUAL, que es justo la que recibe tráfico real (INSERTs de checklists/
-- IPERC) en simultáneo.
--
-- ── Cómo se confirmó ─────────────────────────────────────────────────────
--
-- Reproducido en vivo con pg_locks: una sesión sosteniendo una fila abierta
-- en ipercs_2026_08 (RowExclusiveLock, vía un INSERT sin commitear) más una
-- llamada concurrente a particiones_asegurar_futuras(9) — la función
-- adquirió AccessExclusiveLock en las 10 particiones de checklists sin
-- problema (nadie las estaba tocando) y quedó bloqueada esperando
-- AccessExclusiveLock en ipercs_2026_08. Ese es exactamente el setup de un
-- deadlock de dos partes: si OTRA sesión sostiene un lock en una relación
-- que esta transacción ya tiene (ej. una tabla que ya bloqueó) y encima
-- necesita algo que esta transacción tiene reservado, Postgres lo detecta y
-- aborta una de las dos con 40P01 — que es exactamente el error real que
-- apareció en una corrida completa de la suite (proceso A queriendo
-- AccessExclusiveLock bloqueado por B, proceso B queriendo RowExclusiveLock
-- bloqueado por A).
--
-- Importante: el advisory lock que ya usa particionado.worker.ts
-- (LOCK_IDS.particionado, ver advisoryLock.ts) NO resuelve este problema —
-- solo serializa dos llamadas a la MISMA función entre sí, y es invisible
-- para un INSERT/DELETE normal, que nunca lo consulta. El conflicto real es
-- contra tráfico de aplicación común, no contra otra corrida del worker.
--
-- ── El fix ────────────────────────────────────────────────────────────────
--
-- Antes de ejecutar el ALTER, chequear si la partición YA tiene
-- relrowsecurity + relforcerowsecurity en true — si es así, no hay nada que
-- hacer, se saltea sin tocar el lock. Consecuencia práctica: el único ALTER
-- que se ejecuta de verdad es sobre la partición recién creada en esa misma
-- corrida (siempre un mes FUTURO, sin ninguna fila ni tráfico concurrente
-- posible por construcción — nadie inserta en la partición del mes que
-- viene antes de que llegue). Las particiones activas dejan de tomar
-- AccessExclusiveLock salvo la primera vez que se crean.
--
-- Comportamiento sin cambios: misma policy tenant_isolation, mismo momento
-- en que se crea (la primera vez que la partición existe), mismo margen de
-- meses en particiones_asegurar_futuras().
--
-- EJECUTAR (después de 0038):
--   psql -d mincoreerp -f migrations/0039_particion_rls_idempotente_en_lock.sql
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION particion_rls_asegurar(p_relacion text) RETURNS void AS $$
DECLARE
  ya_asegurada boolean;
BEGIN
  SELECT relrowsecurity AND relforcerowsecurity INTO ya_asegurada
  FROM pg_class WHERE relname = p_relacion;

  IF NOT ya_asegurada THEN
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_relacion);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', p_relacion);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = p_relacion AND policyname = 'tenant_isolation'
  ) THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_setting(''app.tenant_id'')::uuid)
         WITH CHECK (tenant_id = current_setting(''app.tenant_id'')::uuid)',
      p_relacion
    );
  END IF;
END;
$$ LANGUAGE plpgsql;
