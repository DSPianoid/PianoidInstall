/**
 * The command registry (PianoidInstall schemas/commands, SSOT I4) as the assistant sees it.
 * `$PIANOID_COMMANDS_DIR`, else <PianoidInstall>/schemas/commands (this file lives in
 * PianoidInstall/tools/pianoid-assistant/lib). A missing registry throws (fail fast).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INSTALL_ROOT = path.resolve(HERE, '..', '..', '..');

export function commandsDir(env = process.env) {
  return env.PIANOID_COMMANDS_DIR || path.join(INSTALL_ROOT, 'schemas', 'commands');
}

/** [record + family] of every registry command, sorted by name. */
export function loadCommands(dir = commandsDir()) {
  if (!fs.existsSync(dir)) throw new Error(`command registry not found: ${dir} (set PIANOID_COMMANDS_DIR)`);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .flatMap((f) => {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return doc.commands.map((c) => ({ ...c, family: doc.family }));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** MCP / Claude tool name of a command (dots are not allowed in tool names). */
export const toolName = (command) => command.replace(/\./g, '__');
export const commandName = (tool) => tool.replace(/__/g, '.');
