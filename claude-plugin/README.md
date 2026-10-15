# FlyNode plugin for Claude Code

Adds the FlyNode MCP server, a `/flynode:deploy` command and the `deploy-to-flynode` skill.

1. Create a token in the FlyNode dashboard (Settings > API tokens, "Deploy" template) and export it: `export FLYNODE_TOKEN=fn_live_...`
2. Install the plugin (from this folder: `claude --plugin-dir ./packages/claude-plugin`, or from a marketplace once published).
3. In any project: "deploy this to FlyNode" or `/flynode:deploy`.

Add to a project's `CLAUDE.md` if you want it always on:

> Deploy with the flynode tools. Never print secrets; send .env files with flynode_set_env_from_file. Never delete apps without the user typing the name.
