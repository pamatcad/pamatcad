export interface ThemeDefinition {
  readonly colors: {
    readonly foreground: string;
    readonly foregroundMuted: string;
    readonly background: string;
    readonly panelBackground: string;
    readonly fieldBackground: string;
    readonly border: string;
    readonly hoverBackground: string;
    readonly activeBackground: string;
    readonly selectionBackground: string;
    readonly selectionForeground: string;
    readonly accent: string;
    readonly accentHover: string;
    readonly onAccent: string;
    readonly inverseBackground: string;
    readonly inverseForeground: string;
    readonly inverseHover: string;
    readonly success: string;
    readonly error: string;
    readonly shadow: string;
    readonly surface: string;
    readonly selection: string;
    readonly preview: string;
    readonly edge: string;
    readonly highlight: string;
    readonly grid: string;
    readonly gridMajor: string;
    readonly axisX: string;
    readonly axisY: string;
    readonly axisZ: string;
    readonly light: string;
    readonly groundLight: string;
  };
  readonly opacity: {
    readonly disabled: number;
    readonly occluded: number;
    readonly fill: number;
    readonly selectedFill: number;
    readonly preview: number;
    readonly shadow: number;
    readonly backdrop: number;
  };
  readonly typography: {
    readonly fontFamily: string;
    readonly monoFontFamily: string;
  };
}

// Semantic roles shared by CSS, canvas labels and WebGL materials.
export const lightTheme: ThemeDefinition = {
  colors: {
    foreground: "#203a43",
    foregroundMuted: "#5e7179",
    background: "#f2f6f7",
    panelBackground: "#fbfcfc",
    fieldBackground: "#ffffff",
    border: "#d4dfe2",
    hoverBackground: "#e5eeee",
    activeBackground: "#cfe2e1",
    selectionBackground: "#e0efee",
    selectionForeground: "#165c56",
    accent: "#24716d",
    accentHover: "#185752",
    onAccent: "#ffffff",
    inverseBackground: "#253e47",
    inverseForeground: "#eef5f6",
    inverseHover: "#405861",
    success: "#90c4bb",
    error: "#a33b20",
    shadow: "#253f46",
    surface: "#9fc5cc",
    selection: "#61b9ad",
    preview: "#9dd4c8",
    edge: "#234b58",
    highlight: "#a64a20",
    grid: "#d5e0e3",
    gridMajor: "#a9bec3",
    axisX: "#a64a20",
    axisY: "#24716d",
    axisZ: "#346d9a",
    light: "#ffffff",
    groundLight: "#b2c3c8",
  },
  opacity: {
    disabled: 0.43,
    occluded: 0.35,
    fill: 0.32,
    selectedFill: 0.55,
    preview: 1,
    shadow: 0.14,
    backdrop: 0.33,
  },
  typography: {
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    monoFontFamily: "ui-monospace, monospace",
  },
};

export class EditorTheme {
  private current: ThemeDefinition;
  private readonly documents = new Set<Document>();
  private readonly listeners = new Set<(definition: ThemeDefinition) => void>();

  constructor(definition: ThemeDefinition = lightTheme) {
    this.current = definition;
  }

  get definition() {
    return this.current;
  }

  set(definition: ThemeDefinition) {
    this.current = definition;
    for (const doc of this.documents) this.writeVariables(doc);
    for (const listener of this.listeners) listener(definition);
  }

  // Returns cleanup for documents such as the detachable console window.
  apply(doc: Document) {
    this.documents.add(doc);
    this.writeVariables(doc);
    return () => { this.documents.delete(doc); };
  }

  subscribe(listener: (definition: ThemeDefinition) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private writeVariables(doc: Document) {
    for (const [group, tokens] of Object.entries(this.current)) {
      for (const [name, value] of Object.entries(tokens)) {
        const key = name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
        doc.documentElement.style.setProperty("--" + key + (group === "opacity" ? "-opacity" : ""), String(value));
      }
    }
  }
}

export const editorTheme = new EditorTheme();
