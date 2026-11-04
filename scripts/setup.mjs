import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (existsSync(".env")) {
  console.log(".env exists; credentials were preserved.");
  process.exit(0);
}
const password = randomBytes(15).toString("base64url");
writeFileSync(
  ".env",
  `PORT=4310\nHOST=127.0.0.1\nAPP_URL=http://localhost:4310\nJUDGE_EMAIL=judge@paperbridge.demo\nJUDGE_PASSWORD=${password}\nSESSION_SECRET=${randomBytes(48).toString("hex")}\nPYTHON=python\n`,
  { mode: 0o600 },
);
writeFileSync(
  "JUDGE-ACCESS.local.md",
  `Judge URL: http://localhost:4310\nEmail: judge@paperbridge.demo\nPassword: ${password}\n\nThis file is ignored by Git. Configure secrets in your hosting dashboard for public judging.\n`,
  { mode: 0o600 },
);
console.log(
  "Created .env and JUDGE-ACCESS.local.md. No credentials are tracked.",
);
