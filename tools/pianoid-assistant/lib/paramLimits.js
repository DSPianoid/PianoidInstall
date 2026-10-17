/**
 * The A2 envelope limits, read from the parameter inventory (PianoidInstall schemas/params): every
 * `envelope` entry of a field (`<domain>.<field>`) or a mask domain, plus `_index.json` `envelope`
 * (the per-command / per-turn bounds and the level-breach rule). `$PIANOID_PARAMS_DIR`, else
 * `params` next to the command registry dir (the same rule as Core's param.inventory). A missing
 * inventory throws (fail fast: no inventory = no envelope).
 */
import fs from 'node:fs';
import path from 'node:path';
import { commandsDir } from './registry.js';

export function paramsDir(env = process.env) {
  return env.PIANOID_PARAMS_DIR || path.join(path.dirname(commandsDir(env)), 'params');
}

export function loadLimits(dir = paramsDir()) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!fs.existsSync(path.join(dir, '_index.json'))) throw new Error(`parameter inventory not found: ${dir} (set PIANOID_PARAMS_DIR)`);
  const index = read('_index.json');
  if (!index.envelope) throw new Error(`${dir}/_index.json has no envelope section`);
  const fields = {};
  const masks = new Set();
  for (const file of index.files) {
    for (const dom of read(file).domains) {
      if (dom.envelope?.kind === 'mask') dom.envelope.commands.forEach((c) => masks.add(c));
      for (const f of dom.fields || []) if (f.envelope) fields[`${dom.domain}.${f.name}`] = f.envelope;
    }
  }
  return { global: index.envelope, fields, masks };
}
