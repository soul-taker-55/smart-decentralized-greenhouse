/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#005C3F", // اللون الأخضر الغامق اللي بعتيه
        secondary: "#4A6359", // اللون الأخضر الزيتي
        tertiary: "#10B981", // اللون الأخضر الفاتح
        neutralbg: "#F0F4F2", // لون الخلفية
      },
    },
  },
  plugins: [],
};
