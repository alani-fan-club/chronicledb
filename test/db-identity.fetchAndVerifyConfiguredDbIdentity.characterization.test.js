import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DB_IDENTITY_QUERY,
  verifyConfiguredDbIdentity,
  fetchAndVerifyConfiguredDbIdentity,
} = require("../server-plugin/db-identity.js");

describe("db identity verifier characterization", () => {
  it("returns identity when configured user and database match", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ u: "samantha", d: "chronicledb" }] }),
    };

    const out = await fetchAndVerifyConfiguredDbIdentity(pool, {
      pgUser: "samantha",
      pgDatabase: "chronicledb",
    });

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(DB_IDENTITY_QUERY);
    expect(out).toEqual({ u: "samantha", d: "chronicledb" });
  });

  it("throws with custom user mismatch message", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ u: "postgres", d: "chronicledb" }] }),
    };

    await expect(
      fetchAndVerifyConfiguredDbIdentity(
        pool,
        { pgUser: "samantha", pgDatabase: "chronicledb" },
        {
          userMismatchMessage: (actual, expected) => `USER ${actual} != ${expected}`,
        },
      ),
    ).rejects.toThrow("USER postgres != samantha");
  });

  it("throws with custom database mismatch message", async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rows: [{ u: "samantha", d: "otherdb" }] }),
    };

    await expect(
      fetchAndVerifyConfiguredDbIdentity(
        pool,
        { pgUser: "samantha", pgDatabase: "chronicledb" },
        {
          databaseMismatchMessage: (actual, expected) => `DB ${actual} != ${expected}`,
        },
      ),
    ).rejects.toThrow("DB otherdb != chronicledb");
  });

  it("skips checks when configured values are empty", () => {
    expect(() =>
      verifyConfiguredDbIdentity(
        { u: "actual-user", d: "actual-db" },
        { pgUser: "", pgDatabase: "" },
      ),
    ).not.toThrow();
  });

  it("uses default mismatch messages when custom formatters are not provided", async () => {
    const userMismatchPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ u: "postgres", d: "chronicledb" }] }),
    };
    await expect(
      fetchAndVerifyConfiguredDbIdentity(userMismatchPool, {
        pgUser: "samantha",
        pgDatabase: "chronicledb",
      }),
    ).rejects.toThrow('Connected as "postgres" but expected user "samantha".');

    const dbMismatchPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ u: "samantha", d: "otherdb" }] }),
    };
    await expect(
      fetchAndVerifyConfiguredDbIdentity(dbMismatchPool, {
        pgUser: "samantha",
        pgDatabase: "chronicledb",
      }),
    ).rejects.toThrow('Connected to database "otherdb" but expected "chronicledb".');
  });

  it("falls back safely when options shape is invalid", () => {
    expect(() =>
      verifyConfiguredDbIdentity(
        { u: "postgres", d: "chronicledb" },
        { pgUser: "samantha", pgDatabase: "chronicledb" },
        "not-an-object",
      ),
    ).toThrow('Connected as "postgres" but expected user "samantha".');

    expect(() =>
      verifyConfiguredDbIdentity(
        { u: "samantha", d: "otherdb" },
        { pgUser: "samantha", pgDatabase: "chronicledb" },
        { databaseMismatchMessage: "not-a-function" },
      ),
    ).toThrow('Connected to database "otherdb" but expected "chronicledb".');
  });

  it("propagates pool query failures", async () => {
    const pool = {
      query: vi.fn().mockRejectedValue(new Error("db-down")),
    };

    await expect(
      fetchAndVerifyConfiguredDbIdentity(pool, {
        pgUser: "samantha",
        pgDatabase: "chronicledb",
      }),
    ).rejects.toThrow("db-down");
  });
});
