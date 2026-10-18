#!/usr/bin/env node
// A fake `claude` CLI for test/auth.test.js (dev-dc2a; outside test/ so `node --test test/` does not run it): `auth status --json | login --claudeai | logout`,
// modelled on the measured CLI 2.1.302 behaviour without a TTY (service/auth.js header). State lives in
// $CLAUDE_CONFIG_DIR/fake-login.json; every call is appended to fake-calls.jsonl (argv + env names).
// Login: prints the manual URL + the code prompt, hands the automatic URL to $BROWSER, then succeeds on the
// stdin code `good#S` or when the test drops `fake-callback` into the home (the browser callback).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const home = process.env.CLAUDE_CONFIG_DIR;
const state = path.join(home, 'fake-login.json');
const [, , group, cmd] = process.argv;
fs.appendFileSync(path.join(home, 'fake-calls.jsonl'), `${JSON.stringify({
  argv: process.argv.slice(2), env: Object.keys(process.env), CLAUDE_CONFIG_DIR: home, BROWSER: process.env.BROWSER || null,
})}\n`);
const loggedIn = () => fs.existsSync(state);
// the env is allow-listed by the service: a test makes the CLI report another home through a file
const reportHome = () => { try { return fs.readFileSync(path.join(home, 'fake-report-home.txt'), 'utf8'); } catch (e) { return home; } };

if (group === 'auth' && cmd === 'status') {
  const s = { loggedIn: loggedIn(), authMethod: loggedIn() ? 'claude.ai' : 'none', configDirectory: reportHome() };
  if (loggedIn()) Object.assign(s, { email: 'user@example.com', orgName: 'Org', subscriptionType: 'max' });
  process.stdout.write(JSON.stringify(s, null, 2));
  process.exit(s.loggedIn ? 0 : 1);
} else if (group === 'auth' && cmd === 'logout') {
  fs.rmSync(state, { force: true });
  process.stdout.write('Successfully logged out from your Anthropic account.\n');
} else if (group === 'auth' && cmd === 'login') {
  const ok = () => {
    fs.writeFileSync(state, JSON.stringify({ at: Date.now() }));
    process.stdout.write('Login successful.\n');
    process.exit(0);
  };
  process.stdout.write('Opening browser to sign in…\n');
  process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=S\n");
  process.stdout.write('Paste code here if prompted > ');
  if (process.env.BROWSER) {
    spawnSync(process.env.BROWSER, ['"https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A1234%2Fcallback&state=S"'], { shell: true, stdio: 'ignore' });
  }
  setInterval(() => { if (fs.existsSync(path.join(home, 'fake-callback'))) ok(); }, 50);
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === 'good#S') ok();
    process.stdout.write('Login failed: Request failed with status code 400\n');
    process.exit(1);
  });
} else {
  process.exit(2);
}
