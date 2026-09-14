/**
 * The refresh token store.
 *
 * This is the one secret the server keeps in a file of its own, because it mints it rather than
 * receiving it from a person. What has to hold is that the stored form is useless to anyone else
 * and that nothing ever prints it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveRefreshToken, readRefreshToken, forgetRefreshToken, describeStoredToken } from "../src/btp/token-store.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tok-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "rt-a-long-opaque-value-1234567890";

describe("storing a refresh token", () => {
  it("round-trips the token it stored", () => {
    saveRefreshToken(dir, "BTP", TOKEN);
    expect(readRefreshToken(dir, "BTP")).toBe(TOKEN);
  });

  it("seals it with DPAPI on Windows, so the file never holds the token itself", () => {
    const saved = saveRefreshToken(dir, "BTP", TOKEN);
    const onDisk = fs.readFileSync(saved.file, "utf8");
    if (process.platform === "win32") {
      expect(saved.kind).toBe("dpapi");
      expect(onDisk).not.toContain(TOKEN);
    } else {
      // no platform guarantee elsewhere: it is stored plainly, and the caller is told
      expect(saved.kind).toBe("plain");
    }
  });

  it("seals without depending on a PowerShell module being loadable", () => {
    if (process.platform !== "win32") return;
    // Microsoft.PowerShell.Security failing to autoload is what silently downgraded sealing to
    // plain text; a PSModulePath that offers nothing reproduces that shell
    const previous = process.env.PSModulePath;
    process.env.PSModulePath = path.join(os.tmpdir(), "mcp-no-such-modules");
    try {
      const saved = saveRefreshToken(dir, "BTP", TOKEN);
      expect(saved.kind).toBe("dpapi");
      expect(saved.sealError).toBeUndefined();
      expect(fs.readFileSync(saved.file, "utf8")).not.toContain(TOKEN);
      expect(readRefreshToken(dir, "BTP")).toBe(TOKEN);
    } finally {
      if (previous === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = previous;
    }
  });

  it("says why a token ended up in the clear when Windows should have sealed it", () => {
    if (process.platform !== "win32") return;
    const previous = process.env.PATH;
    process.env.PATH = path.join(os.tmpdir(), "mcp-no-powershell-here");
    try {
      const saved = saveRefreshToken(dir, "BTP", TOKEN);
      expect(saved.kind).toBe("plain");
      // the operator must not have to guess that sealing was attempted and failed
      expect(saved.sealError).toBeTruthy();
    } finally {
      process.env.PATH = previous as string;
    }
  });

  it("keeps tokens of different destinations apart", () => {
    saveRefreshToken(dir, "BTP", "token-one");
    saveRefreshToken(dir, "OTHER", "token-two");
    expect(readRefreshToken(dir, "BTP")).toBe("token-one");
    expect(readRefreshToken(dir, "OTHER")).toBe("token-two");
  });

  it("replaces an earlier token for the same destination", () => {
    saveRefreshToken(dir, "BTP", "old");
    saveRefreshToken(dir, "BTP", "new");
    expect(readRefreshToken(dir, "BTP")).toBe("new");
  });

  // a destination name reaches this through configuration, so it must not choose the path
  it("cannot be talked into writing outside its own directory", () => {
    const saved = saveRefreshToken(dir, "../../escape", TOKEN);
    // what matters is that it stays a file name inside the tokens directory; the dots survive as
    // ordinary characters, which is harmless once no separator does
    expect(path.dirname(saved.file)).toBe(path.join(dir, "tokens"));
    expect(path.basename(saved.file)).not.toMatch(/[\/]/);
    expect(path.resolve(saved.file).startsWith(path.resolve(dir))).toBe(true);
    expect(readRefreshToken(dir, "../../escape")).toBe(TOKEN);
  });

  it("reports nothing for a destination that has none", () => {
    expect(readRefreshToken(dir, "ABSENT")).toBeNull();
    expect(describeStoredToken(dir, "ABSENT")).toEqual({ stored: false });
  });

  it("describes what is stored without revealing it", () => {
    saveRefreshToken(dir, "BTP", TOKEN);
    const described = describeStoredToken(dir, "BTP");
    expect(described.stored).toBe(true);
    expect(described.kind).toBe(process.platform === "win32" ? "dpapi" : "plain");
    expect(JSON.stringify(described)).not.toContain(TOKEN);
  });

  it("forgets a token on request", () => {
    saveRefreshToken(dir, "BTP", TOKEN);
    expect(forgetRefreshToken(dir, "BTP")).toBe(true);
    expect(readRefreshToken(dir, "BTP")).toBeNull();
    expect(forgetRefreshToken(dir, "BTP")).toBe(false);
  });

  it("survives a corrupt store instead of throwing at authentication time", () => {
    saveRefreshToken(dir, "BTP", TOKEN);
    fs.writeFileSync(path.join(dir, "tokens", "BTP.json"), "{ not json");
    expect(readRefreshToken(dir, "BTP")).toBeNull();
  });
});
