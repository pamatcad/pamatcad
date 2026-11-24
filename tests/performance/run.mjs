import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  runtime: { type: "string", default: "native" },
  "test-name-pattern": { type: "string" },
  "solver-profile": { type: "boolean", default: false },
} });
const runtime = values.runtime;
if (runtime !== "native" && runtime !== "wasm") throw new Error("Performance runtime must be native or wasm");
const env = { ...process.env, PAMATCAD_TEST_RUNTIME: runtime };
if (values["solver-profile"] && runtime !== "native") throw new Error("Internal solver profiling currently requires the native runtime");
if (values["solver-profile"]) env.PAMATCAD_SKETCH_PROFILE = "1";
else delete env.PAMATCAD_SKETCH_PROFILE;
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
