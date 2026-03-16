/**
 * Minimal vscode mock for unit-testing pure logic that happens to live
 * in files that `import * as vscode from "vscode"`.
 *
 * Only stub what's needed so the module can be imported — individual tests
 * should mock further if they need to interact with VS Code APIs.
 */

export const workspace = {
  workspaceFolders: undefined as unknown as unknown[],
  getConfiguration: () => ({
    get: (_key: string, defaultValue: unknown) => defaultValue,
  }),
  openTextDocument: async () => ({}),
  createFileSystemWatcher: () => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  applyEdit: async () => true,
  textDocuments: [],
};

export const window = {
  showTextDocument: async () => ({}),
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  createOutputChannel: () => ({
    appendLine: () => {},
    info: () => {},
    show: () => {},
    dispose: () => {},
  }),
  createQuickPick: () => ({
    items: [],
    onDidAccept: () => ({ dispose: () => {} }),
    onDidHide: () => ({ dispose: () => {} }),
    show: () => {},
    dispose: () => {},
  }),
  showQuickPick: async () => undefined,
  createTerminal: ({ name, cwd }: { name?: string; cwd?: string } = {}) => ({
    name: name ?? "Terminal",
    shellIntegration: cwd ? { cwd: { fsPath: cwd } } : undefined,
    show: () => {},
    sendText: () => {},
    dispose: () => {},
  }),
  onDidCloseTerminal: () => ({ dispose: () => {} }),
  onDidChangeTerminalShellIntegration: () => ({ dispose: () => {} }),
  onDidStartTerminalShellExecution: () => ({ dispose: () => {} }),
  onDidEndTerminalShellExecution: () => ({ dispose: () => {} }),
  onDidOpenTerminal: () => ({ dispose: () => {} }),
  tabGroups: { all: [] },
};

export const languages = {
  getDiagnostics: () => [],
  onDidChangeDiagnostics: () => ({ dispose: () => {} }),
};

export const commands = {
  executeCommand: async () => undefined,
  registerCommand: () => ({ dispose: () => {} }),
};

export const extensions = {
  getExtension: () => undefined,
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: "file", path }),
  parse: (uri: string) => ({ fsPath: uri, scheme: "file", path: uri }),
};

export const ThemeIcon = class {
  constructor(public id: string) {}
};

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
};

export const EventEmitter = class {
  event = () => {};
  fire() {}
  dispose() {}
};

export const SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
};

export const CompletionItemKind = {
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Unit: 10,
  Value: 11,
  Enum: 12,
  Keyword: 13,
  Snippet: 14,
  Color: 15,
  File: 16,
  Reference: 17,
  Folder: 18,
  EnumMember: 19,
  Constant: 20,
  Struct: 21,
  Event: 22,
  Operator: 23,
  TypeParameter: 24,
};

export const Location = class {
  constructor(
    public uri: unknown,
    public range: unknown,
  ) {}
};

export const Position = class {
  constructor(
    public line: number,
    public character: number,
  ) {}
};

export const Range = class {
  constructor(
    public start: unknown,
    public end: unknown,
  ) {}
};

export const InlayHintKind = {
  Type: 1,
  Parameter: 2,
};

export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
};

export const CodeActionTriggerKind = {
  Invoke: 1,
  Automatic: 2,
};

export const CodeActionKind = {
  Empty: {
    append: (value: string) => ({ value }),
    value: "",
  },
  QuickFix: { value: "quickfix" },
  Refactor: { value: "refactor" },
  Source: { value: "source" },
};

export const WorkspaceEdit = class {
  _edits: unknown[] = [];
  replace() {}
  insert() {}
  delete() {}
  has() {
    return false;
  }
  set() {}
  get size() {
    return 0;
  }
  entries() {
    return [];
  }
};

export const TabInputTextDiff = class {};
