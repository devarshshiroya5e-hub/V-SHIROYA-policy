import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    strictPort: false,
  },
  preview: {
    host: "0.0.0.0",
    strictPort: false,
  },
});
