import { describe, it, expect } from "vitest";
import {
  splitCompoundCommand,
  unwrapCommand,
  expandSubCommands,
} from "./commandSplitter.js";

describe("splitCompoundCommand", () => {
  it("splits on &&", () => {
    expect(splitCompoundCommand("cd /foo && ls")).toEqual(["cd /foo", "ls"]);
  });

  it("splits on ||", () => {
    expect(splitCompoundCommand("test -f x || echo missing")).toEqual([
      "test -f x",
      "echo missing",
    ]);
  });

  it("splits on ;", () => {
    expect(splitCompoundCommand("echo a; echo b")).toEqual([
      "echo a",
      "echo b",
    ]);
  });

  it("splits on | (pipe)", () => {
    expect(splitCompoundCommand("ls | grep foo")).toEqual(["ls", "grep foo"]);
  });

  it("handles mixed operators", () => {
    expect(splitCompoundCommand("a && b | c; d || e")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("preserves quoted strings containing operators", () => {
    expect(splitCompoundCommand('echo "a && b"')).toEqual(['echo "a && b"']);
  });

  it("preserves single-quoted strings containing operators", () => {
    expect(splitCompoundCommand("echo 'a || b'")).toEqual(["echo 'a || b'"]);
  });

  it("handles backslash escapes", () => {
    expect(splitCompoundCommand("echo a\\;b")).toEqual(["echo a\\;b"]);
  });

  it("handles empty input", () => {
    expect(splitCompoundCommand("")).toEqual([]);
  });

  it("handles whitespace-only input", () => {
    expect(splitCompoundCommand("   ")).toEqual([]);
  });

  it("trims parts", () => {
    expect(splitCompoundCommand("  a  &&  b  ")).toEqual(["a", "b"]);
  });

  it("handles triple && (split between first two &, rest stays)", () => {
    // &&& → && + & (ampersand). First && splits, then & stays in next part
    const result = splitCompoundCommand("a &&& b");
    expect(result).toEqual(["a", "& b"]);
  });

  it("splits on newlines", () => {
    expect(splitCompoundCommand("echo a\necho b")).toEqual([
      "echo a",
      "echo b",
    ]);
  });

  it("strips # comments (whole line)", () => {
    expect(splitCompoundCommand("# this is a comment\ngh api foo")).toEqual([
      "gh api foo",
    ]);
  });

  it("strips # comments (inline after command)", () => {
    expect(splitCompoundCommand("echo hello # greeting\nls")).toEqual([
      "echo hello",
      "ls",
    ]);
  });

  it("preserves # inside double quotes", () => {
    expect(splitCompoundCommand('echo "# not a comment"')).toEqual([
      'echo "# not a comment"',
    ]);
  });

  it("preserves # inside single quotes", () => {
    expect(splitCompoundCommand("echo '# not a comment'")).toEqual([
      "echo '# not a comment'",
    ]);
  });

  it("handles comment-only input", () => {
    expect(splitCompoundCommand("# just a comment")).toEqual([]);
  });

  it("handles comment before compound command", () => {
    expect(splitCompoundCommand("# Check logs\ngh api foo 2>&1")).toEqual([
      "gh api foo 2>&1",
    ]);
  });
});

describe("unwrapCommand", () => {
  it("unwraps sudo", () => {
    expect(unwrapCommand("sudo npm install")).toBe("npm install");
  });

  it("unwraps sudo with flags", () => {
    expect(unwrapCommand("sudo -u root npm install")).toBe("npm install");
  });

  it("unwraps env with VAR=val pairs", () => {
    expect(unwrapCommand("env FOO=bar BAZ=qux npm start")).toBe("npm start");
  });

  it("unwraps env with flags", () => {
    expect(unwrapCommand("env -u HOME npm start")).toBe("npm start");
  });

  it("unwraps nested: sudo env", () => {
    expect(unwrapCommand("sudo env FOO=bar npm test")).toBe("npm test");
  });

  it("unwraps xargs", () => {
    expect(unwrapCommand("xargs rm -rf")).toBe("rm -rf");
  });

  it("unwraps xargs with flags", () => {
    expect(unwrapCommand("xargs -I {} rm {}")).toBe("rm {}");
  });

  it("unwraps timeout with duration", () => {
    expect(unwrapCommand("timeout 30 npm test")).toBe("npm test");
  });

  it("unwraps nohup", () => {
    expect(unwrapCommand("nohup node server.js")).toBe("node server.js");
  });

  it("unwraps nice with adjustment", () => {
    expect(unwrapCommand("nice -n 10 make -j4")).toBe("make -j4");
  });

  it("returns null for non-wrapper commands", () => {
    expect(unwrapCommand("npm install")).toBeNull();
  });

  it("returns null for wrapper with no inner command", () => {
    expect(unwrapCommand("sudo -u root")).toBeNull();
  });

  it("returns null for single word", () => {
    expect(unwrapCommand("sudo")).toBeNull();
  });
});

describe("expandSubCommands", () => {
  it("expands wrapper into wrapper name + inner command", () => {
    expect(expandSubCommands(["sudo npm install"])).toEqual([
      "sudo",
      "npm install",
    ]);
  });

  it("passes through non-wrapper commands unchanged", () => {
    expect(expandSubCommands(["npm install"])).toEqual(["npm install"]);
  });

  it("handles mixed wrapper and non-wrapper", () => {
    expect(expandSubCommands(["cd /foo", "sudo rm -rf /tmp"])).toEqual([
      "cd /foo",
      "sudo",
      "rm -rf /tmp",
    ]);
  });

  it("expands multiple wrappers independently", () => {
    expect(
      expandSubCommands(["sudo npm install", "env FOO=bar node app.js"]),
    ).toEqual(["sudo", "npm install", "env", "node app.js"]);
  });
});
