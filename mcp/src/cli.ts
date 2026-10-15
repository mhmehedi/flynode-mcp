#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_API_URL, deviceLogin, FlyNodeClient, FlyNodeError, loadCredentials, ShipInput } from './client.js';
import { readProjectEnvFile } from './envfile.js';

const HELP = `flynode - deploy to FlyNode from your terminal

  flynode login [--token fn_live_...]   sign in through the browser (or save a token you made in the dashboard)
  flynode logout                        forget the saved token
  flynode whoami
  flynode apps                          list your apps
  flynode init [name]                   write .flynode.json for this folder
  flynode deploy [--db mysql,redis] [--env-file .env.production] [--branch b] [--no-wait]
  flynode status
  flynode logs [-f] [--build] [--lines 200]
  flynode env list                      variable names (values are never shown)
  flynode env push [file]               send a local .env file (default .env.production)
  flynode open                          open the app in the browser
  flynode rollback <commit>
  flynode redeploy

Token: FLYNODE_TOKEN, or the file written by "flynode login". API: FLYNODE_API_URL.`;

const credFile = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'flynode', 'credentials.json');
const projectFile = () => join(process.cwd(), '.flynode.json');
const out = (s = '') => process.stdout.write(s + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Project {
  app?: string;
  projectKey?: string;
  workspaceId?: string;
  branch?: string;
  databases?: string[];
}
function readProject(): Project {
  try {
    return JSON.parse(readFileSync(projectFile(), 'utf8')) as Project;
  } catch {
    return {};
  }
}
const git = (...args: string[]) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-') && ['token', 'db', 'env-file', 'branch', 'lines'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-f') flags.f = true;
    else pos.push(a);
  }
  return { flags, pos };
}

// A Git remote as an https URL FlyNode can clone. Private repositories need a deploy key, so an ssh address is refused with a clear hint.
function repoUrl(): string {
  const raw = git('remote', 'get-url', 'origin');
  if (!raw) throw new FlyNodeError('This folder has no Git remote. Create one (for example "gh repo create --private --source . --push"), then run again.', 0);
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(raw);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return raw.replace(/\.git$/, '').replace(/^(https?:\/\/)[^@/]+@/, '$1');
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

async function appRef(c: FlyNodeClient) {
  const p = readProject();
  const ref = p.projectKey ?? p.app;
  if (!ref) throw new FlyNodeError('No .flynode.json here. Run "flynode deploy" or "flynode init" first.', 0);
  return c.resolveApp(ref);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return out(HELP);

  if (cmd === 'login') {
    const apiUrl = (process.env.FLYNODE_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
    let token = typeof flags.token === 'string' ? flags.token : '';
    if (!token) {
      token = await deviceLogin(apiUrl, `FlyNode CLI on ${hostname().slice(0, 30)}`, (url, code) => {
        out(`Open this link and approve the request:\n  ${url}\nCode: ${code}\nWaiting for approval...`);
        openBrowser(url);
      });
    }
    mkdirSync(dirname(credFile()), { recursive: true, mode: 0o700 });
    writeFileSync(credFile(), JSON.stringify({ token, apiUrl }, null, 2), { mode: 0o600 });
    const who = await new FlyNodeClient(token, apiUrl).whoami();
    return out(`Signed in as ${who.email} (${who.token?.scopes.join(', ')}). Token saved to ${credFile()}`);
  }
  if (cmd === 'logout') {
    if (existsSync(credFile())) unlinkSync(credFile());
    return out('Signed out. (Revoke the token in Settings > API tokens if it should stop working everywhere.)');
  }

  const creds = loadCredentials();
  const c = new FlyNodeClient(creds.token, creds.apiUrl);

  switch (cmd) {
    case 'whoami': {
      const w = await c.whoami();
      return out(`${w.email}\ntoken: ${w.token?.name} [${w.token?.scopes.join(', ')}]${w.token?.workspaceId ? ` workspace ${w.token.workspaceId}` : ''}`);
    }
    case 'apps': {
      for (const a of await c.listApps()) out(`${a.name.padEnd(28)} ${String(a.status ?? '').padEnd(10)} ${a.url ?? ''}`);
      return;
    }
    case 'init': {
      const name = pos[0] ?? basename(process.cwd()).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 50);
      writeFileSync(projectFile(), JSON.stringify({ ...readProject(), app: name }, null, 2) + '\n');
      return out(`Wrote .flynode.json for "${name}". Commit it so teammates deploy to the same app.`);
    }
    case 'deploy': {
      const p = readProject();
      const name = p.app ?? basename(process.cwd()).toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 50);
      const branch = typeof flags.branch === 'string' ? flags.branch : (p.branch ?? (git('rev-parse', '--abbrev-ref', 'HEAD') || undefined));
      if (git('status', '--porcelain')) out('Note: you have uncommitted changes. FlyNode builds what is pushed to Git, not your working folder.');
      if (branch && git('log', `origin/${branch}..HEAD`, '--oneline')) out(`Note: ${branch} has commits that are not pushed yet. Push first.`);
      const dbs = typeof flags.db === 'string' ? flags.db.split(',').map((s) => s.trim()).filter(Boolean) : p.databases;
      const input: ShipInput = { name, projectKey: p.projectKey, workspaceId: p.workspaceId, repoUrl: repoUrl(), branch, databases: dbs };
      if (typeof flags['env-file'] === 'string') input.env = readProjectEnvFile(flags['env-file']);
      out(`Deploying ${name}${branch ? ` (${branch})` : ''}...`);
      const s = await c.ship(input);
      writeFileSync(projectFile(), JSON.stringify({ ...p, app: name, projectKey: s.projectKey, branch: p.branch }, null, 2) + '\n');
      out(s.created ? 'Created the app.' : 'Updating the existing app.');
      if (flags['no-wait'] || !s.deployId) return out(`Started. Check with: flynode status`);
      for (;;) {
        const w = await c.wait(s.id, s.deployId, 50);
        if (!w.done) {
          out('  building...');
          continue;
        }
        if (w.status === 'live') {
          const h = await c.health(s.id).catch(() => null);
          out(`Live: ${w.url}${h ? `  (HTTP ${h.httpStatus ?? '-'}, ${h.ok ? 'ok' : 'not answering yet'})` : ''}`);
          return;
        }
        out(`Deploy ${w.status}.`);
        for (const h of w.hints) out(`  hint [${h.code}]: ${h.message}`);
        out(w.logTail.slice(-25).join('\n'));
        process.exitCode = 1;
        return;
      }
    }
    case 'status': {
      const a = await appRef(c);
      const [d, h] = await Promise.all([c.deploys(a.id).catch(() => null), c.health(a.id).catch(() => null)]);
      out(`${a.name}  ${a.status ?? ''}  ${a.url ?? ''}`);
      if (h) out(`health: ${h.ok ? 'ok' : 'not ok'} ${h.httpStatus ?? ''} ${h.reason ?? ''}`.trim());
      for (const x of d?.deploys.slice(0, 5) ?? []) out(`  ${x.status.padEnd(10)} ${(x.commit ?? '').slice(0, 8)} ${x.createdAt}`);
      return;
    }
    case 'logs': {
      const a = await appRef(c);
      if (flags.build) {
        const id = (await c.deploys(a.id)).deploys[0]?.id;
        if (!id) throw new FlyNodeError('No deploys yet.', 0);
        return out((await c.deployLog(a.id, id)).lines.join('\n'));
      }
      const n = Number(flags.lines) || 200;
      let last = '';
      for (let first = true; ; first = false) {
        const lines = await c.runtimeLogs(a.id, first ? n : 100);
        const at = last ? lines.lastIndexOf(last) : -1;
        const fresh = at >= 0 ? lines.slice(at + 1) : lines;
        if (fresh.length) {
          out(fresh.join('\n'));
          last = fresh[fresh.length - 1];
        }
        if (!flags.f) return;
        await sleep(3000);
      }
    }
    case 'env': {
      const a = await appRef(c);
      if (pos[0] === 'list') {
        const r = await c.envNames(a.id);
        return out((r.names ?? r.vars?.map((v) => v.key) ?? []).join('\n'));
      }
      if (pos[0] === 'push') {
        const vars = readProjectEnvFile(pos[1] ?? '.env.production');
        if (!Object.keys(vars).length) throw new FlyNodeError('No KEY=VALUE lines in that file.', 0);
        await c.setEnv(a.id, vars, true);
        return out(`Sent ${Object.keys(vars).length} variables (${Object.keys(vars).join(', ')}) and started a redeploy.`);
      }
      throw new FlyNodeError('Use: flynode env list | flynode env push [file]. Values cannot be pulled: tokens never read secrets.', 0);
    }
    case 'open': {
      const a = await appRef(c);
      if (!a.url) throw new FlyNodeError('The app has no address yet.', 0);
      openBrowser(a.url);
      return out(a.url);
    }
    case 'redeploy': {
      const a = await appRef(c);
      await c.redeploy(a.id);
      return out('Redeploy started. Follow it with: flynode status');
    }
    case 'rollback': {
      if (!pos[0]) throw new FlyNodeError('Give the commit to go back to (see "flynode status").', 0);
      const a = await appRef(c);
      await c.rollback(a.id, pos[0]);
      return out('Rollback started. Follow it with: flynode status');
    }
    default:
      out(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`flynode: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
