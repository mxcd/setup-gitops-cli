import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createWriteStream,
  mkdirSync,
  renameSync,
  cpSync,
  chmodSync,
  existsSync,
} from "node:fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { debug, info, warning } from "@actions/core";
import * as cache from "@actions/cache";
import * as toolCache from "@actions/tool-cache";
import { spawnSync } from "child_process";
import { v4 as uuidv4 } from "uuid";
import { Readable } from "stream";
import { finished } from "stream/promises";

const DEFAULT_VERSION = "2.2.2";
const OWNER = "mxcd";
const REPO = "gitops-cli";
const BASE_DIR = join(homedir(), ".gitops-cli");

export type Input = {
  version?: string;
  os?: string;
  arch?: string;
  noCache?: boolean;
};

export type Output = {
  version: string;
  binaryPath: string;
  cacheHit: boolean;
};

export default async (options: Input): Promise<Output> => {
  const version = options.version ?? DEFAULT_VERSION;
  const arch = options.arch ?? process.arch;
  const os = options.os ?? process.platform;
  const cacheEnabled = isCacheEnabled(options);

  const binaryDirectory = join(BASE_DIR, "bin");

  prepareBinaryDirectory(binaryDirectory);

  const extension = process.platform === "win32" ? ".exe" : "";
  const executableFileName = `gitops${extension}`;
  const assetFileName = getAssetFileName(arch, os, version);

  const binaryFileName = join(binaryDirectory, executableFileName);

  let cacheHit = false;

  if (cacheEnabled) {
    cacheHit = await checkToolCache(version, os, arch);
    if (cacheHit) {
      prepareBinaryFile(null, binaryFileName);
      const cachedVersion = await getVersion(binaryFileName);
      if (cachedVersion !== version) {
        warning(
          `Found a cached version of gitops: ${cachedVersion} (but it appears to be corrupted?)`,
        );
        cacheHit = false;
      }
    }
  }

  if (!cacheHit) {
    const downloadPath = await downloadBinary(version, assetFileName);
    prepareBinaryFile(downloadPath, binaryFileName);

    info(`Download done. Checking the version of ${binaryFileName}`);
    const downloadedVersion = await getVersion();
    if (downloadedVersion !== version) {
      warning(
        `Downloaded a new version of gitops-cli: ${downloadedVersion} (but it appears to be corrupted?)`,
      );
    } else {
      info(`Downloaded version: ${downloadedVersion}`);
    }

    await updateToolCache(version, os, arch);
  }

  return {
    version,
    binaryPath: binaryFileName,
    cacheHit,
  };
};

function prepareBinaryDirectory(binaryDirectory: string): void {
  try {
    mkdirSync(binaryDirectory, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  core.addPath(binaryDirectory);
}

async function checkToolCache(
  version: string,
  os: string,
  arch: string,
): Promise<boolean> {
  const cachedPath = toolCache.find("gitops-cli", version, `${os}-${arch}`);
  if (!cachedPath) {
    return false;
  }

  if (!existsSync(cachedPath)) {
    warning(
      `Found a cached version of gitops-cli: ${version}, but the path does not exist: ${cachedPath}`,
    );
    return false;
  }

  info(`Found a cached version of gitops-cli: ${version}`);
  debug(`Copying ${cachedPath} to ${BASE_DIR}`);
  cpSync(cachedPath, BASE_DIR, { recursive: true });
  return true;
}

async function updateToolCache(
  version: string,
  os: string,
  arch: string,
): Promise<void> {
  await toolCache.cacheDir(BASE_DIR, "gitops-cli", version, `${os}-${arch}`);
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface GitHubRelease {
  assets: ReleaseAsset[];
}

async function getRelease(version: string): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${version}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
  return res.json() as Promise<GitHubRelease>;
}

async function downloadBinary(
  version: string,
  binaryFileName: string,
): Promise<string> {
  info(`Downloading '${binaryFileName}' version '${version}'`);
  const downloadPath = `/tmp/${uuidv4()}`;

  const release = await getRelease(version);

  const assets = release.assets;
  const asset = assets.find((asset) => asset.name == binaryFileName);

  const response = await fetch(asset.url, {
    headers: {
      Accept: "application/octet-stream",
    },
  });

  const fileStream = createWriteStream(downloadPath, { flags: "wx" });
  await finished(Readable.fromWeb(response.body).pipe(fileStream));

  return downloadPath;
}

function prepareBinaryFile(
  source: string | null,
  binaryFileName: string,
): void {
  if (source) {
    try {
      info(`Renaming ${source} to ${binaryFileName}`);
      renameSync(source, binaryFileName);
    } catch {
      // If mv does not work, try to copy the file instead.
      // For example: EXDEV: cross-device link not permitted
      warning(
        `Failed to rename ${source} to ${binaryFileName}. Trying to copy.`,
      );
      info(`Copying ${source} to ${binaryFileName}`);
      cpSync(source, binaryFileName);
    }
  }

  try {
    chmodSync(binaryFileName, 0o755);
  } catch (error) {
    warning(`Failed to chmod ${binaryFileName}: ${error}`);
  }
}

function isCacheEnabled(options: Input): boolean {
  const { version, noCache } = options;
  if (noCache) {
    return false;
  }
  if (!version || /latest|canary|action/i.test(version)) {
    return false;
  }

  const isFeatureAvailable = cache.isFeatureAvailable();
  if (!isFeatureAvailable) {
    warning("Cache service is not available. Skipping cache.");
  } else {
    debug("Cache service is available.");
  }

  return isFeatureAvailable;
}

function getAssetFileName(arch: string, os: string, version: string): string {
  let _os = os;
  let extension = "";
  if (os === "win32") {
    _os = "windows";
    extension = ".exe";
  }
  if (os === "darwin") {
    _os = "macos";
  }
  if (os === "linux") {
    _os = "ubuntu";
  }
  let _arch = arch;
  if (arch === "x64") {
    _arch = "amd64";
  }
  return `gitops_${_os}_${_arch}${extension}`;
}

export async function getVersion(
  binaryFile: string | undefined = undefined,
): Promise<string | undefined> {
  if (!binaryFile) binaryFile = "gitops";
  info(`Checking the version of ${binaryFile}`);
  try {
    const child = spawnSync(binaryFile, ["--version"]);
    const stdout = child.stdout.toString();
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? `${match[1]}` : undefined;
  } catch (error) {
    warning(`Failed to check the version of ${binaryFile}: ${error}`);
    return undefined;
  }
}
