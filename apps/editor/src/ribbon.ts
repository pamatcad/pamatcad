import type { ConstraintKind } from "@pamatcad/sdk";
import type { SketchTool } from "./tools/sketch";
import type { SketchToolName } from "./tools/sketch-geometry";

export type Workbench = "solid" | "sketch";
const icons = import.meta.glob<string>("./icons/sketch-*.svg", { query: "?raw", import: "default", eager: true });
const geometry: SketchToolName[] = ["point", "line", "rectangle", "circle", "arc", "ellipse", "slot", "spline", "text"];
const constraints: ConstraintKind[] = ["equal", "coincident", "fix", "concentric", "midpoint", "parallel", "perpendicular", "tangent", "horizontal", "vertical", "symmetric", "collinear", "pointOnCurve"];
const editing: SketchToolName[] = ["dimension", "project", "offset", "split", "rounding", "scale", "move", "remove"];
const title = (name: string) => name.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());

export function initRibbon(root: HTMLElement, changeWorkbench: (value: Workbench) => void, currentSketch: () => SketchTool | undefined) {
  const selector = root.querySelector<HTMLSelectElement>("#workbench")!;
  const solid = root.querySelector<HTMLElement>("#solid-ribbon")!;
  const sketch = root.querySelector<HTMLElement>("#sketch-ribbon")!;
  const buttons: HTMLButtonElement[] = [];
  selector.onchange = () => changeWorkbench(selector.value as Workbench);

  for (const [label, names] of [["Geometry", geometry], ["Constraints", constraints], ["Tools", editing]] as const) {
    const group = document.createElement("div");
    group.className = "tool-group";
    const tools = document.createElement("div");
    tools.className = "tools sketch-ribbon-tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", label);
    for (const name of names) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.tooltip = title(name);
      button.setAttribute("aria-label", button.dataset.tooltip);
      const iconName = label === "Constraints" ? "constraint-" + name.replace(/[A-Z]/g, c => "-" + c.toLowerCase()) : name;
      button.innerHTML = icons[`./icons/sketch-${iconName}.svg`];
      button.querySelector("svg")!.setAttribute("aria-hidden", "true");
      if (label === "Constraints") {
        button.dataset.constraint = name;
        button.onclick = () => { currentSketch()?.chooseConstraint(name as ConstraintKind); };
      } else {
        button.dataset.tool = name;
        button.onclick = () => {
          const tool = currentSketch();
          tool?.choose(tool.tool === name ? "select" : name as SketchToolName);
        };
      }
      tools.append(button);
      buttons.push(button);
    }
    const caption = document.createElement("span");
    caption.textContent = label;
    group.append(tools, caption);
    sketch.append(group);
  }

  return {
    render(workbench: Workbench, tool: SketchTool | undefined, busy: boolean, hasDocument: boolean) {
      selector.value = workbench;
      selector.disabled = busy || !hasDocument;
      solid.hidden = workbench !== "solid";
      sketch.hidden = workbench !== "sketch";
      root.setAttribute("aria-label", title(workbench) + " workbench");
      for (const button of buttons) {
        button.disabled = busy || !tool?.sketch || tool.pickingSupport;
        if (button.dataset.constraint) {
          const kind = button.dataset.constraint as ConstraintKind;
          button.disabled ||= tool?.constraint !== kind && tool?.constraintState(kind) === "invalid";
          button.setAttribute("aria-pressed", String(tool?.constraint === kind));
        }
        if (button.dataset.tool) button.setAttribute("aria-pressed", String(tool?.tool === button.dataset.tool));
      }
    },
  };
}
