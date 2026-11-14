import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TestContext } from "node:test";
import { CoreError, type Scene } from "@pamatcad/sdk";

export async function captureReportScene(t: TestContext, scene: Scene, directory: string): Promise<void> {
  const id = basename(t.filePath ?? "test", ".js").replace(/[^a-zA-Z0-9_-]/g, "_") + "-" + randomUUID();
  const artifacts: { id: string; name: string; jpeg?: boolean; step?: boolean; note?: string } = { id, name: t.name };
  const errors: string[] = [];
  for (const kind of ["jpeg", "step"] as const) {
    try {
      const file = kind === "jpeg" ? await scene.capture({ format: "jpeg", showAxes: true }) : await scene.export({ format: "step" });
      await writeFile(join(directory, "assets", id + (kind === "jpeg" ? ".jpg" : ".step")), file.bytes);
      artifacts[kind] = true;
    } catch (error) {
      if (error instanceof CoreError && error.details?.code === "INVALID_STATE") {
        artifacts.note = error.message;
        break;
      }
      errors.push(`${kind}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (errors.length) artifacts.note = errors.join("\n");
  t.diagnostic("pamatcad-report " + JSON.stringify(artifacts));
  if (errors.length) throw new Error("Scene artifact generation failed: " + artifacts.note);
}
