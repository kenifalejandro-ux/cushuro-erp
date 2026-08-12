// client/src/components/layout/EstadoOffline.tsx
//
// Franja de estado de conexión y sincronización.
//
// Va en el Layout y no dentro de Checklists a propósito: el motor offline
// es transversal (hoy Checklists, después IPERC y Combustible), y sobre
// todo, un operario que perdió la señal necesita enterarse esté donde
// esté — no solo si justo tiene abierta la pantalla del módulo que encoló
// algo.
//
// Se muestra solo cuando hay algo que decir. Un badge permanente de "en
// línea" es ruido: el estado normal no necesita anunciarse.

import { useEffect, useState } from "react";

import { useAuth } from "../../context/AuthContext";
import { suscribirseAConectividad } from "../../offline/connectivity";
import { suscribirseACola } from "../../offline/offlineQueue";
import { drenar } from "../../offline/offlineSync";

export default function EstadoOffline() {
  const { usuario } = useAuth();
  const [online, setOnline] = useState(true);
  const [pendientes, setPendientes] = useState(0);
  const [sincronizando, setSincronizando] = useState(false);

  useEffect(() => suscribirseAConectividad(setOnline), []);
  // Depende de usuario?.id y no de [] a propósito: la cola se cuenta por
  // usuario (una tablet de planta la comparten varios operarios), y los
  // efectos de un hijo corren ANTES que los del padre — o sea, la primera
  // suscripción ocurre cuando AuthContext todavía no registró quién entró,
  // y contaría 0 para siempre. Re-suscribirse al cambiar el usuario es lo
  // que hace que el badge muestre lo que de verdad tiene pendiente.
  useEffect(() => suscribirseACola(setPendientes), [usuario?.id]);

  if (online && pendientes === 0) return null;

  const sincronizarAhora = async () => {
    setSincronizando(true);
    try {
      await drenar();
    } finally {
      setSincronizando(false);
    }
  };

  // Sin conexión pesa más que "hay pendientes": si no hay red, los
  // pendientes no se pueden mandar igual, así que lo accionable es el
  // estado de la señal.
  const sinConexion = !online;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`px-4 py-2 text-sm font-medium flex items-center justify-center gap-3 ${
        sinConexion
          ? "bg-amber-50 text-amber-900 border-b border-amber-200"
          : "bg-sky-50 text-sky-900 border-b border-sky-200"
      }`}
    >
      <span
        aria-hidden="true"
        className={`w-2 h-2 rounded-full ${sinConexion ? "bg-amber-500" : "bg-sky-500"}`}
      />
      {sinConexion ? (
        <span>
          Sin conexión. Podés seguir trabajando: lo que registres se guarda en este equipo
          {pendientes > 0 && ` (${pendientes} sin enviar)`}.
        </span>
      ) : (
        <>
          <span>
            {pendientes} {pendientes === 1 ? "registro pendiente" : "registros pendientes"} de
            sincronizar.
          </span>
          <button
            onClick={sincronizarAhora}
            disabled={sincronizando}
            className="underline underline-offset-2 hover:no-underline disabled:opacity-50"
          >
            {sincronizando ? "Sincronizando..." : "Sincronizar ahora"}
          </button>
        </>
      )}
    </div>
  );
}
