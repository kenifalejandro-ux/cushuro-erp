// client/src/platform/PlatformApp.tsx
//
// Se renderiza fuera de <AuthProvider> (ver main.tsx) — no usa useAuth()
// en ningún momento, la sesión acá es la cookie httpOnly `platform_session`
// (ver platformApi.ts), completamente separada de la de cualquier tenant.

import { useEffect, useState } from "react";

import AuditoriaView from "./AuditoriaView";
import CambiarPasswordDialog from "./CambiarPasswordDialog";
import PlatformAdminsView from "./PlatformAdminsView";
import {
  whoamiApi,
  cerrarSesionPlataformaApi,
  listarTenantsApi,
  type TenantPlataforma,
  type QuienSoy,
} from "./platformApi";
import PlatformLoginPage from "./PlatformLoginPage";
import TenantDetalleView from "./TenantDetalleView";
import TenantsView from "./TenantsView";

type Seccion = "tenants" | "auditoria" | "admins";

export default function PlatformApp() {
  const [quienSoy, setQuienSoy] = useState<QuienSoy | null | undefined>(undefined);
  const [seccion, setSeccion] = useState<Seccion>("tenants");
  const [tenantSeleccionado, setTenantSeleccionado] = useState<TenantPlataforma | null>(null);
  const [cambiandoPassword, setCambiandoPassword] = useState(false);

  useEffect(() => {
    whoamiApi()
      .then(setQuienSoy)
      .catch(() => setQuienSoy(null));
  }, []);

  if (quienSoy === undefined) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <p className="text-slate-400 text-sm">Cargando...</p>
      </div>
    );
  }

  if (!quienSoy) {
    return <PlatformLoginPage onExito={() => whoamiApi().then(setQuienSoy)} />;
  }

  async function salir() {
    await cerrarSesionPlataformaApi();
    setQuienSoy(null);
    setTenantSeleccionado(null);
  }

  return (
    <div className="min-h-screen bg-[#0A1014]">
      <header className="border-b border-slate-800 px-4 sm:px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-slate-100 font-light text-sm tracking-tight">
            MinCore ERP · Plataforma
          </span>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <button
              onClick={() => {
                setSeccion("tenants");
                setTenantSeleccionado(null);
              }}
              className={`text-sm ${seccion === "tenants" ? "text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
            >
              Empresas
            </button>
            <button
              onClick={() => setSeccion("auditoria")}
              className={`text-sm ${seccion === "auditoria" ? "text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
            >
              Auditoría
            </button>
            {quienSoy.esSuperAdmin && (
              <button
                onClick={() => setSeccion("admins")}
                className={`text-sm ${seccion === "admins" ? "text-slate-100" : "text-slate-500 hover:text-slate-300"}`}
              >
                Admins
              </button>
            )}
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span
            className={`text-xs truncate max-w-[220px] sm:max-w-none ${
              quienSoy.actorType === "emergency_shared_secret" ? "text-amber-400" : "text-slate-500"
            }`}
            title={
              quienSoy.actorType === "emergency_shared_secret"
                ? "Acceso de emergencia (secreto compartido)"
                : (quienSoy.actorLabel ?? "")
            }
          >
            {quienSoy.actorLabel}
          </span>
          {quienSoy.actorType === "platform_admin" && (
            <button
              onClick={() => setCambiandoPassword(true)}
              className="text-sm text-slate-500 hover:text-slate-300"
            >
              Cambiar contraseña
            </button>
          )}
          <button onClick={salir} className="text-sm text-slate-500 hover:text-slate-300">
            Salir
          </button>
        </div>
      </header>

      {cambiandoPassword && (
        <CambiarPasswordDialog
          onCancelar={() => setCambiandoPassword(false)}
          onExito={() => {
            setCambiandoPassword(false);
            setQuienSoy(null);
            setTenantSeleccionado(null);
          }}
        />
      )}

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {seccion === "tenants" &&
          (tenantSeleccionado ? (
            <TenantDetalleView
              tenant={tenantSeleccionado}
              onVolver={() => setTenantSeleccionado(null)}
              onCambio={async () => {
                const tenants = await listarTenantsApi();
                const actualizado = tenants.find((t) => t.id === tenantSeleccionado.id);
                setTenantSeleccionado(actualizado ?? null);
              }}
            />
          ) : (
            <TenantsView onSeleccionar={setTenantSeleccionado} />
          ))}

        {seccion === "auditoria" && <AuditoriaView />}

        {seccion === "admins" && quienSoy.esSuperAdmin && <PlatformAdminsView />}
      </main>
    </div>
  );
}
