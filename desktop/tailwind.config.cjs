/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        mizaj: { slate: '#0F172A', emerald: '#10B981', amber: '#F59E0B' }
      },
      fontFamily: {
        ui: ['Cairo', 'system-ui', 'sans-serif'],
        editor: ['var(--editor-font)', 'Amiri', 'serif']
      }
    }
  },
  plugins: []
}
