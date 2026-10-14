/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  darkMode: 'class',
  theme: {
    extend: {
      // Body font matches the Satori app (Magic): Nunito everywhere. The
      // header wordmark ("Satori" / "daily") sets its own fonts inline, so it
      // stays exactly as designed — only the rest of the UI picks this up.
      fontFamily: {
        sans: [
          'Nunito',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        // Neutralized gray ramp — the app uses true-neutral near-black
        // surfaces (back #121212, front #2E2E2E, frontItem #3A3A3A), not the
        // blue-tinted Tailwind slate. Anchored on the app's values so the
        // whole dark UI reads as black instead of navy. Light-mode shades stay
        // bright and neutral. Monotonic, so existing elevation hierarchy holds.
        gray: {
          50: '#FAFAFA',
          100: '#F1F1F1',
          200: '#E3E3E3',
          300: '#C9C9C9',
          400: '#9A9A9A', // muted text (was blue-ish #9CA3AF)
          500: '#6E6E6E', // de-emphasized text
          600: '#454545', // dark borders / disabled bg (was #4B5563)
          700: '#2E2E2E', // dark inner surface — app `front`
          800: '#1C1C1C', // dark card surface
          900: '#121212', // dark root background — app `back`
          950: '#0A0A0A',
        },
        // Signature action-blue aligned to the app's button blue (#4A90E2 /
        // buttonLight #6AAFE6). Blue = "information" in the dapp; this is the
        // softer sky-blue the app uses rather than Tailwind's royal #2563EB.
        blue: {
          50: '#EAF3FC',
          100: '#D2E4F8',
          200: '#AECFF1',
          300: '#85B6EA', // info text on dark
          400: '#6AAFE6', // app buttonLight
          500: '#5599E0',
          600: '#4A90E2', // app button — primary action
          700: '#3B79C4', // hover
          800: '#2F5E99',
          900: '#24466F', // info-chip bg (used at low opacity)
        },
      },
    },
  },
  plugins: [],
}
