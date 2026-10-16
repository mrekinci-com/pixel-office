import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
const config = loadConfig();
const { app } = await createApp(config);
// OFIS_BIND keeps the test listener on 127.0.0.1.
await app.listen({ port: config.port, host: process.env.OFIS_BIND || "127.0.0.1" });
console.log(`Pixel Office is ready on port ${config.port}.`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
