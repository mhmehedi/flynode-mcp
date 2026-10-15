# @flynode/mcp

MCP server for [FlyNode](https://flynode.io). Lets Claude (or any MCP client) deploy the project in your folder to FlyNode, watch the build, read logs and check that the app is live.

## Setup

1. In the FlyNode dashboard open Settings > API tokens and create a token (the "Deploy" template is enough).
2. Add the server to Claude Code:

```bash
claude mcp add flynode --env FLYNODE_TOKEN=fn_live_xxx -- npx -y @flynode/mcp
```

Then say: "deploy this project to FlyNode".

## Tools

`flynode_ship` (create/update + build + wait + health check), `flynode_wait`, `flynode_status`, `flynode_logs`, `flynode_redeploy`, `flynode_rollback`, `flynode_list_apps`, `flynode_list_workspaces`, `flynode_list_env` (names only), `flynode_set_env_from_file` (sends a local .env file; values never enter the conversation), `flynode_add_database`, `flynode_add_domain`, `flynode_delete_app` (needs a token with the destroy scope and the typed app name), `flynode_whoami`. Prompt: `deploy_this_project`.

## Safety

- The server only talks to the FlyNode API with your token. Tokens cannot read secret values, change billing or manage the account.
- Build and runtime logs are returned fenced as untrusted data.
- `flynode_set_env_from_file` only reads `.env`-style files inside the project folder.
- `.flynode.json` in the project folder remembers the app so the next deploy needs no questions.

Environment: `FLYNODE_TOKEN`, optional `FLYNODE_API_URL`, `FLYNODE_PROJECT_DIR`.

## CLI

The same package installs a `flynode` command (`npm i -g @flynode/mcp`, or `npx -p @flynode/mcp flynode ...`):

```bash
flynode login              # opens the browser, approve once, token saved to ~/.config/flynode
flynode deploy             # build from the Git remote, wait, check the address
flynode logs -f            # follow runtime logs (--build for the build log)
flynode env push .env.production
flynode status | open | redeploy | rollback <commit> | apps | env list
```

In CI set `FLYNODE_TOKEN` instead of logging in. Values cannot be pulled back (tokens never read secrets).
