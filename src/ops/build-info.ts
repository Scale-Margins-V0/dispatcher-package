import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  name: string;
  version: string;
  git_sha: string;
  build_time: string;
  image_tag: string;
  node_version: string;
  uptime_seconds: number;
  environment: string;
}

interface PackageJson {
  name?: string;
  version?: string;
}

function readPackageJson(): PackageJson {
  const path = join(process.cwd(), "package.json");
  if (!existsSync(path)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return {};
  }
}

export function getBuildInfo(): BuildInfo {
  const pkg = readPackageJson();

  return {
    name: pkg.name ?? "scalemargin-dispatch-handler",
    version: process.env.DISPATCHER_VERSION || pkg.version || "unknown",
    git_sha: process.env.DISPATCHER_GIT_SHA || "unknown",
    build_time: process.env.DISPATCHER_BUILD_TIME || "unknown",
    image_tag: process.env.DISPATCHER_IMAGE_TAG || "unknown",
    node_version: process.version,
    uptime_seconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || "development",
  };
}
