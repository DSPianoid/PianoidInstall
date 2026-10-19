/**
 * ops_status (registry-style name `ops.status`, dev-6b34): a READ-ONLY report of the installation, for the
 * operations primer (docs/guides/OPERATIONS_FOR_ASSISTANT.md): per repo the branch, ahead / behind its
 * integration branch as of the LAST fetch (it never fetches), local changes; the installed engine and Basic
 * wheel against the checkout (rebuild needed?); the npm dependencies against their lock files; the
 * assistant's own setup. It never pulls, builds, installs or kills, and runs no git command that writes
 * (GIT_OPTIONAL_LOCKS=0: `git status` does not refresh the index).
 *
 * "Changed since the build" = the files the checkout gained after the build / install time: the diff between
 * where HEAD pointed at that time (the reflog, `HEAD@{<time>}`) and HEAD (the post-pull rebuild gate of
 * BUILD_SYSTEM.md, applied to the install time), plus uncommitted edits written after it. Not file mtimes
 * alone: a `git checkout -- file` (e.g. undoing the Basic build's line-ending rewrite) touches them without a
 * change.
 *
 * It reads the disk, not the backend: it answers with the backend down (the usual case for an update or a
 * start question), and system.environment does not carry ahead / behind or install-vs-checkout.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../lib/registry.js';
import { analysisPaths } from '../analysis/store.js';
import { LAUNCHER } from '../analysis/runPython.js';
import { DOCS_URL } from './docsIndex.js';

export const PRIMER_URL = `${DOCS_URL}/guides/OPERATIONS_FOR_ASSISTANT/`;

// The repos and their integration branches (PROJECT_CONFIG.md#repos; check-updates.ps1 $Repos).
export const REPOS = [
  { name: 'PianoidInstall', rel: '.', integration: 'master' },
  { name: 'PianoidCore', rel: 'PianoidCore', integration: 'dev' },
  { name: 'PianoidBasic', rel: 'PianoidBasic', integration: 'dev' },
  { name: 'PianoidTunner', rel: 'PianoidTunner', integration: 'dev' },
];

// What each build consumes (PROJECT_CONFIG.md#rebuild-matrix; update-repos.bat). Git pathspecs per repo.
export const BUILD_INPUTS = {
  engine: {
    PianoidCore: ['pianoid_cuda/*.cu', 'pianoid_cuda/*.cpp', 'pianoid_cuda/*.cuh', 'pianoid_cuda/*.h', 'pianoid_cuda/setup.py', 'detect_paths.py'],
    PianoidInstall: ['detect_paths.py'],      // build_pianoid_cuda.bat prefers the install root's copy
  },
  basic: { PianoidBasic: ['Pianoid', 'setup.py', 'pyproject.toml'] },
  tunner: { PianoidTunner: ['package.json', 'package-lock.json'] },
  assistant: { PianoidInstall: ['tools/pianoid-assistant/package.json', 'tools/pianoid-assistant/package-lock.json'] },
};
const MTIME_SLACK_MS = 2000;      // a build writes its own inputs (the Basic import rewrite) within the same seconds

export const OPS_STATUS = {
  name: 'ops_status',
  title: 'Read the installation status (repos, builds, dependencies)',
  description: 'Read-only, no network: per repo (PianoidInstall master, PianoidCore / PianoidBasic / PianoidTunner dev) the branch, '
    + 'the short SHA, ahead / behind origin/<integration branch> AS OF THE LAST FETCH (last_fetch; it never fetches), local changes; '
    + 'the installed engine (pianoidCuda release + debug) and Basic wheel with the files changed in the checkout since they were built '
    + '(rebuild needed?); npm dependencies of PianoidTunner and the assistant changed since the last install; the analysis sandbox; '
    + 'and hints naming the procedure (operations primer links). Use it before explaining an update, a rebuild or a start problem. [tier: read]',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  annotations: { title: 'Read the installation status', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
};

/** `git -C dir ...` -> stdout without the trailing newline, or null (not a repo, no git, timeout, non-zero exit). */
export function defaultGit(dir, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], {
      timeout: 5000, windowsHide: true, maxBuffer: 1 << 20,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => resolve(err ? null : String(stdout).replace(/\s+$/, '')));
  });
}

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch (e) { return null; } };
const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; } };
const lines = (out) => (out ? out.split('\n').filter(Boolean) : []);
const repoDir = (root, name) => path.resolve(root, REPOS.find((r) => r.name === name).rel);

/** One repo: {name, path, integration, present, branch, head, ahead, behind, last_fetch, dirty, changed}. */
export async function repoState(root, repo, git = defaultGit) {
  const dir = path.resolve(root, repo.rel);
  const out = { name: repo.name, path: dir, integration: repo.integration };
  if (!fs.existsSync(dir)) return { ...out, present: false };
  const [branch, head] = await Promise.all([git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), git(dir, ['rev-parse', '--short', 'HEAD'])]);
  if (!branch || !head) return { ...out, present: true, error: 'not a git checkout' };
  const [counts, status, common] = await Promise.all([
    git(dir, ['rev-list', '--left-right', '--count', `HEAD...origin/${repo.integration}`]),
    git(dir, ['status', '--porcelain', '--untracked-files=no']),
    git(dir, ['rev-parse', '--git-common-dir']),
  ]);
  const [ahead, behind] = counts && /^\d+\s+\d+$/.test(counts) ? counts.split(/\s+/).map(Number) : [null, null];
  const changed = lines(status).map((l) => l.slice(3));
  const fetchHead = common ? mtime(path.join(path.resolve(dir, common), 'FETCH_HEAD')) : null;
  return {
    ...out, present: true, branch, head, ahead, behind,
    ...(counts ? {} : { compare_error: `origin/${repo.integration} not found locally (never fetched?)` }),
    last_fetch: iso(fetchHead), dirty: changed.length > 0, changed: changed.slice(0, 10),
  };
}

/**
 * The input files of one build changed since `ms` in every repo it reads: committed (HEAD@{ms}..HEAD) or
 * uncommitted and written after `ms`. {files: [repo/file, ...], unknown: [repos that could not be checked]}.
 * A repo whose reflog does not reach `ms` (a newer clone / worktree, an expired reflog) falls back to the
 * mtimes: an input not written since `ms` cannot have changed since; one written later = unknown (a pull or a
 * mere checkout touch cannot be told apart there).
 */
export async function changedSince(root, ms, inputs, git = defaultGit) {
  const out = [];
  const unknown = [];
  const after = (dir, f) => (mtime(path.join(dir, f)) ?? 0) > ms + MTIME_SLACK_MS;
  for (const [name, specs] of Object.entries(inputs)) {
    const dir = repoDir(root, name);
    if (!fs.existsSync(dir)) continue;
    // HEAD@{time} older than the reflog resolves to its OLDEST entry: never use that (it would under-report).
    const [log, then] = await Promise.all([
      git(dir, ['reflog', 'show', '--format=%gd', '--date=unix', 'HEAD']),
      git(dir, ['rev-parse', '--verify', '-q', `HEAD@{${iso(ms)}}`]),
    ]);
    const oldest = Number((/\{(\d+)\}$/.exec(lines(log).pop() || '') || [])[1]) * 1000;
    const [committed, local] = then && oldest <= ms ? await Promise.all([
      git(dir, ['diff', '--name-only', then, 'HEAD', '--', ...specs]),
      git(dir, ['diff', '--name-only', 'HEAD', '--', ...specs]),
    ]) : [null, null];
    if (committed == null) {
      const tracked = await git(dir, ['ls-files', '--', ...specs]);
      if (tracked == null || lines(tracked).some((f) => after(dir, f))) unknown.push(name);
      continue;
    }
    const fresh = lines(local).filter((f) => after(dir, f));
    for (const f of new Set([...lines(committed), ...fresh])) out.push(`${name}/${f}`);
  }
  return { files: out, unknown };
}

/** The venv like the build scripts resolve it: PIANOID_VENV_DIR, .venv-pointer, PianoidCore/.venv (BUILD_SYSTEM.md). */
export function venvDir(coreDir, env = process.env) {
  if (env.PIANOID_VENV_DIR) return env.PIANOID_VENV_DIR;
  try {
    const pointer = fs.readFileSync(path.join(coreDir, '.venv-pointer'), 'utf8').trim();
    if (pointer) return pointer;
  } catch (e) { /* no pointer: the default */ }
  return path.join(coreDir, '.venv');
}

export function sitePackages(venv) {
  const win = path.join(venv, 'Lib', 'site-packages');
  if (fs.existsSync(win)) return win;
  const lib = list(path.join(venv, 'lib')).find((e) => e.isDirectory() && /^python3\.\d+$/.test(e.name));
  return lib ? path.join(venv, 'lib', lib.name, 'site-packages') : null;
}

/** {built, changed_since, rebuild_needed} of one installed artefact (its time = `ms`; null = not installed). */
async function staleness(root, ms, inputs, git) {
  if (ms == null) return { built: null, rebuild_needed: true };
  const { files, unknown } = await changedSince(root, ms, inputs, git);
  return {
    built: iso(ms), changed_since: files.slice(0, 10),
    // a change found is a rebuild; none found is "fine" only when every repo's history reaches the build time
    rebuild_needed: files.length > 0 ? true : unknown.length ? null : false,
    ...(unknown.length ? { unknown: `the git history of ${unknown.join(', ')} does not reach the build time and its inputs were written since (a pull or a checkout touch: not checked)` } : {}),
  };
}

const moduleTime = (site, name) => {
  const e = site && list(site).find((x) => x.isFile() && new RegExp(`^${name}\\.[^.]+\\.(pyd|so)$`).test(x.name));
  return e ? mtime(path.join(site, e.name)) : null;
};

/** The engine: the installed release / debug modules against the compiled sources. */
export async function engineState(root, site, git = defaultGit) {
  const [release, debug] = await Promise.all([
    staleness(root, moduleTime(site, 'pianoidCuda'), BUILD_INPUTS.engine, git),
    staleness(root, moduleTime(site, 'pianoidCuda_debug'), BUILD_INPUTS.engine, git),
  ]);
  return { release, debug };
}

/** The Basic wheel (`Pianoid` in site-packages; its RECORD = the install time) against PianoidBasic. */
export async function basicState(root, site, git = defaultGit) {
  const dist = site && list(site).find((e) => e.isDirectory() && /^pianoid-[\d.]+\.dist-info$/i.test(e.name));
  const at = dist ? mtime(path.join(site, dist.name, 'RECORD')) ?? mtime(path.join(site, dist.name)) : null;
  const state = await staleness(root, at, BUILD_INPUTS.basic, git);
  return { version: dist ? dist.name.replace(/\.dist-info$/i, '').split('-')[1] : null, ...state };
}

/** npm: node_modules/.package-lock.json (npm writes it at every install) = the install time. */
export async function npmState(root, dir, inputs, git = defaultGit) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return { present: false };
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return { present: true, installed: false, needed: true };
  const at = mtime(path.join(dir, 'node_modules', '.package-lock.json'));
  const { built, rebuild_needed: needed, ...rest } = await staleness(root, at, inputs, git);
  return { present: true, installed: true, installed_at: built, ...rest, needed };
}

const hint = (code, message, anchor, extra = {}) => ({ code, message, procedure: `${PRIMER_URL}#${anchor}`, ...extra });
const files = (s) => (s.changed_since?.length ? `: ${s.changed_since.join(', ')}` : '');

/** The precomputed hints (each names the primer section to read). */
export function hints({ repos, engine, basic, tunner, assistant, leftovers }) {
  const out = [];
  for (const r of repos) {
    if (!r.present) { out.push(hint('repo_missing', `${r.name} is not cloned at ${r.path}`, 'new-machine', { repo: r.name })); continue; }
    if (r.error) continue;
    if (r.behind > 0) out.push(hint('update_available', `${r.name} is ${r.behind} commit(s) behind origin/${r.integration} (as of the last fetch ${r.last_fetch ?? 'unknown'})`, 'update', { repo: r.name }));
    if (r.branch !== r.integration) out.push(hint('not_on_integration_branch', `${r.name} is on ${r.branch}, not ${r.integration}: update-repos.bat skips it (it updates only ${r.integration})`, 'update', { repo: r.name }));
    if (r.dirty) out.push(hint('local_changes', `${r.name} has ${r.changed.length}${r.changed.length === 10 ? '+' : ''} changed tracked file(s): ${r.name === 'PianoidInstall' ? 'update-repos.bat skips it' : 'a pull may refuse'}`, 'update', { repo: r.name }));
  }
  if (!engine.release.built) out.push(hint('engine_missing', 'pianoidCuda is not installed in the venv', 'rebuild'));
  else if (engine.release.rebuild_needed) out.push(hint('cuda_rebuild_needed', `compiled sources changed since the engine was built (${engine.release.built})${files(engine.release)}`, 'rebuild'));
  else if (engine.debug.rebuild_needed) out.push(hint('debug_variant_stale', 'the debug engine (pianoidCuda_debug) is missing or older than the compiled sources: rebuild with --both', 'rebuild'));
  if (basic.rebuild_needed) out.push(hint('basic_rebuild_needed', basic.built ? `PianoidBasic changed since the wheel was installed (${basic.built})${files(basic)}` : 'the Pianoid (Basic) wheel is not installed', 'rebuild'));
  if (tunner.present && tunner.needed) out.push(hint('npm_ci_needed', `PianoidTunner dependencies changed since the last npm install, or node_modules is missing${files(tunner)}`, 'symptoms'));
  if (assistant.npm.present && assistant.npm.needed) out.push(hint('assistant_npm_install_needed', `the assistant dependencies changed since the last npm install, or node_modules is missing${files(assistant.npm)}`, 'assistant-setup'));
  if (leftovers.length) out.push(hint('pip_leftovers', `info only: site-packages holds ${leftovers.join(', ')}, folders an earlier pip uninstall left behind; pip skips them ("Ignoring invalid distribution"). Not a rebuild reason on its own: the engine / Basic checks above are what count`, 'gotchas'));
  return out;
}

/** The whole report. `git` / `env` / `sandbox` are injectable for the tests. */
export async function opsStatus({ root = INSTALL_ROOT, git = defaultGit, env = process.env, sandbox = { launcher: LAUNCHER, paths: analysisPaths() } } = {}) {
  const repos = await Promise.all(REPOS.map((r) => repoState(root, r, git)));
  const venv = venvDir(repoDir(root, 'PianoidCore'), env);
  const site = sitePackages(venv);
  const leftovers = site ? list(site).filter((e) => e.isDirectory() && e.name.startsWith('~')).map((e) => e.name) : [];
  const [engine, basic, tunner, assistantNpm] = await Promise.all([
    engineState(root, site, git), basicState(root, site, git),
    npmState(root, repoDir(root, 'PianoidTunner'), BUILD_INPUTS.tunner, git),
    npmState(root, path.join(root, 'tools', 'pianoid-assistant'), BUILD_INPUTS.assistant, git),
  ]);
  const assistant = {
    npm: assistantNpm,
    sandbox: { launcher_built: fs.existsSync(sandbox.launcher), runtime_present: fs.existsSync(path.join(sandbox.paths.runtime, 'python.exe')) },
  };
  const report = { root, venv: { path: venv, present: !!site }, repos, engine, basic, tunner, assistant, leftovers };
  return { ...report, hints: hints(report), primer: PRIMER_URL, note: 'ahead / behind are as of last_fetch: this read never fetches' };
}
