import { readFileSync, realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

// Parses KEY=VALUE lines (dotenv style: comments, quotes, `export`). Returns only valid names.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      const q = v[0];
      v = v.slice(1, -1);
      if (q === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

// Only a ".env"-style file inside the project folder may be read, so a prompt-injected path such as ~/.ssh/id_rsa is refused.
export function readProjectEnvFile(path: string, projectDir = process.cwd()): Record<string, string> {
  const full = realpathSync(resolve(projectDir, path));
  const root = realpathSync(projectDir);
  const name = basename(full);
  if (!(full === root || full.startsWith(root + sep))) throw new Error('The env file must be inside the project folder.');
  if (!/^\.env(\..+)?$/.test(name) && !/\.env$/.test(name)) throw new Error('Only .env-style files can be sent (for example .env.production).');
  return parseEnv(readFileSync(full, 'utf8'));
}
