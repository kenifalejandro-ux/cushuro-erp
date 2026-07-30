// client/src/main.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './context/AuthContext';

// Importaciones globales (mantén solo las que realmente uses)
import './styles/globals.css';        // estilos globales
import './styles/index.css';          // si lo necesitas

// Opcional: si vas a usar íconos (Lucide, Heroicons, etc.)
// import './lib/icons';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found. Make sure <div id="root"></div> exists in index.html');
}

createRoot(rootElement).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);