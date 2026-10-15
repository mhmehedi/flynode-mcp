import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, readProjectEnvFile } from '../envfile.js';

test('parseEnv handles comments, quotes and export', () => {
  const v = parseEnv('# c\nA=1\nexport B="x y"\nC=\'q\' \nD=val # note\nbad line\n');
  assert.deepEqual(v, { A: '1', B: 'x y', C: 'q', D: 'val' });
});

test('readProjectEnvFile refuses files outside the project and non-env names', () => {
  const root = mkdtempSync(join(tmpdir(), 'fn-'));
  const proj = join(root, 'proj');
  mkdirSync(proj);
  writeFileSync(join(proj, '.env.production'), 'A=1\n');
  writeFileSync(join(proj, 'id_rsa'), 'A=2\n');
  writeFileSync(join(root, '.env'), 'A=3\n');
  assert.deepEqual(readProjectEnvFile('.env.production', proj), { A: '1' });
  assert.throws(() => readProjectEnvFile('id_rsa', proj), /\.env-style/);
  assert.throws(() => readProjectEnvFile('../.env', proj), /inside the project/);
});
