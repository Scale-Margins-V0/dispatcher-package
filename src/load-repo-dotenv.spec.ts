import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRepoDotEnv } from "./load-repo-dotenv.js";

describe("loadRepoDotEnv", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      try {
        rmSync(join(dir, ".env"));
        rmSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
    }
    delete process.env.FOO_LOAD_REPO_DOTENV_TEST;
  });

  it("last occurrence in file wins for duplicate keys", () => {
    dir = mkdtempSync(join(tmpdir(), "lrde-"));
    writeFileSync(
      join(dir, ".env"),
      "FOO_LOAD_REPO_DOTENV_TEST=first\nFOO_LOAD_REPO_DOTENV_TEST=second\n",
      "utf8"
    );
    delete process.env.FOO_LOAD_REPO_DOTENV_TEST;
    loadRepoDotEnv(dir);
    expect(process.env.FOO_LOAD_REPO_DOTENV_TEST).toBe("second");
  });

  it("does not overwrite non-empty shell value", () => {
    dir = mkdtempSync(join(tmpdir(), "lrde-"));
    writeFileSync(join(dir, ".env"), "FOO_LOAD_REPO_DOTENV_TEST=file\n", "utf8");
    process.env.FOO_LOAD_REPO_DOTENV_TEST = "from-shell";
    loadRepoDotEnv(dir);
    expect(process.env.FOO_LOAD_REPO_DOTENV_TEST).toBe("from-shell");
  });
});
