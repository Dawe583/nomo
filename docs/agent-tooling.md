# NOMO agent tooling

Pinned sources live under the ignored `.nomo/tool-cache/` directory. The global
Loop/Graph guide and cross-harness skills live under `~/.agent-instructions/`
and `~/.agents/skills/`. Global Worktrunk and Scrapling executables are on
`PATH`; preserve these pins when refreshing them. Do not commit tool caches.

| Tool | Source revision | NOMO role | Enabled scope |
| --- | --- | --- | --- |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | `3a4bb5b0a008233c85269a0a38a6d08edd4ce329` (`0.5.1`, BSD-3-Clause) | Public web fetch and HTML parsing | CLI plus declared fetcher dependencies; no browser binaries, configured MCP server, credentials or authenticated sessions; policy uses GET |
| [Worktrunk](https://github.com/max-sixty/worktrunk) | `79f19f6407b63044fe7da2d4f3ad4cb9f6adc3a9` (`0.81.0`, MIT OR Apache-2.0) | Git worktree management | Global binary and zsh integration; `.worktrees/` default; activity markers for Claude, Codex, OMP, OpenCode and Pi; no automatic merge or cleanup |
| [DSH Superagent prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) | `8c32a9dc5d72c033816c6a8110b37f40cf94fba4` (`0.1.0`, MIT) | Architecture and implementation reference | Source only; not connected to a GitHub account, Feishu, webhook, or live event |
| [Loop/Graph engineering guide](https://github.com/FlorianBruniaux/claude-code-ultimate-guide/blob/main/guide/core/loop-graph-engineering.md) | `ccf9e0f7bd8102b0bf4566ec640f2991a7a64236` | Cross-harness task method | Full guide cloned at `~/.agent-instructions/sources/claude-code-ultimate-guide/`; summarized into global instructions and skill |

## Install from a fresh cache

Run from a fresh NOMO cache. These commands fetch only pinned source revisions,
install the local tools and install Worktrunk shell integration. They do not
start DSH or contact external project accounts. Preserve an existing
`~/.config/worktrunk/config.toml`; merge the path setting instead of replacing
the file.

```sh
mkdir -p .nomo/tool-cache/sources
git clone https://github.com/D4Vinci/Scrapling .nomo/tool-cache/sources/Scrapling
git -C .nomo/tool-cache/sources/Scrapling checkout --detach 3a4bb5b0a008233c85269a0a38a6d08edd4ce329
git clone https://github.com/max-sixty/worktrunk .nomo/tool-cache/sources/worktrunk
git -C .nomo/tool-cache/sources/worktrunk checkout --detach 79f19f6407b63044fe7da2d4f3ad4cb9f6adc3a9
git clone https://github.com/deepseek-ai/dsh-superagent-prototype .nomo/tool-cache/sources/dsh-superagent-prototype
git -C .nomo/tool-cache/sources/dsh-superagent-prototype checkout --detach 8c32a9dc5d72c033816c6a8110b37f40cf94fba4
mkdir -p ~/.agent-instructions/sources
git clone https://github.com/FlorianBruniaux/claude-code-ultimate-guide ~/.agent-instructions/sources/claude-code-ultimate-guide
git -C ~/.agent-instructions/sources/claude-code-ultimate-guide checkout --detach ccf9e0f7bd8102b0bf4566ec640f2991a7a64236
uv venv .nomo/tool-cache/scrapling-venv
uv pip install --python .nomo/tool-cache/scrapling-venv/bin/python '.nomo/tool-cache/sources/Scrapling[fetchers]' markdownify
cargo install --path .nomo/tool-cache/sources/worktrunk --locked --root .nomo/tool-cache/worktrunk
mkdir -p ~/.config/worktrunk
if [ ! -e ~/.config/worktrunk/config.toml ]; then printf 'worktree-path = ".worktrees/{{ branch | sanitize }}"\n' > ~/.config/worktrunk/config.toml; fi
cargo install --path .nomo/tool-cache/sources/worktrunk --locked --root ~/.local
wt config shell install zsh --yes
wt config plugins claude install --yes
wt config plugins codex install --yes
wt config plugins omp install --yes
wt config plugins opencode install --yes
wt config plugins pi install --yes
```

Install Scrapling globally with the same pinned local source:

```sh
uv tool install --reinstall --python 3.14 \
  --with markdownify --with click --with curl_cffi --with patchright \
  --with playwright --with browserforge --with apify-fingerprint-datapoints \
  --with msgspec --with anyio --with protego \
  .nomo/tool-cache/sources/Scrapling
```

The global command is installed at `~/.local/bin/scrapling`.

Use `scripts/nomo-wt.sh` for Worktrunk commands. For example:

```sh
scripts/nomo-wt.sh list
scripts/nomo-wt.sh switch --create codex/example-task
```

Worktrunk's global user config is `~/.config/worktrunk/config.toml`, with
`worktree-path = ".worktrees/{{ branch | sanitize }}"`. The shell integration
adds one invocation line to `~/.zshrc` so `wt switch` can change directories.
Harness plugins add activity markers to `wt list`; they do not pick branches,
create worktrees or change approval settings.

Scrapling guidance lives in `.agents/skills/nomo-scrapling/SKILL.md`.
Worktrunk guidance lives in `.agents/skills/nomo-worktrunk/SKILL.md`.

## DSH activation boundary

The DSH repository describes itself as a research prototype, not an official
DeepSeek product or production-ready service. Keep it as source reference until
an operator deliberately chooses the target repository, allowed identities,
event triggers, permission policy, credentials and deployment boundary. Do not
run its interactive setup, grant account permissions, configure webhooks or
start proactive listeners as part of local source installation.
