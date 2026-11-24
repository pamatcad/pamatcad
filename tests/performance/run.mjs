import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  runtime: { type: "string", default: "native" },
  "test-name-pattern": { type: "string" },
} });
const runtime = values.runtime;
if (runtime !== "native" && runtime !== "wasm") throw new Error("Performance runtime must be native or wasm");
const env = { ...process.env, PAMATCAD_TEST_RUNTIME: runtime };
delete env.PAMATCAD_TEST_REPORT_DIR;

async function run(command, args) {
  const child = spawn(command, args, { env, stdio: "inherit" });
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

const built = runtime === "wasm"
  ? await run(process.execPath, ["tools/editor/build-wasm.mjs"])
  : await run("cargo", ["build", "--locked", "--release", "-p", "pamatcad-host"]);
const tests = ["--test", "--test-concurrency=1"];
if (values["test-name-pattern"]) tests.push("--test-name-pattern=" + values["test-name-pattern"]);
process.exitCode = built || await run(process.execPath, [...tests, "tests/dist/performance/**/*.js"]);
