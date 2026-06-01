/*client/tailwind.config.js*/

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {},
  },
  plugins: [
    require("tailwindcss-animate"),
  ],
  safelist: [
    "hover:bg-purple-400",
    "hover:bg-emerald-300",
    "hover:bg-pink-500",
    "hover:bg-amber-400",

    "hover:bg-amber-400",
    "hover:bg-red-700",
     "hover:bg-yellow-400",
     "hover:bg-amber-600",
    // todos los que uses
  ],
}