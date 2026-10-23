# bmad-dashboard

A Claude Code mod that opens a panel with the state of the BMAD project in the current directory. It reads the project files (`_bmad/`, `_bmad-output/`, `.bmad-loop/`) and refreshes every 15 seconds.

BMAD v6 and v7 projects are both detected (v6 has `_bmad/_config/manifest.yaml`, v7 has `_bmad/config.toml` and no manifest) and the version shows its layout, as in `6.13.0-next (v7)`. On v7 the modules and version come from the `bmod.toml` files in `.agents/skills/`, the skills from each `_bmad/<module>/module-help.csv`. The Sprint tab reads the ticket tree of the active initiative (`core.active_initiative`) by running the project's own `_bmad/method/scripts/tickets.py status` (python3 3.11 or newer, or `uv`): epics, tickets and their progress, with type, risk and blocked reason next to each ticket. Epic titles come from the initiative's `tickets/tickets.toml`. With no active initiative or no tickets there, the tab stays empty.

## Tabs

1. **Overview**: BMAD version, modules, git, sprint and current epic progress, stories in progress, next story, bmad-loop state and alerts.
2. **Sprint**: epics with progress bars (status is derived from the stories when the YAML lags behind) and each epic's stories, with tasks done/total and open review findings.
3. **Loop**: the current bmad-loop run (status checked against the pid, story and phase, active session, heartbeat, pause, pending decision, tokens), phases, run stories, ATTENTION, journal events, policy and earlier runs.
4. **Planning**: brief, PRD, UX, architecture, epics, research, readiness and specs with their status. Also reviews and addenda, `*-workflow-status.yaml` files (GDS/WDS), unfinished sessions (`.memlog.md`), brainstorming/forge/party mode/CIS/GDS outputs, the WDS design log and Story Automator.
5. **Quality**: TEA artifacts by kind, quality gates (JSON and frontmatter), test review scores, TEA Academy and build-auto results.
6. **Pending**: retro action items, deferred work by severity, review findings, sprint change proposals and specs outside the sprint.
7. **Modules**: project, installed modules, agents, skills by phase, BMB skills and resolved paths.
8. **Projects**: BMAD projects already seen or found by a scan. Picking one switches the panel to it.

Keys with the panel focused: `1`–`8` switch tabs, `r` refreshes, `p`/`n` move between epics on the Sprint tab and `s` scans for projects on the Projects tab.

## Command and tool

- `/bmad-dashboard` opens the panel (outside a BMAD project, on the Projects tab). It also takes a tab name, as in `/bmad-dashboard sprint` or `/bmad-dashboard loop`, plus `refresh`, `scan` and `close`.
- The `mcp__bmad-dashboard__status` tool gives the model the full snapshot as JSON, whole or by section.

## Options (`/config`)

| Option | Default | Effect |
| --- | --- | --- |
| `statusLine` | `true` | summary in the status line |
| `autoOpen` | `true` | open the panel when the session starts (on wide terminals) |
| `refreshSeconds` | `15` | re-read interval |
| `scanRoots` | empty | comma-separated folders the Projects tab scans |

## Install

At the prompt of a terminal session:

```
/plugin install bmad-dashboard --marketplace menoncello/bmad-dashboard
```

From a shell:

```
claude plugin install bmad-dashboard --marketplace menoncello/bmad-dashboard
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `menoncello/bmad-dashboard`, then Add plugin.

## Development

```
claude plugin validate .
claude plugin test .
```

CI (`.github/workflows/ci.yml`) runs both on every push to `main` and on pull requests, with Claude Code pinned to the version the mod was built against. The tests cover the file parsers (YAML, TOML, CSV, frontmatter) and draw every tab of the panel over a virtual BMAD project.
