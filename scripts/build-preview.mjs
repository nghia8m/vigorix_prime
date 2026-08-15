// Local QA build that renders draft products. Cross-platform replacement for
// `ALLOW_DRAFT_PRODUCTS=1 astro build` (which PowerShell does not understand).
// The output of this build is for looking at on localhost only — never deploy it.
import { spawn } from "node:child_process";

const child = spawn("npx", ["astro", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, ALLOW_DRAFT_PRODUCTS: "1" },
});

child.on("exit", (code) => process.exit(code ?? 1));
