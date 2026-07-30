// client/src/components/layout/Header.tsx
import { useAuth } from '../../context/AuthContext';

export default function Header() {
  const { usuario, logout } = useAuth();

  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-xl border-b border-slate-200">
      <div className="max-w-7xl mx-auto px-6 lg:px-8 py-4">
        <div className="flex items-center justify-between gap-6">

          {/* Logo y Brand */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-slate-900 rounded-lg flex items-center justify-center">
              <span className="text-white font-semibold text-sm">M</span>
            </div>
            <div>
              <h1 className="text-xl font-light text-slate-900 tracking-tight">
                MinCore ERP
              </h1>
            </div>
          </div>

          {/* Date and User */}
          <div className="hidden md:flex items-center gap-6">
            <div className="text-right">
              <p className="text-sm font-light text-slate-600">
                {new Date().toLocaleDateString('es-PE', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric'
                })}
              </p>
            </div>
            <div className="w-px h-8 bg-slate-200"></div>
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center">
                <div className="w-3 h-3 bg-slate-400 rounded-sm"></div>
              </div>
              <div>
                <p className="text-sm font-light text-slate-900">{usuario?.nombre ?? 'Usuario'}</p>
              </div>
            </div>
            <button
              onClick={() => logout()}
              className="text-sm font-light text-slate-500 hover:text-slate-900 transition-colors"
            >
              Salir
            </button>
          </div>

        </div>
      </div>
    </header>
  );
}
