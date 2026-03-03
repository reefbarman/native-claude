/**
 * Tree-sitter S-expression query strings for each supported grammar.
 *
 * These queries find definition nodes at ANY depth in the AST via
 * `query.captures(tree.rootNode)`. Each capture uses `@definition.*`
 * naming — our code filters to these to discover chunk-worthy nodes.
 *
 * Languages without a query here fall back to the EXTRACTABLE_TYPES
 * top-level walk in treeSitterChunker.ts.
 *
 * IMPORTANT: This file MUST NOT import "vscode".
 */

/**
 * Grammar name → S-expression query string.
 * Only languages that benefit from deep capture are included.
 */
export const LANGUAGE_QUERIES: Record<string, string> = {
  // ── TypeScript ──────────────────────────────────────────────────────
  typescript: `
; Functions (at any depth)
(function_declaration) @definition.function

; Classes (at any depth)
(class_declaration) @definition.class
(abstract_class_declaration) @definition.class

; Methods (at any depth — key win: finds methods inside classes, object literals, etc.)
(method_definition) @definition.method

; Interfaces
(interface_declaration) @definition.interface

; Type aliases
(type_alias_declaration) @definition.type

; Enums
(enum_declaration) @definition.enum

; Export statements wrapping declarations
(export_statement) @definition.export

; Arrow functions / function expressions assigned to named variables
(lexical_declaration
  (variable_declarator
    name: (identifier)
    value: [(arrow_function) (function_expression)])) @definition.function
`,

  // ── TSX (same grammar as TypeScript) ────────────────────────────────
  tsx: `
(function_declaration) @definition.function
(class_declaration) @definition.class
(abstract_class_declaration) @definition.class
(method_definition) @definition.method
(interface_declaration) @definition.interface
(type_alias_declaration) @definition.type
(enum_declaration) @definition.enum
(export_statement) @definition.export
(lexical_declaration
  (variable_declarator
    name: (identifier)
    value: [(arrow_function) (function_expression)])) @definition.function
`,

  // ── JavaScript ──────────────────────────────────────────────────────
  javascript: `
; Functions
(function_declaration) @definition.function
(generator_function_declaration) @definition.function

; Classes
(class_declaration) @definition.class

; Methods (at any depth)
(method_definition) @definition.method

; Export statements
(export_statement) @definition.export

; Arrow/function expressions assigned to variables
(lexical_declaration
  (variable_declarator
    name: (identifier)
    value: [(arrow_function) (function_expression)])) @definition.function

(variable_declaration
  (variable_declarator
    name: (identifier)
    value: [(arrow_function) (function_expression)])) @definition.function
`,

  // ── Python ──────────────────────────────────────────────────────────
  python: `
; Functions (at any depth — captures nested functions, methods, etc.)
(function_definition) @definition.function

; Classes (at any depth)
(class_definition) @definition.class

; Decorated definitions
(decorated_definition) @definition.decorated
`,

  // ── Go ──────────────────────────────────────────────────────────────
  go: `
; Functions
(function_declaration) @definition.function

; Methods
(method_declaration) @definition.method

; Type declarations (interfaces, structs, type aliases)
(type_declaration) @definition.type

; Variable declarations
(var_declaration) @definition.variable

; Constant declarations
(const_declaration) @definition.constant
`,

  // ── Rust ─────────────────────────────────────────────────────────────
  rust: `
; Functions (at any depth — captures impl methods too)
(function_item) @definition.function

; Structs
(struct_item) @definition.struct

; Enums
(enum_item) @definition.enum

; Traits
(trait_item) @definition.trait

; Impl blocks
(impl_item) @definition.impl

; Modules
(mod_item) @definition.module

; Macros
(macro_definition) @definition.macro

; Type aliases
(type_item) @definition.type

; Constants and statics
(const_item) @definition.constant
(static_item) @definition.static
`,

  // ── Java ─────────────────────────────────────────────────────────────
  java: `
; Classes (at any depth — captures inner classes too)
(class_declaration) @definition.class

; Methods (at any depth)
(method_declaration) @definition.method

; Constructors
(constructor_declaration) @definition.constructor

; Interfaces
(interface_declaration) @definition.interface

; Enums
(enum_declaration) @definition.enum

; Fields with initializers
(field_declaration) @definition.field
`,

  // ── C / C++ ──────────────────────────────────────────────────────────
  cpp: `
; Functions (at any depth — captures methods inside classes)
(function_definition) @definition.function

; Classes
(class_specifier) @definition.class

; Structs
(struct_specifier) @definition.struct

; Enums
(enum_specifier) @definition.enum

; Namespaces
(namespace_definition) @definition.namespace

; Templates wrapping declarations
(template_declaration) @definition.template
`,

  // ── C# ───────────────────────────────────────────────────────────────
  c_sharp: `
; Classes (at any depth)
(class_declaration) @definition.class

; Methods (at any depth)
(method_declaration) @definition.method

; Constructors
(constructor_declaration) @definition.constructor

; Interfaces
(interface_declaration) @definition.interface

; Structs
(struct_declaration) @definition.struct

; Enums
(enum_declaration) @definition.enum

; Namespaces
(namespace_declaration) @definition.namespace

; Properties
(property_declaration) @definition.property
`,

  // ── Ruby ─────────────────────────────────────────────────────────────
  ruby: `
; Methods (at any depth)
(method) @definition.method

; Singleton methods (self.foo)
(singleton_method) @definition.method

; Classes
(class) @definition.class

; Modules
(module) @definition.module
`,

  // ── PHP ──────────────────────────────────────────────────────────────
  php: `
; Functions
(function_definition) @definition.function

; Classes
(class_declaration) @definition.class

; Methods (at any depth)
(method_declaration) @definition.method

; Interfaces
(interface_declaration) @definition.interface

; Traits
(trait_declaration) @definition.trait
`,

  // ── Bash ─────────────────────────────────────────────────────────────
  bash: `
; Functions
(function_definition) @definition.function
`,
};
