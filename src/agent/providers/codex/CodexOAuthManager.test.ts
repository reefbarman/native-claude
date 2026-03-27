import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodexOAuthManager,
  type CodexCredentials,
} from "./CodexOAuthManager.js";

type SecretStorage = {
  get: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

type ExtensionContextLike = {
  secrets: SecretStorage;
};

function createContext(values?: Map<string, string>): ExtensionContextLike {
  const sharedValues = values ?? new Map<string, string>();

  const secrets: SecretStorage = {
    get: vi.fn(async (key: string) => sharedValues.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      sharedValues.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      sharedValues.delete(key);
    }),
  };

  return { secrets };
}

function makeCreds(args: {
  accountId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  chatgptUserId?: string;
  subject?: string;
}): CodexCredentials {
  return {
    accountId: args.accountId,
    email: args.email,
    accessToken: args.accessToken,
    refreshToken: args.refreshToken,
    chatgptUserId: args.chatgptUserId,
    subject: args.subject,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
}

describe("CodexOAuthManager", () => {
  let manager: CodexOAuthManager;
  let context: ExtensionContextLike;

  beforeEach(() => {
    context = createContext();
    manager = new CodexOAuthManager(() => {});
    manager.initialize(context as never);
  });

  it("replace flow only merges duplicates by email when email is present", async () => {
    const first = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-1",
        email: "one@example.com",
        accessToken: "at-1",
        refreshToken: "rt-1",
      }),
      { label: "one", makeActive: true },
    );

    const second = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-2",
        email: "two@example.com",
        accessToken: "at-2",
        refreshToken: "rt-2",
      }),
      { label: "two", makeActive: false },
    );

    const replaced = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-2",
        email: "replacement@example.com",
        accessToken: "at-r",
        refreshToken: "rt-r",
      }),
      {
        replaceAccountId: first.account.id,
        label: "replacement",
        makeActive: true,
      },
    );

    expect(replaced.action).toBe("replaced");
    expect(replaced.account.id).toBe(first.account.id);
    expect(replaced.account.chatgptAccountId).toBe("acct-2");
    expect(replaced.account.label).toBe("replacement");

    const all = await manager.listAccounts();
    expect(all).toHaveLength(2);
    expect(all.some((a) => a.id === first.account.id)).toBe(true);
    expect(all.some((a) => a.id === second.account.id)).toBe(true);
    expect(all.find((a) => a.id === first.account.id)?.isActive).toBe(true);
  });

  it("treats same-organization account ids as distinct OAuth accounts", async () => {
    const first = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "org-shared-id",
        email: "first@example.com",
        accessToken: "at-1",
        refreshToken: "rt-1",
      }),
      { label: "first", makeActive: true },
    );

    const second = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "org-shared-id-2",
        email: "second@example.com",
        accessToken: "at-2",
        refreshToken: "rt-2",
      }),
      { label: "second", makeActive: false },
    );

    expect(first.action).toBe("added");
    expect(second.action).toBe("added");

    const all = await manager.listAccounts();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.email)).toEqual([
      "first@example.com",
      "second@example.com",
    ]);
  });

  it("updates existing account by chatgptUserId even when email changes", async () => {
    const first = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-1",
        email: "same@example.com",
        accessToken: "at-1",
        refreshToken: "rt-1",
        chatgptUserId: "user-1",
      }),
      { label: "same", makeActive: true },
    );

    const updated = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-shared",
        email: "changed@example.com",
        accessToken: "at-2",
        refreshToken: "rt-2",
        chatgptUserId: "user-1",
      }),
      { makeActive: true },
    );

    expect(updated.action).toBe("updated");
    expect(updated.account.id).toBe(first.account.id);

    const all = await manager.listAccounts();
    expect(all).toHaveLength(1);
    expect(all[0].email).toBe("changed@example.com");
  });

  it("adds a new account when email differs even if account id collides", async () => {
    await manager.saveOAuthAccount(
      makeCreds({
        accountId: "shared-id",
        email: "one@example.com",
        accessToken: "at-1",
        refreshToken: "rt-1",
        chatgptUserId: "user-1",
      }),
      { makeActive: true },
    );

    const second = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "shared-id",
        email: "two@example.com",
        accessToken: "at-2",
        refreshToken: "rt-2",
        chatgptUserId: "user-2",
      }),
      { makeActive: true },
    );

    expect(second.action).toBe("added");

    const all = await manager.listAccounts();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.email)).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
  });

  it("updates existing account by subject when chatgptUserId is missing", async () => {
    const first = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-1",
        email: "old@example.com",
        accessToken: "at-1",
        refreshToken: "rt-1",
        subject: "sub-1",
      }),
      { label: "old", makeActive: true },
    );

    const updated = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-2",
        email: "new@example.com",
        accessToken: "at-2",
        refreshToken: "rt-2",
        subject: "sub-1",
      }),
      { makeActive: true },
    );

    expect(updated.action).toBe("updated");
    expect(updated.account.id).toBe(first.account.id);

    const all = await manager.listAccounts();
    expect(all).toHaveLength(1);
    expect(all[0].email).toBe("new@example.com");
  });

  it("replace flow removes duplicate account matched by chatgptUserId", async () => {
    const first = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-1",
        email: "first@example.com",
        accessToken: "at-1",
        refreshToken: "rt-1",
        chatgptUserId: "user-1",
      }),
      { label: "first", makeActive: true },
    );

    const second = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-2",
        email: "dup@example.com",
        accessToken: "at-2",
        refreshToken: "rt-2",
        chatgptUserId: "user-dup",
      }),
      { label: "second", makeActive: false },
    );

    const replaced = await manager.saveOAuthAccount(
      {
        email: "new@example.com",
        accessToken: "at-3",
        refreshToken: "rt-3",
        expiresAt: Date.now() + 60 * 60 * 1000,
        chatgptUserId: "user-dup",
      },
      {
        replaceAccountId: first.account.id,
        makeActive: true,
      },
    );

    expect(replaced.action).toBe("replaced");
    const all = await manager.listAccounts();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(first.account.id);
    expect(await manager.getAccountById(second.account.id)).toBeNull();
  });

  it("prefers chatgptUserId over subject when both signals conflict", async () => {
    const byUserId = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-a",
        email: "a@example.com",
        accessToken: "at-a",
        refreshToken: "rt-a",
        chatgptUserId: "user-1",
        subject: "sub-a",
      }),
      { label: "A", makeActive: true },
    );

    const bySubject = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-b",
        email: "b@example.com",
        accessToken: "at-b",
        refreshToken: "rt-b",
        chatgptUserId: "user-2",
        subject: "sub-1",
      }),
      { label: "B", makeActive: false },
    );

    const updated = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-c",
        email: "new@example.com",
        accessToken: "at-c",
        refreshToken: "rt-c",
        chatgptUserId: "user-1",
        subject: "sub-1",
      }),
      { makeActive: true },
    );

    expect(updated.action).toBe("updated");
    expect(updated.account.id).toBe(byUserId.account.id);

    const all = await manager.listAccounts();
    expect(all).toHaveLength(2);
    expect(await manager.getAccountById(bySubject.account.id)).not.toBeNull();
  });

  it("round-trips chatgptUserId and subject from stored oauth state", async () => {
    const sharedValues = new Map<string, string>();
    const seededState = {
      version: 2,
      activeAccountId: "acct-1",
      accounts: [
        {
          id: "acct-1",
          label: "Seeded",
          email: "seed@example.com",
          chatgptAccountId: "chatgpt-acct-1",
          chatgptUserId: "chatgpt-user-1",
          subject: "sub-seeded",
          accessToken: "at-seeded",
          refreshToken: "rt-seeded",
          expiresAt: Date.now() + 60 * 60 * 1000,
          createdAt: Date.now() - 1000,
          updatedAt: Date.now(),
        },
      ],
    };
    sharedValues.set("codex-oauth-credentials", JSON.stringify(seededState));

    const seededManager = new CodexOAuthManager(() => {});
    seededManager.initialize(createContext(sharedValues) as never);

    const accounts = await seededManager.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].chatgptUserId).toBe("chatgpt-user-1");
    expect(accounts[0].subject).toBe("sub-seeded");
  });

  it("returns round-robin ids starting after pivot and wrapping", async () => {
    const a = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-a",
        email: "a@example.com",
        accessToken: "at-a",
        refreshToken: "rt-a",
      }),
      { label: "A", makeActive: true },
    );
    const b = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-b",
        email: "b@example.com",
        accessToken: "at-b",
        refreshToken: "rt-b",
      }),
      { label: "B", makeActive: false },
    );
    const c = await manager.saveOAuthAccount(
      makeCreds({
        accountId: "acct-c",
        email: "c@example.com",
        accessToken: "at-c",
        refreshToken: "rt-c",
      }),
      { label: "C", makeActive: false },
    );

    const ids = await manager.getRoundRobinAccountIds(a.account.id);

    expect(ids).toEqual([b.account.id, c.account.id, a.account.id]);
  });

  it("reads latest shared secret state across separate manager instances", async () => {
    const sharedValues = new Map<string, string>();

    const managerA = new CodexOAuthManager(() => {});
    managerA.initialize(createContext(sharedValues) as never);

    const managerB = new CodexOAuthManager(() => {});
    managerB.initialize(createContext(sharedValues) as never);

    await managerA.saveOAuthAccount(
      makeCreds({
        accountId: "acct-a",
        email: "a@example.com",
        accessToken: "at-a",
        refreshToken: "rt-a",
      }),
      { label: "A", makeActive: true },
    );

    await managerA.saveOAuthAccount(
      makeCreds({
        accountId: "acct-b",
        email: "b@example.com",
        accessToken: "at-b",
        refreshToken: "rt-b",
      }),
      { label: "B", makeActive: false },
    );

    const accountsFromB = await managerB.listAccounts();
    expect(accountsFromB).toHaveLength(2);
    expect(accountsFromB.map((a) => a.email)).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("does not let stale instance overwrite newer shared secret state", async () => {
    const sharedValues = new Map<string, string>();

    const managerA = new CodexOAuthManager(() => {});
    managerA.initialize(createContext(sharedValues) as never);

    const managerB = new CodexOAuthManager(() => {});
    managerB.initialize(createContext(sharedValues) as never);

    const accountA = await managerA.saveOAuthAccount(
      makeCreds({
        accountId: "acct-a",
        email: "a@example.com",
        accessToken: "at-a",
        refreshToken: "rt-a",
      }),
      { label: "A", makeActive: true },
    );

    const accountB = await managerB.saveOAuthAccount(
      makeCreds({
        accountId: "acct-b",
        email: "b@example.com",
        accessToken: "at-b",
        refreshToken: "rt-b",
      }),
      { label: "B", makeActive: true },
    );

    const setActiveResult = await managerA.setActiveAccount(
      accountA.account.id,
    );
    expect(setActiveResult).not.toBeNull();

    const finalAccounts = await managerA.listAccounts();
    expect(finalAccounts).toHaveLength(2);
    expect(finalAccounts.some((a) => a.id === accountA.account.id)).toBe(true);
    expect(finalAccounts.some((a) => a.id === accountB.account.id)).toBe(true);

    const active = await managerA.getActiveAccount();
    expect(active?.id).toBe(accountA.account.id);
  });

  it("returns null when stale instance sets active account removed by another instance", async () => {
    const sharedValues = new Map<string, string>();

    const managerA = new CodexOAuthManager(() => {});
    managerA.initialize(createContext(sharedValues) as never);

    const managerB = new CodexOAuthManager(() => {});
    managerB.initialize(createContext(sharedValues) as never);

    const accountA = await managerA.saveOAuthAccount(
      makeCreds({
        accountId: "acct-a",
        email: "a@example.com",
        accessToken: "at-a",
        refreshToken: "rt-a",
      }),
      { label: "A", makeActive: true },
    );

    const accountB = await managerB.saveOAuthAccount(
      makeCreds({
        accountId: "acct-b",
        email: "b@example.com",
        accessToken: "at-b",
        refreshToken: "rt-b",
      }),
      { label: "B", makeActive: true },
    );

    const removed = await managerB.removeAccount(accountA.account.id);
    expect(removed).toBe(true);

    const setActiveResult = await managerA.setActiveAccount(
      accountA.account.id,
    );
    expect(setActiveResult).toBeNull();

    const finalAccounts = await managerA.listAccounts();
    expect(finalAccounts).toHaveLength(1);
    expect(finalAccounts[0].id).toBe(accountB.account.id);
  });
});
