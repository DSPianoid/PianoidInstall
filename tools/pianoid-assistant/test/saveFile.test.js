// dev-9cff: save_file copies analysis artefacts (WAV / PNG / CSV / ...) out of the private store into the user-visible
// export folder <measurements folder>/assistant_exports (the backend owns the measurements location). Zero spend.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadCommands } from '../lib/registry.js';
import { createPianoidMcpServer } from '../mcp/server.js';
import { LOCAL_READ_TOOLS, listTools } from '../mcp/tools.js';
import { AssistantSession } from '../service/session.js';
import { createArtifact } from '../analysis/store.js';
import { EXPORT_SUBDIR, saveArtifactFiles } from '../analysis/saveFile.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pianoid-save-'));

function fixture() {
  const artifacts = tmp();
  const measurements = tmp();
  const art = createArtifact(artifacts, {
    kind: 'analysis', source: 'test',
    files: [{ name: 'note_online.wav', data: Buffer.from('RIFF....WAVE') }, { name: 'plot.png', data: Buffer.from('png') }],
  });
  return { artifacts, measurements, folder: path.join(measurements, EXPORT_SUBDIR), art };
}

test('saves every file of an artefact, or one, renamed; never overwrites', () => {
  const { artifacts, folder, art } = fixture();
  const all = saveArtifactFiles(artifacts, folder, { artifact_id: art.id });
  assert.deepEqual(all.map((s) => path.basename(s.path)), ['note_online.wav', 'plot.png']);
  assert.equal(fs.readFileSync(all[0].path, 'latin1'), 'RIFF....WAVE');
  const again = saveArtifactFiles(artifacts, folder, { artifact_id: art.id, file: 'note_online.wav' });
  assert.equal(path.basename(again[0].path), 'note_online-1.wav');                 // the first copy is kept
  const named = saveArtifactFiles(artifacts, folder, { artifact_id: art.id, file: 'note_online.wav', name: 'C4_live.mp3' });
  assert.equal(path.basename(named[0].path), 'C4_live.wav');                       // the source's extension wins
  assert.equal(fs.readdirSync(folder).length, 4);
});

test('refuses unknown artefacts / files and any name that is not a plain file name', () => {
  const { artifacts, folder, art } = fixture();
  assert.throws(() => saveArtifactFiles(artifacts, folder, { artifact_id: 'a-20990101000000-abcdef' }), /unknown artefact/);
  assert.throws(() => saveArtifactFiles(artifacts, folder, { artifact_id: '..\\x' }), /unknown artefact/);
  assert.throws(() => saveArtifactFiles(artifacts, folder, { artifact_id: art.id, file: 'meta.json' }), /no file meta.json/);
  for (const name of ['..\\evil.wav', 'sub/x.wav', 'C:\\x.wav', '.hidden.wav']) {
    assert.throws(() => saveArtifactFiles(artifacts, folder, { artifact_id: art.id, file: 'plot.png', name }), /plain file name/, name);
  }
  assert.throws(() => saveArtifactFiles(artifacts, folder, { artifact_id: art.id, name: 'x.wav' }), /one file/);
  assert.equal(fs.existsSync(folder), false);                                     // nothing written on a refusal
});

test('save_file over MCP: the folder comes from GET /measurements/dir; the session allows it without a confirm', async () => {
  const { artifacts, measurements, folder, art } = fixture();
  const commands = loadCommands();
  const tool = listTools(commands).find((t) => t.name === 'save_file');
  assert.ok(tool && tool.annotations.readOnlyHint === false);
  let asked = null;
  const fetchImpl = async (url) => {
    asked = url;
    return { json: async () => ({ measurements_dir: measurements, source: 'default' }) };
  };
  const server = createPianoidMcpServer({ commands, fetchImpl, artifactsDir: artifacts });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const ok = await client.callTool({ name: 'save_file', arguments: { artifact_id: art.id, file: 'plot.png', name: 'spectrum' } });
  const body = JSON.parse(ok.content[0].text);
  assert.equal(ok.isError, false);
  assert.match(asked, /\/measurements\/dir$/);
  assert.equal(body.folder, folder);
  assert.equal(body.saved[0].path, path.join(folder, 'spectrum.png'));
  const bad = await client.callTool({ name: 'save_file', arguments: { artifact_id: art.id, file: 'nope.wav' } });
  assert.equal(bad.isError, true);
  await client.close();

  const down = createPianoidMcpServer({ commands, artifactsDir: artifacts, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await down.connect(c);
  const client2 = new Client({ name: 't', version: '0' });
  await client2.connect(d);
  const err = await client2.callTool({ name: 'save_file', arguments: { artifact_id: art.id } });
  assert.equal(err.isError, true);
  assert.match(JSON.parse(err.content[0].text).error, /measurements\/dir/);
  await client2.close();

  assert.ok(LOCAL_READ_TOOLS.has('save_file'));
  const session = new AssistantSession({ paths: {}, config: {}, commands, driverFactory: () => null });
  const v = await session.canUseTool('mcp__pianoid__save_file', { artifact_id: art.id }, {});
  assert.equal(v.behavior, 'allow');
  assert.equal(session.pending.size, 0);
});
