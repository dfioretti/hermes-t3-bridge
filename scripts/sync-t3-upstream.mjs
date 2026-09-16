#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const T3_REPO = "https://github.com/pingdotgg/t3code.git";
const T3_COMMIT = "e8ca3a82806dff84438d5aba66b693468f7ca426";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, ".t3-upstream/t3code");

function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

await mkdir(dirname(target), { recursive: true });
if (!existsSync(resolve(target, ".git"))) {
  await rm(target, { recursive: true, force: true });
  git(["clone", "--filter=blob:none", "--no-checkout", T3_REPO, target]);
}
git(["fetch", "--depth", "1", "origin", T3_COMMIT], target);
git(["checkout", "--detach", T3_COMMIT], target);
console.error(`Synced pingdotgg/t3code contracts/client runtime at ${T3_COMMIT}.`);
