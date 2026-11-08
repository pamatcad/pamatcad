import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { TestContext } from "node:test";
import { Core } from "@pamatcad/sdk";

export async function startCore(t: TestContext): Promise<{ core: Core }> {
  const executable = resolve("target/debug", process.platform === "win32" ? "pamatcad.exe" : "pamatcad");
  const child = spawn(executable, ["serve", "--transport", "ws", "--listen", "127.0.0.1:0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => { diagnostics = (diagnostics + text).slice(-16_384); });
  const lines = createInterface({ input: child.stdout });
  let core: Core | undefined;

  t.after(async () => {
    core?.close();
    lines.close();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
      child.once("exit", () => { clearTimeout(force); resolve(); });
      child.kill("SIGTERM");
    });
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Core readiness timed out\n${diagnostics}`)), 10_000);
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer);
      lines.removeListener("line", onLine);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve(url!);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) => finish(new Error(`Core exited before readiness (${code})\n${diagnostics}`));
    const onLine = (line: string) => {
      try {
        const message = JSON.parse(line) as { event?: string; url?: string };
        if (message.event === "ready" && typeof message.url === "string") finish(undefined, message.url);
      } catch {
        finish(new Error(`Invalid core readiness output: ${line}`));
      }
    };
    lines.on("line", onLine);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  core = await Core.connect(url);
  return { core };
}

