# Agent Harness

A coding agent in the browser. You log in with OpenRouter and pick any tool-capable model, and the agent edits a GitHub repo or a local folder, runs your code, and shows the app it builds in a live preview.

## Using it

1. **Log in with OpenRouter.** You get a key tied to your own OpenRouter account. By default only free models are listed.
2. **Connect a workspace.** Use *Sign in with GitHub* (or a token) and pick a repo, or choose a local folder (Chrome or Edge).
3. **Describe a change.** The agent reads and edits files, runs commands and tests, starts your app, and shows it in the preview pane.
4. **Review and commit.** For GitHub repos, edits wait under *Pending changes* until you, or the agent when you ask, commit them to a branch and open a pull request.

## Agent tools

| Group | Tools |
|---|---|
| Files | `list_files`, `read_file`, `search_files`, `write_file`, `edit_file`, `delete_file` |
| GitHub | `list_changes`, `commit_changes`, `open_pull_request` |
| Running code | `run_command`, `start_server`, `stop_server`, `server_logs`, `http_request`, `save_from_sandbox` |

## Code

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | The page and its UI wiring |
| `agent.js` | The agent loop: model call, tool calls, repeat |
| `tools.js` | Tool definitions and implementations |
| `openrouter.js`, `pkce.js` | OpenRouter login and chat completions |
| `github.js`, `github-auth.js` | GitHub workspace (staged edits, commits, PRs) and sign-in |
| `local.js` | Local-folder workspace (File System Access API) |
| `sandbox-client.js` | Keeps the code runner in sync with the workspace |

Model and tool output is always rendered as text, never as HTML.
