import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileKindFor } from '../adapters/telegram-transport.js';

test('fileKindFor routes voice extensions to voice (the sendVoice bubble)', () => {
  for (const ext of ['.ogg', '.oga', '.opus', '.OGG']) {
    assert.equal(fileKindFor(`/tmp/note${ext}`), 'voice', ext);
  }
});

test('fileKindFor routes image extensions to photo', () => {
  for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.webp']) {
    assert.equal(fileKindFor(`/tmp/img${ext}`), 'photo', ext);
  }
});

test('fileKindFor routes everything else to document', () => {
  for (const f of ['/tmp/report.pdf', '/tmp/data.csv', '/tmp/noext', '/tmp/archive.zip']) {
    assert.equal(fileKindFor(f), 'document', f);
  }
});
