// A small typed client for the FlyNode API. No dependencies, so the same file serves the MCP server and (later) the CLI.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.flynode.io/api';

export class FlyNodeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface ShipInput {
  name: string;
  projectKey?: string;
  repoUrl?: string;
  gitKeyId?: string;
  gitRepoAddress?: string;
  branch?: string;
  env?: Record<string, string>;
  databases?: string[];
  workspaceId?: string;
  buildPack?: 'nixpacks' | 'dockerfile';
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  port?: string;
  baseDirectory?: string;
}

export interface AppSummary {
  id: string;
  name: string;
  status?: string;
  url?: string | null;
  type?: string;
  config?: { projectKey?: string; githubBranch?: string; githubRepoUrl?: string } | null;
  [key: string]: unknown;
}

// Where the token comes from: FLYNODE_TOKEN, else the file `flynode login` writes (~/.config/flynode/credentials.json).
export function loadCredentials(env = process.env): { token: string; apiUrl: string } {
  let token = env.FLYNODE_TOKEN?.trim();
  let apiUrl = env.FLYNODE_API_URL?.trim();
  if (!token) {
    try {
      const file = JSON.parse(readFileSync(join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'flynode', 'credentials.json'), 'utf8')) as { token?: string; apiUrl?: string };
      token = file.token;
      apiUrl ||= file.apiUrl;
    } catch {
      /* no file */
    }
  }
  if (!token) {
    throw new FlyNodeError('No FlyNode token. Create one in the FlyNode dashboard (Settings > API tokens) and set FLYNODE_TOKEN.', 0);
  }
  return { token, apiUrl: (apiUrl || DEFAULT_API_URL).replace(/\/$/, '') };
}

export class FlyNodeClient {
  constructor(private readonly token: string, private readonly apiUrl = DEFAULT_API_URL) {}

  static fromEnv(env = process.env): FlyNodeClient {
    const c = loadCredentials(env);
    return new FlyNodeClient(c.token, c.apiUrl);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.apiUrl + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', 'user-agent': 'flynode-mcp/0.1' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(130_000),
      });
    } catch (err) {
      throw new FlyNodeError(`Could not reach FlyNode (${err instanceof Error ? err.message : 'network error'}).`, 0);
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const m = (data as { message?: string | string[] } | null)?.message;
      throw new FlyNodeError(Array.isArray(m) ? m.join('; ') : (m ?? `FlyNode answered ${res.status}`), res.status);
    }
    return data as T;
  }

  whoami() {
    return this.request<{ email: string; token: { name: string; scopes: string[]; workspaceId: string | null } }>('GET', '/account/api-tokens/whoami');
  }
  workspaces() {
    return this.request<{ workspaces: { id: string; name: string; status: string; appsUsed: number; plan: { name?: string; maxApps?: number } }[] }>('GET', '/billing/workspaces');
  }
  async listApps(): Promise<AppSummary[]> {
    const r = await this.request<AppSummary[] | { items: AppSummary[] }>('GET', '/deployments');
    return Array.isArray(r) ? r : (r.items ?? []);
  }
  // An app by id, project key or exact name.
  async resolveApp(ref: string): Promise<AppSummary> {
    const apps = await this.listApps();
    const hit = apps.find((a) => a.id === ref) ?? apps.find((a) => a.config?.projectKey === ref) ?? apps.find((a) => a.name === ref);
    if (!hit) throw new FlyNodeError(`No app "${ref}". Known apps: ${apps.map((a) => a.name).join(', ') || 'none'}.`, 404);
    return hit;
  }
  getApp(id: string) {
    return this.request<AppSummary>('GET', `/deployments/${id}`);
  }
  ship(input: ShipInput) {
    return this.request<ShipResult>('POST', '/deployments/ship', input);
  }
  wait(id: string, deployId: string, timeoutSec = 100) {
    return this.request<WaitResult>('GET', `/deployments/${id}/deploys/${deployId}/wait?timeout=${timeoutSec}`);
  }
  health(id: string) {
    return this.request<HealthResult>('GET', `/deployments/${id}/health`);
  }
  deploys(id: string) {
    return this.request<{ deploys: { id: string; status: string; commit?: string; createdAt: string }[] }>('GET', `/deployments/${id}/deploys`);
  }
  deployLog(id: string, deployId: string) {
    return this.request<{ lines: string[]; truncated: boolean; status: string }>('GET', `/deployments/${id}/deploys/${deployId}/log`);
  }
  async runtimeLogs(id: string, lines = 200): Promise<string[]> {
    const r = await this.request<{ logs?: string } | string>('GET', `/deployments/${id}/logs?lines=${lines}`);
    const text = typeof r === 'string' ? r : (r.logs ?? '');
    return text.split('\n').filter((l) => l.length > 0);
  }
  redeploy(id: string) {
    return this.request<unknown>('POST', `/deployments/${id}/redeploy`);
  }
  rollback(id: string, commit: string) {
    return this.request<unknown>('POST', `/deployments/${id}/rollback`, { commit });
  }
  envNames(id: string) {
    return this.request<{ names?: string[]; vars?: { key: string }[] }>('GET', `/deployments/${id}/env-names`);
  }
  setEnv(id: string, set: Record<string, string>, redeploy: boolean) {
    return this.request<{ vars: { key: string }[] }>('PUT', `/deployments/${id}/env`, { set, redeploy });
  }
  addDatabase(id: string, engine: string) {
    return this.request<unknown>('POST', `/deployments/${id}/app-databases`, { engine, connectApp: true });
  }
  addDomain(id: string, domain: string) {
    return this.request<unknown>('PATCH', `/deployments/${id}/domain`, { domain });
  }
  deleteApp(id: string) {
    return this.request<unknown>('DELETE', `/deployments/${id}`);
  }
}

export interface ShipResult {
  id: string;
  name: string;
  projectKey: string;
  branch: string | null;
  detected: unknown;
  created: boolean;
  deployId: string | null;
  status: string;
  url: string | null;
}
export interface WaitResult {
  id: string;
  deployId: string;
  status: 'building' | 'live' | 'failed' | 'cancelled' | string;
  done: boolean;
  url: string | null;
  commit?: string;
  logTail: string[];
  hints: { code: string; message: string; lines?: string[] }[];
}
export interface HealthResult {
  ok: boolean;
  url?: string;
  httpStatus?: number;
  ms?: number;
  title?: string | null;
  reason?: string;
}

// "flynode login": ask for a code, let the person approve it in the browser, then collect the token.
export async function deviceLogin(apiUrl: string, clientName: string, show: (verifyUrl: string, userCode: string) => void): Promise<string> {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await fetch(apiUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new FlyNodeError(`FlyNode answered ${res.status}`, res.status);
    return (await res.json()) as T;
  };
  const started = await post<{ deviceCode: string; userCode: string; verifyUrl: string; expiresIn: number; interval: number }>('/auth/device/start', { clientName });
  show(started.verifyUrl, started.userCode);
  const until = Date.now() + started.expiresIn * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, started.interval * 1000));
    const r = await post<{ status: string; token?: string }>('/auth/device/poll', { deviceCode: started.deviceCode });
    if (r.status === 'approved' && r.token) return r.token;
    if (r.status === 'denied') throw new FlyNodeError('The request was denied in the browser.', 0);
    if (r.status === 'expired' || r.status === 'invalid') throw new FlyNodeError('The code expired. Run the command again.', 0);
  }
  throw new FlyNodeError('Timed out waiting for approval.', 0);
}
