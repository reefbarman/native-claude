import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import simpleGit, { type SimpleGit } from "simple-git";

/**
 * A single checkpoint — maps to one shadow git commit.
 */
export interface Checkpoint {
  /** Unique ID for this checkpoint */
  id: string;
  /** The shadow repo commit SHA at this point */
  commitHash: string;
  /** Conversation turn index (number of user messages sent before this checkpoint) */
  turnIndex: number;
  /** Timestamp when the checkpoint was created */
  createdAt: number;
}

/**
 * Summary of files that will be affected by a revert operation.
 * Shown to the user before they confirm.
 */
export interface RevertPreview {
  /** Files that will be modified (present in both old and new state) */
  modified: string[];
  /** Files that will be deleted (exist now, didn't exist at checkpoint) */
  deleted: string[];
  /** Files that will be restored (didn't exist now, existed at checkpoint) */
  restored: string[];
}

// Protected workspace paths — refuse to init shadow repo here.
// Only exact matches are checked — we don't want to block all subdirectories
// under $HOME, just the home directory root and specific high-risk folders.
const PROTECTED_PATHS = [
  process.env.HOME ?? "",
  path.join(process.env.HOME ?? "", "Desktop"),
  path.join(process.env.HOME ?? "", "Documents"),
  path.join(process.env.HOME ?? "", "Downloads"),
].filter(Boolean);

// Files/directories to exclude from checkpoints
const EXCLUDE_PATTERNS = [
  ".git",
  ".agentlink",
  "node_modules",
  "dist",
  ".DS_Store",
  "*.log",
  ".env",
  ".env.local",
  ".env.*.local",
];

/**
 * Manages a shadow git repository for workspace checkpoints.
 *
 * The shadow repo lives at `.agentlink/checkpoints/{hashedWorkspaceDir}/`
 * with `core.worktree` pointing to the workspace root. This is completely
 * isolated from any real git history in the project.
 *
 * Based on the approach used by Roo Code's ShadowCheckpointService.
 */
export class CheckpointManager {
  private readonly workspaceDir: string;
  private readonly shadowDir: string;
  /** Absolute path to the shadow repo's .git directory */
  private readonly gitDir: string;
  private readonly taskId: string;
  private git: SimpleGit | null = null;
  private baseCommitHash: string | null = null;
  private initialized = false;
  private initPromise: Promise<boolean> | null = null;
  private log: (msg: string) => void;

  constructor(opts: {
    workspaceDir: string;
    taskId: string;
    log?: (msg: string) => void;
  }) {
    this.workspaceDir = opts.workspaceDir;
    this.taskId = opts.taskId;
    this.log = opts.log ?? (() => undefined);

    const hash = crypto
      .createHash("sha256")
      .update(opts.workspaceDir)
      .digest("hex")
      .slice(0, 16);
    this.shadowDir = path.join(
      opts.workspaceDir,
      ".agentlink",
      "checkpoints",
      hash,
    );
    this.gitDir = path.join(this.shadowDir, ".git");
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the shadow git repo. Safe to call multiple times — idempotent.
   * Returns false if the workspace is protected or init fails.
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return true;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<boolean> {
    if (this.initialized) return true;

    // Refuse protected paths (exact match only — don't block subdirectories)
    for (const protected_ of PROTECTED_PATHS) {
      if (protected_ && this.workspaceDir === protected_) {
        this.log(
          `[checkpoint] Refusing to init in protected path: ${this.workspaceDir}`,
        );
        return false;
      }
    }

    try {
      this.log(
        `[checkpoint] Initializing shadow repo at ${this.shadowDir} for workspace ${this.workspaceDir}`,
      );
      fs.mkdirSync(this.shadowDir, { recursive: true });

      // Create simpleGit pointed at the shadow directory.
      // We use getGitEnv() which sets GIT_DIR explicitly to prevent git
      // from walking up and discovering the main project's .git.
      this.git = simpleGit({
        baseDir: this.shadowDir,
        binary: "git",
        maxConcurrentProcesses: 1,
        trimmed: true,
      });

      // Check if the shadow repo's own .git exists (not a parent repo)
      const isRepo = this.isShadowGitRepo();

      if (!isRepo) {
        // git init needs to run WITHOUT GIT_DIR set (the dir doesn't exist yet)
        const initEnv = this.getSanitizedBaseEnv();
        await this.git.env(initEnv).init(["--template="]); // empty template, no hooks

        // Now .git exists — configure it
        const env = this.getGitEnv();
        await this.git.env(env).addConfig("core.worktree", this.workspaceDir);
        await this.git.env(env).addConfig("commit.gpgSign", "false");
        await this.git.env(env).addConfig("user.name", "AgentLink");
        await this.git
          .env(env)
          .addConfig("user.email", "agent@agentlink.local");

        // Write .git/info/exclude to ignore large/unneeded directories
        const excludeFile = path.join(this.gitDir, "info", "exclude");
        fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
        fs.writeFileSync(
          excludeFile,
          EXCLUDE_PATTERNS.join("\n") + "\n",
          "utf-8",
        );

        // Create initial commit as base
        await this.git
          .env(env)
          .add(this.workspaceDir)
          .catch(() => undefined); // ignore errors from unreadable files

        const result = await this.git
          .env(env)
          .commit("initial", { "--allow-empty": null });

        this.baseCommitHash = result.commit;
        this.log(
          `[checkpoint] Initialized, base commit: ${this.baseCommitHash}`,
        );
      } else {
        // Already exists — read the base commit (first commit in history)
        const env = this.getGitEnv();
        const log = await this.git.env(env).log(["--oneline", "--reverse"]);
        this.baseCommitHash = log.all[0]?.hash ?? null;
        this.log(
          `[checkpoint] Reusing existing shadow repo, base commit: ${this.baseCommitHash}`,
        );
      }

      this.initialized = true;
      return true;
    } catch (err) {
      this.log(`[checkpoint] Init failed: ${err}`);
      this.git = null;
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Checkpoint creation
  // ---------------------------------------------------------------------------

  /**
   * Create a checkpoint at the current workspace state.
   * Returns null if checkpoints are not initialized or creation fails.
   */
  async createCheckpoint(turnIndex: number): Promise<Checkpoint | null> {
    // If init is still in progress, wait for it (avoids race on first message)
    if (!this.initialized && this.initPromise) {
      await this.initPromise;
    }
    if (!this.initialized || !this.git) return null;

    const env = this.getGitEnv();
    try {
      const start = Date.now();

      await this.git
        .env(env)
        .add(this.workspaceDir)
        .catch(() => undefined); // ignore errors (unreadable files, etc.)

      const message = `checkpoint-${this.taskId}-turn${turnIndex}`;
      let commitHash: string;

      try {
        const result = await this.git
          .env(env)
          .commit(message, { "--allow-empty": null });
        commitHash = result.commit;
      } catch {
        // Nothing changed — get HEAD
        const head = await this.git.env(env).revparse(["HEAD"]);
        commitHash = head.trim();
      }

      const checkpoint: Checkpoint = {
        id: crypto.randomUUID(),
        commitHash,
        turnIndex,
        createdAt: Date.now(),
      };

      this.log(
        `[checkpoint] Created turn=${turnIndex} hash=${commitHash.slice(0, 8)} (${Date.now() - start}ms)`,
      );
      return checkpoint;
    } catch (err) {
      this.log(`[checkpoint] Create failed: ${err}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Revert
  // ---------------------------------------------------------------------------

  /**
   * Preview what files would change if we reverted to this checkpoint.
   */
  async previewRevert(checkpoint: Checkpoint): Promise<RevertPreview | null> {
    if (!this.initialized || !this.git) return null;

    const env = this.getGitEnv();
    try {
      // Files changed since the checkpoint commit
      const diffOutput = await this.git
        .env(env)
        .diff([`${checkpoint.commitHash}`, "--name-status"]);

      const modified: string[] = [];
      const deleted: string[] = [];
      const restored: string[] = [];

      for (const line of diffOutput.split("\n").filter(Boolean)) {
        const [status, ...rest] = line.split("\t");
        const file = rest.join("\t");
        if (!file) continue;
        if (status === "M") modified.push(file);
        else if (status === "A")
          deleted.push(file); // added since checkpoint → will be deleted on revert
        else if (status === "D") restored.push(file); // deleted since checkpoint → will be restored
      }

      return { modified, deleted, restored };
    } catch (err) {
      this.log(`[checkpoint] Preview failed: ${err}`);
      return null;
    }
  }

  /**
   * Revert the workspace to the state at `checkpoint`.
   * Also stashes current state as a safety net (recoverable via `git stash pop`).
   */
  async revertToCheckpoint(checkpoint: Checkpoint): Promise<boolean> {
    if (!this.initialized || !this.git) return false;

    const env = this.getGitEnv();
    try {
      this.log(
        `[checkpoint] Reverting to ${checkpoint.commitHash.slice(0, 8)}`,
      );

      // Stash current state as safety net
      await this.git
        .env(env)
        .add(this.workspaceDir)
        .catch(() => undefined);

      try {
        await this.git
          .env(env)
          .stash(["push", "--include-untracked", "-m", "pre-revert-stash"]);
      } catch {
        // Nothing to stash — that's fine
      }

      // Remove untracked files (clean -f -d -f is double-force for nested dirs)
      await this.git
        .env(env)
        .clean(["-f", "-d", "-f"])
        .catch(() => undefined);

      // Hard reset to the checkpoint commit
      await this.git.env(env).reset(["--hard", checkpoint.commitHash]);

      this.log(`[checkpoint] Reverted successfully`);
      return true;
    } catch (err) {
      this.log(`[checkpoint] Revert failed: ${err}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Diff
  // ---------------------------------------------------------------------------

  /**
   * Get a unified diff of all workspace changes since a given commit hash.
   * Useful for providing review agents with the exact file changes.
   * Returns empty string if checkpoints are not initialized or the diff fails.
   */
  async getDiffSince(commitHash: string): Promise<string> {
    if (!this.initialized || !this.git) return "";
    const env = this.getGitEnv();
    try {
      return await this.git.env(env).diff([commitHash, "--unified=3"]);
    } catch (err) {
      this.log(`[checkpoint] getDiffSince failed: ${err}`);
      return "";
    }
  }

  /**
   * Get a unified diff between two commits in the shadow repo.
   * Returns empty string if checkpoints are not initialized or the diff fails.
   */
  async getDiffBetween(fromHash: string, toHash: string): Promise<string> {
    if (!this.initialized || !this.git) return "";
    const env = this.getGitEnv();
    try {
      return await this.git.env(env).diff([fromHash, toHash, "--unified=3"]);
    } catch (err) {
      this.log(`[checkpoint] getDiffBetween failed: ${err}`);
      return "";
    }
  }

  /**
   * Get the commit hash of the most recent checkpoint commit (HEAD of shadow repo).
   * Returns null if not initialized.
   */
  async getHeadCommit(): Promise<string | null> {
    if (!this.initialized || !this.git) return null;
    const env = this.getGitEnv();
    try {
      const head = await this.git.env(env).revparse(["HEAD"]);
      return head.trim() || null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether the shadow repo's own .git directory exists.
   * Uses a filesystem check instead of `git status` to avoid git's
   * parent-directory traversal which could find the main project's repo.
   */
  private isShadowGitRepo(): boolean {
    try {
      return fs.existsSync(path.join(this.gitDir, "HEAD"));
    } catch {
      return false;
    }
  }

  /**
   * Return a sanitized base env (no git env vars that could leak to parent repos).
   * Used for `git init` before the shadow .git directory exists.
   */
  private getSanitizedBaseEnv(): Record<string, string> {
    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    delete env.GIT_OBJECT_DIRECTORY;
    delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
    return env;
  }

  /**
   * Return a git env that explicitly points at the shadow repo.
   * Sets GIT_DIR and GIT_WORK_TREE so git never walks up to a parent repo.
   */
  private getGitEnv(): Record<string, string> {
    const env = this.getSanitizedBaseEnv();
    env.GIT_DIR = this.gitDir;
    env.GIT_WORK_TREE = this.workspaceDir;
    return env;
  }

  /** The commit hash of the initial (base) commit in the shadow repo. */
  get baseCommit(): string | null {
    return this.baseCommitHash;
  }

  get isReady(): boolean {
    return this.initialized && this.git !== null;
  }
}
