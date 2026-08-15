// client/src/platform/PlatformAdminsView.tsx
//
// Solo se monta si /whoami dijo esSuperAdmin=true (ver PlatformApp.tsx) —
// igual el backend vuelve a exigir super_admin en cada request
// (platformSuperAdminMiddleware), esto es nada más para no mostrar un
// botón que va a terminar en 403.

import { useEffect, useState, type FormEvent } from "react";

import CambiarEstadoDialog from "./CambiarEstadoDialog";
import PasswordInput from "./PasswordInput";
import {
  listarPlatformAdminsApi,
  crearPlatformAdminApi,
  cambiarEstadoPlatformAdminApi,
  listarSesionesDeAdminApi,
  revocarSesionPlataformaApi,
  type PlatformAdmin,
  type SesionActivaAdmin,
} from "./platformApi";

export default function PlatformAdminsView() {
  const [admins, setAdmins] = useState<PlatformAdmin[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [adminParaCambiarEstado, setAdminParaCambiarEstado] = useState<PlatformAdmin | null>(null);
  const [adminExpandido, setAdminExpandido] = useState<string | null>(null);

  async function recargar() {
    setCargando(true);
    try {
      setAdmins(await listarPlatformAdminsApi());
      setError(null);
    } catch (err: any) {
      setError(err.message || "No se pudo cargar la lista de admins");
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    recargar();
  }, []);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
        <h2 className="text-lg font-light text-slate-100">Admins de plataforma</h2>
        <button
          onClick={() => setMostrarForm((v) => !v)}
          className="shrink-0 px-4 py-2 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white transition-colors"
        >
          {mostrarForm ? "Cancelar" : "+ Nuevo admin"}
        </button>
      </div>
      <p className="text-xs text-slate-500 mb-6">
        Cuentas individuales del panel de plataforma. El secreto compartido sigue funcionando como
        acceso de emergencia — no depende de que exista ningún admin acá.
      </p>

      {mostrarForm && (
        <NuevoAdminForm
          onCreado={() => {
            setMostrarForm(false);
            recargar();
          }}
        />
      )}

      {error && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2 mb-4">
          {error}
        </p>
      )}

      {adminParaCambiarEstado && (
        <CambiarEstadoDialog
          activarA={!adminParaCambiarEstado.activo}
          entidadNombre={adminParaCambiarEstado.email}
          onConfirmar={async (motivo) => {
            await cambiarEstadoPlatformAdminApi(
              adminParaCambiarEstado.id,
              !adminParaCambiarEstado.activo,
              motivo
            );
            setAdminParaCambiarEstado(null);
            recargar();
          }}
          onCancelar={() => setAdminParaCambiarEstado(null)}
        />
      )}

      {cargando ? (
        <p className="text-sm text-slate-400">Cargando...</p>
      ) : (
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          {admins.map((a) => (
            <div key={a.id} className="border-t border-slate-800 first:border-t-0">
              <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-slate-200 truncate">{a.nombre}</p>
                  <p className="text-xs text-slate-500 truncate">
                    {a.email} · {a.rol === "super_admin" ? "Super-admin" : "Admin"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`px-2 py-0.5 rounded-full text-xs ${
                      a.activo ? "bg-emerald-950 text-emerald-400" : "bg-slate-800 text-slate-400"
                    }`}
                  >
                    {a.activo ? "Activo" : "Desactivado"}
                  </span>
                  <button
                    onClick={() => setAdminExpandido((v) => (v === a.id ? null : a.id))}
                    className="text-xs text-slate-400 hover:text-slate-100 underline underline-offset-2"
                  >
                    Sesiones
                  </button>
                  <button
                    onClick={() => setAdminParaCambiarEstado(a)}
                    className={`text-xs font-medium ${a.activo ? "text-red-400 hover:text-red-300" : "text-emerald-400 hover:text-emerald-300"}`}
                  >
                    {a.activo ? "Desactivar" : "Activar"}
                  </button>
                </div>
              </div>
              {adminExpandido === a.id && <SesionesDeAdmin adminId={a.id} onError={setError} />}
            </div>
          ))}
          {admins.length === 0 && (
            <p className="px-4 py-6 text-center text-slate-500 text-sm">
              No hay admins de plataforma todavía.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SesionesDeAdmin({
  adminId,
  onError,
}: {
  adminId: string;
  onError: (msg: string) => void;
}) {
  const [sesiones, setSesiones] = useState<SesionActivaAdmin[] | null>(null);

  async function cargar() {
    try {
      setSesiones(await listarSesionesDeAdminApi(adminId));
    } catch (err: any) {
      onError(err.message || "No se pudieron cargar las sesiones");
    }
  }

  useEffect(() => {
    // Patrón estándar de carga al montar (setCargando(true) -> fetch ->
    // setCargando(false)), usado en toda la app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminId]);

  async function revocar(sessionId: string) {
    try {
      await revocarSesionPlataformaApi(sessionId);
      cargar();
    } catch (err: any) {
      onError(err.message || "No se pudo revocar la sesión");
    }
  }

  if (sesiones === null) {
    return <p className="px-4 pb-3 text-xs text-slate-500 bg-slate-950/40">Cargando sesiones...</p>;
  }

  return (
    <div className="px-4 pb-3 bg-slate-950/40">
      {sesiones.length === 0 ? (
        <p className="text-xs text-slate-500">
          Sin sesiones activas (ya expiraron, se cerraron, o no hay Redis configurado — sin Redis no
          hay sesión revocable).
        </p>
      ) : (
        <ul className="space-y-1.5">
          {sesiones.map((s) => (
            <li
              key={s.sessionId}
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-xs text-slate-400"
            >
              <span>
                {s.ip} · desde {new Date(s.creadaEn).toLocaleString()}
              </span>
              <button
                onClick={() => revocar(s.sessionId)}
                className="self-start sm:self-auto text-red-400 hover:text-red-300 font-medium"
              >
                Revocar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NuevoAdminForm({ onCreado }: { onCreado: () => void }) {
  const [email, setEmail] = useState("");
  const [nombre, setNombre] = useState("");
  const [password, setPassword] = useState("");
  const [rol, setRol] = useState<"admin" | "super_admin">("admin");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      await crearPlatformAdminApi({ email, nombre, password, rol });
      onCreado();
    } catch (err: any) {
      setError(err.message || "No se pudo crear el admin");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-slate-900 border border-slate-800 rounded-xl p-4 mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3"
    >
      <input
        required
        value={nombre}
        onChange={(e) => setNombre(e.target.value)}
        placeholder="Nombre"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <input
        required
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Correo"
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      />
      <PasswordInput
        id="nuevoAdminPassword"
        required
        minLength={8}
        value={password}
        onChange={setPassword}
        placeholder="Contraseña inicial"
      />
      <select
        value={rol}
        onChange={(e) => setRol(e.target.value as "admin" | "super_admin")}
        className="px-3 py-2 rounded-lg border border-slate-700 bg-slate-950 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-500/30"
      >
        <option value="admin">admin</option>
        <option value="super_admin">super_admin</option>
      </select>

      {error && (
        <p className="sm:col-span-2 text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={enviando}
        className="sm:col-span-2 py-2.5 rounded-lg bg-slate-100 text-slate-900 text-sm font-medium hover:bg-white disabled:opacity-50 transition-colors"
      >
        {enviando ? "Creando..." : "Crear admin"}
      </button>
    </form>
  );
}
