import path from "node:path";

// client/ es un paquete npm separado (eslint.config.js, tsconfig y
// node_modules propios) -- eslint/prettier de la raíz lo ignoran a
// propósito (ver globalIgnores en eslint.config.js), así que sus archivos
// necesitan correr con los binarios instalados dentro de client/.
export default {
  "client/**/*.{js,jsx,ts,tsx}": (filenames) => {
    const clientDir = path.join(process.cwd(), "client");
    const relative = filenames.map((f) => path.relative(clientDir, f)).join(" ");
    return [`sh -c "cd client && eslint --fix ${relative} && prettier --write ${relative}"`];
  },
  "!(client)/**/*.{ts,js}": ["eslint --fix", "prettier --write"],
  "*.{ts,js}": ["eslint --fix", "prettier --write"],
};
