export interface ThemeDefinition {
  readonly colors: {
    readonly foreground: string;
    readonly foregroundMuted: string;
    readonly background: string;
    readonly panelBackground: string;
    readonly fieldBackground: string;
    readonly border: string;
    readonly fieldBorder: string;
    readonly hoverBackground: string;
    readonly activeBackground: string;
    readonly selectionBackground: string;
    readonly selectionForeground: string;
    readonly accent: string;
    readonly accentHover: string;
    readonly accentPressed: string;
    readonly accentBorder: string;
    readonly onAccent: string;
    readonly inverseBackground: string;
    readonly inverseForeground: string;
    readonly inverseHover: string;
    readonly success: string;
    readonly error: string;
    readonly shadow: string;
    readonly surface: string;
    readonly sketch: string;
    readonly sketchEdge: string;
    readonly sketchHighlight: string;
    readonly selection: string;
    readonly preview: string;
    readonly previewEdge: string;
    readonly edge: string;
    readonly highlight: string;
    readonly handle: string;
    readonly handleEdge: string;
    readonly construction: string;
    readonly constructionEdge: string;
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
    readonly construction: number;
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
    foreground: "#39434b",
    foregroundMuted: "#65727b",
    background: "#ffffff",
    panelBackground: "#ffffff",
    fieldBackground: "#ffffff",
    border: "#d9dee2",
    fieldBorder: "#87939c",
    hoverBackground: "#f2f5f7",
    activeBackground: "#e7f1f8",
    selectionBackground: "#e7f0eb",
    selectionForeground: "#315c48",
    accent: "#c5ddf0",
    accentHover: "#b6d3e9",
    accentPressed: "#a4c7e1",
    accentBorder: "#6588a3",
    onAccent: "#294f6d",
    inverseBackground: "#ffffff",
    inverseForeground: "#39434b",
    inverseHover: "#f2f5f7",
    success: "#496d55",
    error: "#964650",
    shadow: "#39434b",
    surface: "#ced3d5",
    sketch: "#c5ddf0",
    sketchEdge: "#6588a3",
    sketchHighlight: "#294f6d",
    selection: "#c0d8cc",
    preview: "#aebec3",
    previewEdge: "#536974",
    edge: "#65727b",
    highlight: "#487561",
    handle: "#dcb58c",
    handleEdge: "#815a36",
    construction: "#edf1f3",
    constructionEdge: "#81909b",
    grid: "#e5eaed",
    gridMajor: "#bac5cd",
    axisX: "#a4555d",
    axisY: "#557b62",
    axisZ: "#6588a3",
    light: "#ffffff",
    groundLight: "#bfc5c9",
  },
  opacity: {
    disabled: 0.43,
    occluded: 0.35,
    fill: 0.32,
    construction: 0.15,
    selectedFill: 0.55,
    preview: 1,
    shadow: 0.10,
    backdrop: 0.33,
  },
  typography: {
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    monoFontFamily: "ui-monospace, monospace",
  },
};

export function themeVariables(theme: ThemeDefinition): [string, string][] {
  return Object.entries(theme).flatMap(([group, tokens]) =>
    Object.entries(tokens).map(([name, value]): [string, string] => {
      const key = name.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
      return ["--" + key + (group === "opacity" ? "-opacity" : ""), String(value)];
    }),
  );
}

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
    for (const [name, value] of themeVariables(this.current)) {
      doc.documentElement.style.setProperty(name, value);
    }
  }
}

export const editorTheme = new EditorTheme();
