import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The demo imports the library from source, so every deploy shows the code
// that is in the repository at that commit.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "ckb-session-kit": fileURLToPath(new URL("../src/index.ts", import.meta.url)) },
  },
});
