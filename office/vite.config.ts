import { defineConfig } from "vite";
import { sourceBuildId } from "./server/build-version";
import react from "@vitejs/plugin-react";
const buildId=sourceBuildId();
export default defineConfig({
  define: {"import.meta.env.OFIS_BUILD_ID":JSON.stringify(buildId)},
  plugins: [react(),{name:"ofis-build-id",generateBundle(){this.emitFile({type:"asset",fileName:"build-id.json",source:JSON.stringify({id:buildId})});}}],
  build: { outDir: "dist/client" },
  server: { proxy: { "/api": "http://127.0.0.1:9400" } },
});
