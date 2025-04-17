import { debug, warning } from "@actions/core";
import { info } from "node:console";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve, basename } from "node:path";

export function retry<T>(
  fn: () => Promise<T>,
  retries: number,
  timeout = 10000,
): Promise<T> {
  return fn().catch((err) => {
    if (retries <= 0) {
      throw err;
    }
    return new Promise((resolve) => setTimeout(resolve, timeout)).then(() =>
      retry(fn, retries - 1, timeout),
    );
  });
}

export function addExtension(path: string, ext: string): string {
  if (!path.endsWith(ext)) {
    renameSync(path, path + ext);
    return path + ext;
  }

  return path;
}
