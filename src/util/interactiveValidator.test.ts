import { describe, it, expect } from "vitest";
import { validateInteractiveCommand } from "./interactiveValidator.js";

describe("validateInteractiveCommand", () => {
  // ── Interactive editors ──────────────────────────────────────────

  describe("interactive editors", () => {
    it("rejects vim", () => {
      const result = validateInteractiveCommand("vim file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive editor");
      expect(result!.message).toContain("write_file");
    });

    it("rejects nano", () => {
      const result = validateInteractiveCommand("nano file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive editor");
    });

    it("rejects nvim", () => {
      expect(validateInteractiveCommand("nvim")).not.toBeNull();
    });

    it("rejects emacs", () => {
      expect(validateInteractiveCommand("emacs")).not.toBeNull();
    });

    it("rejects sudo vim", () => {
      const result = validateInteractiveCommand("sudo vim /etc/hosts");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive editor");
    });
  });

  // ── TUI apps ─────────────────────────────────────────────────────

  describe("TUI applications", () => {
    it("rejects top", () => {
      const result = validateInteractiveCommand("top");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive TUI");
    });

    it("rejects htop", () => {
      expect(validateInteractiveCommand("htop")).not.toBeNull();
    });

    it("rejects ncdu", () => {
      expect(validateInteractiveCommand("ncdu /home")).not.toBeNull();
    });

    it("rejects tmux", () => {
      expect(validateInteractiveCommand("tmux")).not.toBeNull();
    });

    it("rejects ranger", () => {
      expect(validateInteractiveCommand("ranger")).not.toBeNull();
    });
  });

  // ── Database CLIs ────────────────────────────────────────────────

  describe("database CLIs", () => {
    it("rejects bare mysql", () => {
      const result = validateInteractiveCommand("mysql -u root mydb");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive session");
    });

    it("allows mysql -e", () => {
      expect(
        validateInteractiveCommand('mysql -u root mydb -e "SELECT 1"'),
      ).toBeNull();
    });

    it("allows mysql --execute", () => {
      expect(
        validateInteractiveCommand('mysql --execute "SHOW TABLES"'),
      ).toBeNull();
    });

    it("rejects bare psql", () => {
      expect(validateInteractiveCommand("psql")).not.toBeNull();
    });

    it("allows psql -c", () => {
      expect(validateInteractiveCommand('psql -c "SELECT 1"')).toBeNull();
    });

    it("allows psql -f", () => {
      expect(validateInteractiveCommand("psql -f script.sql")).toBeNull();
    });

    it("rejects bare mongosh", () => {
      expect(validateInteractiveCommand("mongosh")).not.toBeNull();
    });

    it("allows mongosh --eval", () => {
      expect(
        validateInteractiveCommand('mongosh --eval "db.test.find()"'),
      ).toBeNull();
    });
  });

  // ── REPLs ────────────────────────────────────────────────────────

  describe("REPLs", () => {
    it("rejects bare python", () => {
      const result = validateInteractiveCommand("python");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive REPL");
    });

    it("rejects bare python3", () => {
      expect(validateInteractiveCommand("python3")).not.toBeNull();
    });

    it("allows python script.py", () => {
      expect(validateInteractiveCommand("python script.py")).toBeNull();
    });

    it("allows python -c", () => {
      expect(validateInteractiveCommand('python -c "print(1)"')).toBeNull();
    });

    it("allows python -m", () => {
      expect(validateInteractiveCommand("python -m pytest")).toBeNull();
    });

    it("rejects bare node", () => {
      expect(validateInteractiveCommand("node")).not.toBeNull();
    });

    it("allows node script.js", () => {
      expect(validateInteractiveCommand("node script.js")).toBeNull();
    });

    it("allows node -e", () => {
      expect(validateInteractiveCommand('node -e "console.log(1)"')).toBeNull();
    });

    it("allows node --eval", () => {
      expect(validateInteractiveCommand('node --eval "1+1"')).toBeNull();
    });

    it("rejects bare ruby", () => {
      expect(validateInteractiveCommand("ruby")).not.toBeNull();
    });

    it("allows ruby -e", () => {
      expect(validateInteractiveCommand('ruby -e "puts 1"')).toBeNull();
    });

    it("allows ruby script.rb", () => {
      expect(validateInteractiveCommand("ruby script.rb")).toBeNull();
    });

    it("rejects irb", () => {
      expect(validateInteractiveCommand("irb")).not.toBeNull();
    });
  });

  // ── Git interactive flags ────────────────────────────────────────

  describe("git interactive flags", () => {
    it("rejects git rebase -i", () => {
      const result = validateInteractiveCommand("git rebase -i HEAD~3");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive flags");
    });

    it("rejects git rebase --interactive", () => {
      expect(
        validateInteractiveCommand("git rebase --interactive main"),
      ).not.toBeNull();
    });

    it("rejects git add -i", () => {
      expect(validateInteractiveCommand("git add -i")).not.toBeNull();
    });

    it("rejects git add -p", () => {
      expect(validateInteractiveCommand("git add -p")).not.toBeNull();
    });

    it("rejects git add --patch", () => {
      expect(validateInteractiveCommand("git add --patch")).not.toBeNull();
    });

    it("allows git add specific files", () => {
      expect(validateInteractiveCommand("git add file.ts")).toBeNull();
    });

    it("allows git rebase without -i", () => {
      expect(validateInteractiveCommand("git rebase main")).toBeNull();
    });

    it("rejects git commit without message", () => {
      const result = validateInteractiveCommand("git commit");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("may open an editor");
    });

    it("rejects git commit --amend without --no-edit", () => {
      const result = validateInteractiveCommand("git commit --amend");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("may open an editor");
    });

    it("allows git commit --amend --no-edit", () => {
      expect(
        validateInteractiveCommand("git commit --amend --no-edit"),
      ).toBeNull();
    });

    it("rejects annotated git tag without message", () => {
      const result = validateInteractiveCommand("git tag -a v1.2.3");
      expect(result).not.toBeNull();
      expect(result!.message).toContain('Annotated "git tag"');
    });

    it("rejects git revert without --no-edit", () => {
      const result = validateInteractiveCommand("git revert HEAD~1");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("git revert");
    });

    it("allows git revert --no-edit", () => {
      expect(
        validateInteractiveCommand("git revert --no-edit HEAD~1"),
      ).toBeNull();
    });

    it("rejects git revert -m 1 without --no-edit", () => {
      const result = validateInteractiveCommand("git revert -m 1 HEAD~1");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("git revert");
    });

    it("rejects git cherry-pick without --no-edit", () => {
      const result = validateInteractiveCommand("git cherry-pick abc1234");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("git cherry-pick");
    });

    it("rejects git cherry-pick -m 1 without --no-edit", () => {
      const result = validateInteractiveCommand("git cherry-pick -m 1 abc1234");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("git cherry-pick");
    });

    it("rejects git notes edit", () => {
      const result = validateInteractiveCommand("git notes edit HEAD");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("git notes edit");
    });

    it("allows normal git commands", () => {
      expect(validateInteractiveCommand("git status")).toBeNull();
      expect(validateInteractiveCommand("git commit -m 'msg'")).toBeNull();
      expect(validateInteractiveCommand("git push origin main")).toBeNull();
      expect(validateInteractiveCommand("git log --oneline")).toBeNull();
      expect(
        validateInteractiveCommand("git tag -a v1.2.3 -m 'release'"),
      ).toBeNull();
    });
  });

  // ── Remote connections ───────────────────────────────────────────

  describe("remote connections", () => {
    it("rejects ssh", () => {
      const result = validateInteractiveCommand("ssh user@host");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive remote connection");
    });

    it("rejects telnet", () => {
      expect(validateInteractiveCommand("telnet host 80")).not.toBeNull();
    });

    it("rejects ftp", () => {
      expect(
        validateInteractiveCommand("ftp server.example.com"),
      ).not.toBeNull();
    });

    it("rejects sftp", () => {
      expect(validateInteractiveCommand("sftp user@host")).not.toBeNull();
    });
  });

  // ── Interactive shells ───────────────────────────────────────────

  describe("interactive shells", () => {
    it("rejects bare bash", () => {
      const result = validateInteractiveCommand("bash");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive shell");
    });

    it("rejects bare zsh", () => {
      expect(validateInteractiveCommand("zsh")).not.toBeNull();
    });

    it("allows bash -c", () => {
      expect(validateInteractiveCommand('bash -c "echo hello"')).toBeNull();
    });

    it("allows bash script.sh", () => {
      expect(validateInteractiveCommand("bash script.sh")).toBeNull();
    });

    it("allows zsh -c", () => {
      expect(validateInteractiveCommand('zsh -c "ls"')).toBeNull();
    });
  });

  // ── Scaffolding commands ─────────────────────────────────────────

  describe("scaffolding commands", () => {
    it("rejects npx create-next-app without flags", () => {
      const result = validateInteractiveCommand(
        "npx create-next-app@latest myapp",
      );
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive input");
    });

    it("allows npx create-next-app with --yes", () => {
      expect(
        validateInteractiveCommand(
          "npx create-next-app@latest myapp --yes --typescript",
        ),
      ).toBeNull();
    });

    it("allows npx create-next-app with --use-npm", () => {
      expect(
        validateInteractiveCommand(
          "npx create-next-app@latest myapp --typescript --tailwind --eslint --app --src-dir --use-npm",
        ),
      ).toBeNull();
    });

    it("rejects npm init without -y", () => {
      expect(validateInteractiveCommand("npm init")).not.toBeNull();
    });

    it("allows npm init -y", () => {
      expect(validateInteractiveCommand("npm init -y")).toBeNull();
    });

    it("allows npm init --yes", () => {
      expect(validateInteractiveCommand("npm init --yes")).toBeNull();
    });

    it("rejects npm create without flags", () => {
      const result = validateInteractiveCommand("npm create vite@latest myapp");
      expect(result).not.toBeNull();
    });
  });

  // ── Password commands ────────────────────────────────────────────

  describe("password commands", () => {
    it("rejects passwd", () => {
      const result = validateInteractiveCommand("passwd");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("password");
    });

    it("rejects su", () => {
      expect(validateInteractiveCommand("su")).not.toBeNull();
    });
  });

  // ── Compound commands ────────────────────────────────────────────

  describe("compound commands", () => {
    it("rejects if any sub-command is interactive", () => {
      const result = validateInteractiveCommand("echo hello && vim file.txt");
      expect(result).not.toBeNull();
      expect(result!.message).toContain("interactive editor");
    });

    it("allows compound commands that are all safe", () => {
      expect(
        validateInteractiveCommand("npm install && npm run build && npm test"),
      ).toBeNull();
    });

    it("rejects interactive command after semicolon", () => {
      expect(validateInteractiveCommand("cd /tmp; python")).not.toBeNull();
    });
  });

  // ── sudo handling ────────────────────────────────────────────────

  describe("sudo prefix handling", () => {
    it("rejects sudo vim", () => {
      expect(validateInteractiveCommand("sudo vim /etc/hosts")).not.toBeNull();
    });

    it("rejects sudo -u root nano", () => {
      expect(
        validateInteractiveCommand("sudo -u root nano /etc/hosts"),
      ).not.toBeNull();
    });

    it("allows sudo npm install", () => {
      expect(
        validateInteractiveCommand("sudo npm install -g typescript"),
      ).toBeNull();
    });
  });

  // ── Env var prefix handling ──────────────────────────────────────

  describe("env var prefix handling", () => {
    it("rejects NODE_ENV=prod python (bare REPL with env prefix)", () => {
      expect(
        validateInteractiveCommand("NODE_ENV=production python"),
      ).not.toBeNull();
    });

    it("allows NODE_ENV=prod node script.js", () => {
      expect(
        validateInteractiveCommand("NODE_ENV=production node server.js"),
      ).toBeNull();
    });
  });

  // ── Safe commands (should all pass) ──────────────────────────────

  describe("safe commands (should not be rejected)", () => {
    it("allows ls", () => {
      expect(validateInteractiveCommand("ls -la")).toBeNull();
    });

    it("allows npm install", () => {
      expect(validateInteractiveCommand("npm install express")).toBeNull();
    });

    it("allows npm run build", () => {
      expect(validateInteractiveCommand("npm run build")).toBeNull();
    });

    it("allows npx tsc", () => {
      expect(validateInteractiveCommand("npx tsc --noEmit")).toBeNull();
    });

    it("allows curl", () => {
      expect(
        validateInteractiveCommand("curl -s https://example.com"),
      ).toBeNull();
    });

    it("allows docker run", () => {
      expect(
        validateInteractiveCommand("docker run --rm alpine echo hello"),
      ).toBeNull();
    });

    it("allows make", () => {
      expect(validateInteractiveCommand("make build")).toBeNull();
    });

    it("allows echo", () => {
      expect(validateInteractiveCommand("echo hello world")).toBeNull();
    });

    it("allows mkdir", () => {
      expect(validateInteractiveCommand("mkdir -p src/components")).toBeNull();
    });

    it("allows cd && npm test", () => {
      expect(
        validateInteractiveCommand("cd stress-test && npm test"),
      ).toBeNull();
    });
  });
});
