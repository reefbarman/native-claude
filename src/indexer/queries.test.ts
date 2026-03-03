import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { Parser, Language, Query } from "web-tree-sitter";
import { LANGUAGE_QUERIES } from "./queries.js";
import {
  mkdtempSync,
  symlinkSync,
  readdirSync,
  existsSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";

const CORE_WASM = path.resolve("node_modules/web-tree-sitter");
const GRAMMAR_DIR = path.resolve("node_modules/@vscode/tree-sitter-wasm/wasm");

// Grammar name → WASM filename mapping (matches treeSitterChunker's LANG_MAP)
const GRAMMAR_TO_WASM: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
  cpp: "tree-sitter-cpp.wasm",
  c_sharp: "tree-sitter-c-sharp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  bash: "tree-sitter-bash.wasm",
};

let wasmDir: string;

beforeAll(async () => {
  wasmDir = mkdtempSync(path.join(tmpdir(), "query-test-"));

  const coreWasm = path.join(CORE_WASM, "web-tree-sitter.wasm");
  if (existsSync(coreWasm)) {
    symlinkSync(coreWasm, path.join(wasmDir, "web-tree-sitter.wasm"));
  }

  for (const f of readdirSync(GRAMMAR_DIR)) {
    if (f.endsWith(".wasm") && f !== "tree-sitter.wasm") {
      symlinkSync(path.join(GRAMMAR_DIR, f), path.join(wasmDir, f));
    }
  }

  const wasmBinary = readFileSync(path.join(wasmDir, "web-tree-sitter.wasm"));
  await Parser.init({
    wasmBinary,
    locateFile: () => path.join(wasmDir, "web-tree-sitter.wasm"),
  });
});

describe("LANGUAGE_QUERIES", () => {
  for (const [grammarName, querySource] of Object.entries(LANGUAGE_QUERIES)) {
    const wasmFile = GRAMMAR_TO_WASM[grammarName];
    if (!wasmFile) {
      it.skip(`${grammarName} — no WASM mapping`, () => {});
      continue;
    }

    it(`${grammarName} query compiles without errors`, async () => {
      const wasmPath = path.join(wasmDir, wasmFile);
      expect(existsSync(wasmPath)).toBe(true);

      const language = await Language.load(wasmPath);
      expect(language).toBeTruthy();

      // This will throw if the query has syntax errors or references
      // node types that don't exist in the grammar
      const query = new Query(language, querySource);
      expect(query).toBeTruthy();
      expect(query.captureNames.length).toBeGreaterThan(0);
      query.delete();
    });

    it(`${grammarName} query produces captures on sample code`, async () => {
      const wasmPath = path.join(wasmDir, wasmFile);
      const language = await Language.load(wasmPath);
      const parser = new Parser();
      parser.setLanguage(language);

      const sampleCode = SAMPLE_CODE[grammarName];
      if (!sampleCode) return; // skip if no sample

      const tree = parser.parse(sampleCode);
      expect(tree).toBeTruthy();

      const query = new Query(language, querySource);
      const captures = query.captures(tree!.rootNode);
      const definitions = captures.filter((c) =>
        c.name.startsWith("definition"),
      );

      expect(definitions.length).toBeGreaterThan(0);

      query.delete();
      tree!.delete();
      parser.delete();
    }, 15_000);
  }
});

// Minimal sample code per language to validate captures work
const SAMPLE_CODE: Record<string, string> = {
  typescript: `
export class Greeter {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  greet(): string {
    return "Hello, " + this.name;
  }
}

interface Greetable {
  greet(): string;
}

function standalone(x: number): number {
  return x * 2;
}

type Result = { ok: boolean; value: string };

enum Color { Red, Green, Blue }

const handler = (event: Event) => {
  console.log(event);
};
`,

  tsx: `
export function App() {
  return <div>Hello</div>;
}

class Component {
  render() {
    return <span />;
  }
}
`,

  javascript: `
class Animal {
  constructor(name) {
    this.name = name;
  }

  speak() {
    return this.name + " speaks";
  }
}

function createAnimal(name) {
  return new Animal(name);
}

const handler = (event) => {
  console.log(event);
};
`,

  python: `
class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return f"{self.name} speaks"

def create_animal(name):
    return Animal(name)

@decorator
def decorated_func():
    pass
`,

  go: `
package main

func main() {
    fmt.Println("hello")
}

type Greeter struct {
    Name string
}

func (g *Greeter) Greet() string {
    return "Hello, " + g.Name
}

var globalVar = 42

const maxSize = 100
`,

  rust: `
struct Point {
    x: f64,
    y: f64,
}

impl Point {
    fn new(x: f64, y: f64) -> Self {
        Point { x, y }
    }

    fn distance(&self, other: &Point) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2)).sqrt()
    }
}

trait Drawable {
    fn draw(&self);
}

enum Shape {
    Circle(f64),
    Rectangle(f64, f64),
}

fn main() {
    let p = Point::new(1.0, 2.0);
}
`,

  java: `
public class Greeter {
    private String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet() {
        return "Hello, " + name;
    }
}

interface Greetable {
    String greet();
}

enum Color { RED, GREEN, BLUE }
`,

  cpp: `
#include <string>

namespace utils {

class Greeter {
public:
    Greeter(const std::string& name) : name_(name) {}

    std::string greet() const {
        return "Hello, " + name_;
    }

private:
    std::string name_;
};

struct Point {
    double x, y;
};

enum Color { Red, Green, Blue };

template<typename T>
T identity(T val) { return val; }

} // namespace utils
`,

  c_sharp: `
namespace MyApp {
    public class Greeter {
        public string Name { get; set; }

        public Greeter(string name) {
            Name = name;
        }

        public string Greet() {
            return "Hello, " + Name;
        }
    }

    public interface IGreetable {
        string Greet();
    }

    public struct Point {
        public double X;
        public double Y;
    }

    public enum Color { Red, Green, Blue }
}
`,

  ruby: `
module Greeting
  class Greeter
    def initialize(name)
      @name = name
    end

    def greet
      "Hello, \#{@name}"
    end

    def self.default
      new("World")
    end
  end
end

def standalone_method
  puts "hello"
end
`,

  php: `
<?php
namespace App;

interface Greetable {
    public function greet(): string;
}

trait HasName {
    private string $name;
}

class Greeter implements Greetable {
    use HasName;

    public function __construct(string $name) {
        $this->name = $name;
    }

    public function greet(): string {
        return "Hello, " . $this->name;
    }
}

function standalone(): void {
    echo "hello";
}
`,

  bash: `
#!/bin/bash

setup_environment() {
    export PATH="/usr/local/bin:$PATH"
    export NODE_ENV="production"
}

run_server() {
    node server.js &
    echo "Server started"
}

cleanup() {
    kill $!
}
`,
};
