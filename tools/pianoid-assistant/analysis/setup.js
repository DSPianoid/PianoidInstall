#!/usr/bin/env node
/**
 * One-time, idempotent setup of the analysis sandbox (assistant v2 P5), no admin:
 *   1. build sandbox/launcher/PianoidSandbox.exe with build.bat if it is missing (or --rebuild);
 *   2. check the private Python runtime (%USERPROFILE%\.pianoid-assistant\analysis\runtime\python.exe);
 *      recreating it is a manual step: README "Analysis sandbox";
 *   3. create the AppContainer profile `pianoid.analysis` and grant it ReadAndExecute on the runtime
 *      (`PianoidSandbox.exe setup`; skipped when the ACE is already there);
 *   4. create runs\ and artifacts\.
 *   node analysis/setup.js [--rebuild]      prints one JSON line
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analysisPaths } from './store.js';
import { LAUNCHER, PROFILE } from './runPython.js';

export function setupSandbox({ paths = analysisPaths(), launcher = LAUNCHER, rebuild = false, exec = execFileSync } = {}) {
  const out = { launcher, profile: PROFILE, runtime: paths.runtime };
  if (rebuild || !fs.existsSync(launcher)) {
    exec('cmd.exe', ['/c', path.join(path.dirname(launcher), 'build.bat')], { stdio: 'pipe', windowsHide: true });
    out.built = true;
  }
  if (!fs.existsSync(launcher)) throw new Error(`launcher build failed: ${launcher} missing`);
  if (!fs.existsSync(path.join(paths.runtime, 'python.exe'))) {
    throw new Error(`analysis runtime missing: ${paths.runtime}\\python.exe (recreate it: README "Analysis sandbox")`);
  }
  const res = JSON.parse(String(exec(launcher, ['setup', '--profile', PROFILE, '--grant-rx', paths.runtime], { windowsHide: true })).trim());
  for (const d of [paths.runs, paths.artifacts]) fs.mkdirSync(d, { recursive: true });
  return { ...out, sid: res.sid, container_folder: res.container_folder, granted_rx: res.granted_rx, already_rx: res.already_rx };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    console.log(JSON.stringify(setupSandbox({ rebuild: process.argv.includes('--rebuild') })));
  } catch (e) {
    console.error(`[analysis setup] ${e.message}`);
    process.exit(1);
  }
}
