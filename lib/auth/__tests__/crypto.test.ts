import { describe, expect, it } from "vitest";
import {
  deriveAuthKey,
  equalsConstantTime,
  hashAuthKey,
  randomSalt,
  signSession,
  verifySession,
  type SessionClaims
} from "../crypto";

const SECRET = "test-secret-not-a-real-one";
const NOW = 1_700_000_000_000;

const claims = (overrides: Partial<SessionClaims> = {}): SessionClaims => ({
  sub: "ada",
  name: "Ada",
  exp: NOW + 60_000,
  ...overrides
});

describe("deriveAuthKey", () => {
  it("is deterministic, so the same password logs in twice", async () => {
    const first = await deriveAuthKey("ada", "correct horse battery");
    const second = await deriveAuthKey("ada", "correct horse battery");
    expect(first).toBe(second);
  });

  it("separates accounts, so one leaked key does not unlock another name", async () => {
    // The salt is the account id, which is the only thing the browser knows
    // before it has spoken to the server. Two people who pick the same password
    // must still not share a derived key.
    const ada = await deriveAuthKey("ada", "same password");
    const bob = await deriveAuthKey("bob", "same password");
    expect(ada).not.toBe(bob);
  });

  it("separates passwords", async () => {
    expect(await deriveAuthKey("ada", "one")).not.toBe(await deriveAuthKey("ada", "two"));
  });

  it("never returns the password", async () => {
    const key = await deriveAuthKey("ada", "hunter2");
    expect(key).not.toContain("hunter2");
    expect(key.length).toBeGreaterThan(16);
  });
});

describe("hashAuthKey", () => {
  it("is salted, so two accounts with the same key store different rows", async () => {
    const key = await deriveAuthKey("ada", "same password");
    expect(await hashAuthKey(key, randomSalt())).not.toBe(await hashAuthKey(key, randomSalt()));
  });

  it("verifies by re-hashing with the stored salt", async () => {
    const key = await deriveAuthKey("ada", "correct horse");
    const salt = randomSalt();
    const stored = await hashAuthKey(key, salt);

    expect(await hashAuthKey(key, salt)).toBe(stored);
    expect(await hashAuthKey(await deriveAuthKey("ada", "wrong horse"), salt)).not.toBe(stored);
  });

  it("does not store the key it was given", async () => {
    const key = await deriveAuthKey("ada", "hunter2");
    expect(await hashAuthKey(key, "salt")).not.toBe(key);
  });
});

describe("equalsConstantTime", () => {
  it("agrees with equality", () => {
    expect(equalsConstantTime("abc", "abc")).toBe(true);
    expect(equalsConstantTime("abc", "abd")).toBe(false);
    expect(equalsConstantTime("abc", "ab")).toBe(false);
    expect(equalsConstantTime("", "")).toBe(true);
  });
});

describe("session tokens", () => {
  it("round-trips its claims", async () => {
    const token = await signSession(claims(), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toEqual(claims());
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession(claims(), SECRET);
    expect(await verifySession(token, "another-secret", NOW)).toBeNull();
  });

  it("rejects a token whose claims were edited", async () => {
    // The attack this stops: take your own valid token, swap the subject for
    // somebody else's name, and wear it. The signature covers the payload, so
    // the edit invalidates it.
    const token = await signSession(claims(), SECRET);
    const [payload, signature] = token.split(".");
    const tampered = Buffer.from(JSON.stringify(claims({ sub: "someoneelse" })))
      .toString("base64url");

    expect(payload).not.toBe(tampered);
    expect(await verifySession(`${tampered}.${signature}`, SECRET, NOW)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await signSession(claims({ exp: NOW - 1 }), SECRET);
    expect(await verifySession(token, SECRET, NOW)).toBeNull();
  });

  it("rejects junk rather than throwing on it", async () => {
    for (const junk of ["", ".", "no-dot", "a.b", `${"x".repeat(50)}.${"y".repeat(50)}`]) {
      expect(await verifySession(junk, SECRET, NOW), junk).toBeNull();
    }
  });
});
