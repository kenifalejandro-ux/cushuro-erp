-- ═══════════════════════════════════════════════════════════════════════════
-- Migración: session_id en refresh_tokens -- soporte para múltiples sesiones
--
-- Hasta acá un usuario solo podía tener UNA sesión activa a la vez: cada
-- login (contraseña, Google o SSO -- los tres pasan por
-- emitirSesionCompleta()) pisaba la key `session:<usuarioId>` en Redis, así
-- que loguearse desde un segundo dispositivo cerraba el primero sin aviso
-- (ver auth.service.ts para el detalle completo del cambio).
--
-- Esta columna es la pieza que faltaba en Postgres para suavizar eso a
-- múltiples sesiones concurrentes: identifica a qué SESIÓN (no solo a qué
-- usuario) pertenece cada refresh token, para poder cerrar una sola
-- (logout de un dispositivo) sin tocar las demás.
--
-- Se genera una vez en el login y se PROPAGA sin cambiar en cada rotación
-- de refrescarTokenService() -- refrescar el access token no es una sesión
-- nueva, es la misma sesión extendiéndose. Nullable a propósito: filas
-- viejas (emitidas antes de este cambio) quedan con session_id NULL, y como
-- los refresh tokens rotan en cada uso y expiran solos
-- (env.sessionTtlSeconds), se autolimpian sin backfill -- el primer refresh
-- de cada dispositivo después del deploy ya le asigna un session_id nuevo.
--
-- EJECUTAR (después de 0039):
--   psql -d mincoreerp -f migrations/0040_refresh_tokens_session_id.sql
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS session_id UUID;

-- Usado por logoutService() para revocar solo el refresh token de ESTA
-- sesión sin tener que escanear todas las filas del usuario.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_usuario_sesion
  ON refresh_tokens(usuario_id, session_id)
  WHERE session_id IS NOT NULL AND revocado_en IS NULL;
