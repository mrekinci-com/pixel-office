import { languageFrom } from "../../office/shared/i18n/index.js";
import { t as tx, withLanguage } from "./i18n.js";
import { Worker } from "./worker.js";
import { loadConfig } from "./config.js";
const startupLanguage=languageFrom(process.env.LANG || "tr");
const worker = new Worker(withLanguage(startupLanguage,()=>({...loadConfig(),language:startupLanguage})));
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    closing = true;
    void worker.shutdown();
  });
while (!closing) {
  try {
    await worker.tick();
  } catch (error) {
    withLanguage(worker.config.language || startupLanguage,()=>{
    for (const running of worker.active.values())
      running.stop(tx("Ofis bağlantısı kesildi."));
    console.error(error instanceof Error && /sürümü uyumsuz|version mismatch/i.test(error.message) ? "Office/runner version mismatch; update both components." : "Office connection failed. The runner will retry.");
    });
  }
  if (!closing) await new Promise((resolve) => setTimeout(resolve, 1000));
}
