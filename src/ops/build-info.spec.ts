import { describe, expect, it } from "vitest";
import { getBuildInfo } from "./build-info.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe("getBuildInfo", () => {
  it("falls back to package metadata and unknown build fields", () => {
    const oldVersion = process.env.DISPATCHER_VERSION;
    const oldSha = process.env.DISPATCHER_GIT_SHA;
    const oldBuildTime = process.env.DISPATCHER_BUILD_TIME;
    const oldImageTag = process.env.DISPATCHER_IMAGE_TAG;

    delete process.env.DISPATCHER_VERSION;
    delete process.env.DISPATCHER_GIT_SHA;
    delete process.env.DISPATCHER_BUILD_TIME;
    delete process.env.DISPATCHER_IMAGE_TAG;

    const info = getBuildInfo();

    expect(info.name).toBe("scalemargin-dispatch-handler");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.git_sha).toBe("unknown");
    expect(info.build_time).toBe("unknown");
    expect(info.image_tag).toBe("unknown");
    expect(info.node_version).toMatch(/^v/);

    restoreEnv("DISPATCHER_VERSION", oldVersion);
    restoreEnv("DISPATCHER_GIT_SHA", oldSha);
    restoreEnv("DISPATCHER_BUILD_TIME", oldBuildTime);
    restoreEnv("DISPATCHER_IMAGE_TAG", oldImageTag);
  });
});
