import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) throw new Error(".env already exists and was not overwritten.");
const template = readFileSync(".env.example", "utf8");
writeFileSync(
  ".env",
  template
    .replace(
      "OFIS_SECRET_KEY=",
      "OFIS_SECRET_KEY=" + randomBytes(32).toString("hex"),
    )
    .replace(
      "OFIS_RUNNER_KEY=",
      "OFIS_RUNNER_KEY=" + randomBytes(32).toString("hex"),
    ),
  { mode: 0o600, flag: "wx" },
);
console.log(
  ".env is ready. Set the owner password and dedicated agent Tududi administrator credentials in this file.",
);
