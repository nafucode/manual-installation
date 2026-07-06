/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
    },
    extend: {
      colors: {
        ink: {
          950: "#050B14",
          900: "#0B1B2B",
          800: "#122536",
          700: "#1B3245",
          600: "#294559",
        },
        gold: {
          500: "#E8A53B",
          400: "#F0B95A",
          300: "#F6D28C",
        },
        cool: {
          500: "#8A96A3",
          400: "#A8B3BF",
          300: "#C7CFD8",
        },
      },
      fontFamily: {
        display: ['"Bebas Neue"', '"Space Grotesk"', '"PingFang SC"', "sans-serif"],
        sans: ['"Space Grotesk"', '"Inter"', '"PingFang SC"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        poster: "0 40px 80px -20px rgba(0, 0, 0, 0.35), 0 12px 30px -12px rgba(0, 0, 0, 0.25)",
      },
    },
  },
  plugins: [],
};
