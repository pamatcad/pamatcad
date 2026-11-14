import { spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const report = args.includes("--report");
const env = { ...process.env };
delete env.PAMATCAD_TEST_REPORT_DIR;
const runner = ["--test"];
if (report) {
  const parent = resolve("reports/tests");
  await mkdir(parent, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = await mkdtemp(join(parent, stamp + "-"));
  await mkdir(join(dir, "assets"));
  env.PAMATCAD_TEST_REPORT_DIR = dir;
  runner.push("--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=" + new URL("./reporter.mjs", import.meta.url).href,
    "--test-reporter-destination=" + join(dir, "index.html"));
}
runner.push(...args.filter(arg => arg !== "--report"), "tests/dist/api/**/*.js");
const child = spawn(process.execPath, runner, { env, stdio: "inherit" });
process.exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", code => resolve(code ?? 1));
});
if (report) console.log("Test report:", join(env.PAMATCAD_TEST_REPORT_DIR, "index.html"));
