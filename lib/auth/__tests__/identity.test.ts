import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH, checkName, checkPassword, toUserId } from "../identity";

describe("toUserId", () => {
  // This function is the whole impersonation story. Two names that normalise to
  // the same id are one account; two that do not are two people who can both be
  // in a room at once.
  it("folds case and punctuation, so lookalike spellings are one account", () => {
    const spellings = ["Sankalp", "sankalp", "S.A.N.K.A.L.P", "s a n k a l p", "-sankalp-", "SANKALP"];
    for (const spelling of spellings) expect(toUserId(spelling)).toBe("sankalp");
  });

  it("keeps digits, which are part of a name rather than punctuation", () => {
    expect(toUserId("Player 1")).toBe("player1");
    expect(toUserId("xX_pro_Xx99")).toBe("xxproxx99");
  });

  it("does not fold two genuinely different names together", () => {
    expect(toUserId("sankalp")).not.toBe(toUserId("sankalp2"));
    expect(toUserId("ada")).not.toBe(toUserId("adam"));
  });

  it("strips everything from a name made only of punctuation", () => {
    // Which `checkName` then rejects — an empty id must never reach storage as
    // a primary key.
    expect(toUserId("!!!")).toBe("");
    expect(toUserId("   ")).toBe("");
  });
});

describe("checkName", () => {
  it("accepts an ordinary name and reports its id", () => {
    expect(checkName("  Ada Lovelace ")).toEqual({ ok: true, id: "adalovelace" });
  });

  it("refuses names with too little substance to be an identity", () => {
    expect(checkName("!!!").ok).toBe(false);
    expect(checkName("a").ok).toBe(false);
    expect(checkName("").ok).toBe(false);
  });

  it("refuses names longer than a seat can display", () => {
    expect(checkName("a".repeat(MAX_NAME_LENGTH)).ok).toBe(true);
    expect(checkName("a".repeat(MAX_NAME_LENGTH + 1)).ok).toBe(false);
  });

  it("holds back names the room would be mistaken for", () => {
    for (const reserved of ["guest", "System", "s.e.r.v.e.r", "ADMIN", "cpu"]) {
      expect(checkName(reserved).ok, reserved).toBe(false);
    }
  });
});

describe("checkPassword", () => {
  it("sets a floor and a ceiling", () => {
    expect(checkPassword("12345").ok).toBe(false);
    expect(checkPassword("123456").ok).toBe(true);
    // The ceiling exists only so a megabyte cannot be fed to the key derivation.
    expect(checkPassword("x".repeat(257)).ok).toBe(false);
  });
});
