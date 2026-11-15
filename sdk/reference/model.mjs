import { resolve, relative, sep } from "node:path";
import ts from "typescript";

export const escape = value => String(value).replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

// Rust enums become either string literals or objects with a literal discriminator.
export function variantKeys(declaration) {
  const type = declaration?.type;
  if (!type) throw new Error("Documented variants require a protocol type");
  return (ts.isUnionTypeNode(type) ? type.types : [type]).map(branch => {
    const tag = ts.isTypeLiteralNode(branch) && branch.members.find(m => ["type", "role"].includes(m.name?.text));
    const value = tag ? tag.type : branch;
    if (!ts.isLiteralTypeNode(value) || !ts.isStringLiteral(value.literal)) {
      throw new Error(declaration.name.text + ": expected a string or tagged union for documented variants");
    }
    return value.literal.text;
  });
}

// Use the emitted SDK declarations so inferred class members and overloads are available.
export function readModel(directory) {
  const index = resolve(directory, "index.d.ts");
  const program = ts.createProgram([index], {
    module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true, types: [],
  });
  const checker = program.getTypeChecker();
  const symbolOf = node => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const pages = [];
  const bySymbol = new Map();
  const byId = new Map();
  function add(kind, name, key = name) {
    const id = kind + "/" + key;
    if (byId.has(id)) throw new Error("Duplicate reference entry: " + id);
    const page = { kind, name, id, label: name, file: kind + "-" + encodeURIComponent(key) + ".html", fields: [], uses: new Set() };
    byId.set(id, page);
    pages.push(page);
    return page;
  }
  const publicSymbols = new Set(checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(index)))
    .map(s => s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s));
  const wire = program.getSourceFile(resolve(directory, "generated/protocol.d.ts"));
  const declarations = program.getSourceFiles()
    .filter(f => resolve(f.fileName).startsWith(directory + sep))
    .flatMap(f => f.statements.filter(d => ts.isTypeAliasDeclaration(d) || ts.isInterfaceDeclaration(d)
        || ts.isClassDeclaration(d) || ts.isFunctionDeclaration(d)));
  // Reserve public SDK names ahead of wire types that share a name.
  declarations.sort((a, b) => Number(publicSymbols.has(symbolOf(b.name))) - Number(publicSymbols.has(symbolOf(a.name))));
  for (const node of declarations) {
    const name = node.name.text;
    const kind = ts.isClassDeclaration(node) ? "class" : ts.isFunctionDeclaration(node) ? "function" : "type";
    const key = byId.has(kind + "/" + name) ? relative(directory, node.getSourceFile().fileName).replace(/\.d\.ts$/, "").split(sep).join(".") + "." + name : name;
    const page = add(kind, name, key);
    if (key !== name) page.label = name + (node.getSourceFile() === wire ? " (protocol)" : " (SDK)");
    page.node = node;
    page.support = !publicSymbols.has(symbolOf(node.name)) && node.getSourceFile() !== wire;
    bySymbol.set(symbolOf(node.name), page);
  }
  const commandTypes = name => {
    const variants = wire.statements.find(n => n.name?.text === name).type;
    return (ts.isUnionTypeNode(variants) ? variants.types : [variants]).map(node => {
      const members = Object.fromEntries(node.members.map(m => [m.name.text, m.type]));
      return [members.method.literal.text, members.params ?? members.value];
    });
  };
  const results = new Map(commandTypes("Response"));
  for (const [name, input] of commandTypes("Request")) {
    const page = add("command", name);
    page.input = input;
    page.output = results.get(name);
    if (!page.output) throw new Error("Missing result for " + name);
  }

  function link(page, to, label = to.name) {
    if (page !== to) to.uses.add(page);
    return '<a href="' + to.file + '">' + escape(label) + '</a>';
  }
  // Keep the original declaration spelling. Link identifiers by their resolved symbol,
  // including import aliases. Substitutions carry the caller's generic scope.
  function syntax(page, node, bindings = new Map()) {
    if (ts.isIdentifier(node)) {
      const symbol = symbolOf(node);
      const bound = bindings.get(symbol);
      if (bound) return syntax(page, bound.node, bound.bindings);
      const target = bySymbol.get(symbol);
      return target && target !== page ? link(page, target, node.text) : escape(node.text);
    }
    const file = node.getSourceFile();
    let position = node.getStart(file);
    let html = "";
    if (ts.isImportTypeNode(node) && node.qualifier) position = node.qualifier.getStart(file);
    node.forEachChild(child => {
      if (child.getStart(file) < position) return;
      html += escape(file.text.slice(position, child.getStart(file))) + syntax(page, child, bindings);
      position = child.end;
    });
    return html + escape(file.text.slice(position, node.end));
  }

  function parameterTree(page) {
    const ids = new Set();
    function row(label, node, path, bindings, seen, optional = false) {
      const key = path.join(".");
      let anchor = "param-" + key.replace(/[^\w.-]+/g, "-");
      while (ids.has(anchor)) anchor += "-";
      ids.add(anchor);
      page.fields.push({ path: key, anchor });
      return '<li id="' + anchor + '"><div class="field"><a class="field-name" href="#' + anchor + '">' +
        escape(label) + (optional ? "?" : "") + '</a><code>' + syntax(page, node, bindings) + '</code></div>' +
        children(node, path, bindings, seen) + '</li>';
    }
    function children(node, path, bindings, seen) {
      if (ts.isTypeReferenceNode(node)) {
        const symbol = symbolOf(node.typeName);
        const bound = bindings.get(symbol);
        if (bound) return children(bound.node, path, bound.bindings, seen);
        if (node.typeName.getText() === "Array" || node.typeName.getText() === "ReadonlyArray") {
          return children(node.typeArguments[0], [...path, "[]"], bindings, seen);
        }
        const declaration = bySymbol.get(symbol)?.node;
        // The type name above remains a link when a recursive branch reaches itself.
        if (!declaration || seen.has(declaration)) return "";
        const next = new Map(bindings);
        declaration.typeParameters?.forEach((p, i) => {
          const argument = node.typeArguments?.[i] ?? p.default;
          if (argument) next.set(symbolOf(p.name), { node: argument, bindings });
        });
        const body = declaration.type ?? declaration;
        if (ts.isLiteralTypeNode(body)) return '<div class="values"><code>' + syntax(page, body) + '</code></div>';
        return children(body, path, next, new Set([...seen, declaration]));
      }
      if (ts.isParenthesizedTypeNode(node)) return children(node.type, path, bindings, seen);
      if (ts.isArrayTypeNode(node)) return children(node.elementType, [...path, "[]"], bindings, seen);
      if (ts.isTupleTypeNode(node)) {
        return '<ul>' + node.elements.map((item, i) =>
          row("[" + i + "]", item, [...path, String(i)], bindings, seen)).join("") + '</ul>';
      }
      if (ts.isTypeLiteralNode(node) || ts.isInterfaceDeclaration(node)) {
        const members = node.members.filter(m => ts.isPropertySignature(m));
        return members.length ? '<ul>' + members.map(m =>
          row(m.name.text, m.type, [...path, m.name.text], bindings, seen, !!m.questionToken)).join("") + '</ul>' : "";
      }
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
        if (node.types.every(ts.isLiteralTypeNode)) return '<div class="values">' +
          node.types.map(t => '<code>' + escape(t.literal.getText()) + '</code>').join("") + '</div>';
        const branches = node.types.map(branch => {
          const tag = ts.isTypeLiteralNode(branch) && branch.members.find(m =>
            ts.isPropertySignature(m) && ["type", "role"].includes(m.name.text) && ts.isLiteralTypeNode(m.type));
          const name = tag ? tag.type.literal.text : branch.getText();
          return '<li class="variant"><code>' + (tag ? escape(name) : syntax(page, branch, bindings)) +
            '</code>' + children(branch, [...path, name], bindings, seen) + '</li>';
        });
        return '<ul>' + branches.join("") + '</ul>';
      }
      return "";
    }
    return '<div class="tree">' + children(page.input, [], new Map(), new Set()) + '</div>';
  }

  // Most wrapper paths follow the RPC name. These commands deliberately expose a
  // different JS owner or a query builder. Resolve and verify each path against the SDK.
  const wrappers = {
    "sketch.create": "Scene.sketches.create", "body.get": "Scene.bodies.get",
    "face.properties": "Body.faces.properties", "body.faces.only": "Body.faces.query().only",
    "solid.extrude.faces.all": "ExtrudeFeature.faces.endCap1().all",
    "solid.extrude.faces.only": "ExtrudeFeature.faces.endCap1().only",
  };
  function binding(page) {
    const parts = page.name.split(".");
    const owner = parts[0][0].toUpperCase() + parts[0].slice(1);
    const paths = wrappers[page.name] ? [wrappers[page.name]] :
      ["Core." + page.name, [owner, ...parts.slice(1)].join(".")];
    for (const path of paths) {
      const [root, ...segments] = path.split(".");
      const origin = byId.get("class/" + root) ?? byId.get("type/" + root);
      if (!origin) continue;
      const receiver = root === "ExtrudeFeature" ? "feature" : root[0].toLowerCase() + root.slice(1);
      let candidates = [{ type: checker.getDeclaredTypeOfSymbol(symbolOf(origin.node.name)), name: escape(receiver) }];
      for (const segment of segments) {
        const call = segment.endsWith("()");
        const member = segment.replace(/\(\)$/, "");
        candidates = candidates.flatMap(c => {
          const property = c.type.getProperty(member);
          if (!property) return [];
          const type = checker.getTypeOfSymbolAtLocation(property, origin.node);
          const name = c.name + "." + escape(member);
          if (!call) return [{ type, name }];
          return type.getCallSignatures().map(sig => ({
            name: name + "(" + sig.declaration.parameters.map(p => syntax(page, p)).join(", ") + ")",
            type: checker.getNonNullableType(sig.getReturnType()),
          }));
        });
      }
      const signatures = candidates.flatMap(({ type, name }) => type.getCallSignatures().map(sig => {
        const d = sig.declaration;
        const generic = d.typeParameters?.length ? '&lt;' + d.typeParameters.map(p => syntax(page, p)).join(", ") + '&gt;' : "";
        return name + generic + '(' + d.parameters.map(p => syntax(page, p)).join(", ") + ') → ' + syntax(page, d.type);
      }));
      if (signatures.length) {
        origin.uses.add(page);
        return signatures.map(s => s.replace(escape(receiver) + ".", link(page, origin, receiver) + "."));
      }
    }
    // Any newly registered RPC is callable through the public Transport interface.
    return ['transport.request("' + escape(page.name) + '", params) → Promise&lt;' + syntax(page, page.output) + '&gt;'];
  }
  function declaration(page) {
    const d = page.node;
    if (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d)) {
      const members = d.members.filter(m => !m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword ||
        mod.kind === ts.SyntaxKind.ProtectedKeyword) && !(m.name && ts.isPrivateIdentifier(m.name)));
      return members.map(m => '<pre><code>' + syntax(page, m) + '</code></pre>').join("");
    }
    return '<pre><code>' + syntax(page, d).replace(/^export (declare )?/, "") + '</code></pre>';
  }
  return { pages, byId, add, parameterTree, syntax, binding, declaration };
}
