# bmad-dashboard

A Claude Code mod that opens a panel with the state of the BMAD project in the current directory. It reads the project files (`_bmad/`, `_bmad-output/`, `.bmad-loop/`) and refreshes every 15 seconds while the panel is open. With the panel closed it refreshes at most once a minute, and only to keep the status line current. The first read runs in the background, so starting a session does not wait for it.

BMAD v6 and v7 projects are both detected (v6 has `_bmad/_config/manifest.yaml`, v7 has `_bmad/config.toml` and no manifest) and the version shows its layout, as in `6.13.0-next (v7)`. On v7 the modules and version come from the `bmod.toml` files in `.agents/skills/`, plus the `_bmad/<module>/config.yaml` folders (version from its `# Version:` header); the skills come from each `_bmad/<module>/module-help.csv`, or from the `skills` list of `bmod.toml` when a module has no csv. The Sprint tab reads the ticket tree of the active initiative (`core.active_initiative`) by running the project's own `_bmad/method/scripts/tickets.py status` (python3 3.11 or newer, or `uv`): epics, tickets and their progress, with type, risk and blocked reason next to each ticket. Epic titles come from the initiative's `tickets/tickets.toml`; stories without an epic show up as an epic labelled `backlog`. The script only runs for the project the session was started in. When you switch the panel to another project, the Sprint tab says the ticket tree was not read instead of running that project's code. The script's output is reused while the ticket files are unchanged; the `r` button and `/bmad-dashboard refresh` run it again. With no active initiative or no tickets there, the tab stays empty.

## Tabs

1. **Overview**: BMAD version, modules, git, sprint and current epic progress, stories in progress, next story, bmad-loop state and alerts.
2. **Sprint**: epics with progress bars (status is derived from the stories when the YAML lags behind) and each epic's stories, with tasks done/total and open review findings. Dropped or cancelled stories, and every story of a dropped epic, do not count in any progress figure (done over total minus dropped), in the next story or in the lists of work in progress. The epic row says how many were dropped, and they stay in the epic's story list, dimmed, after the live ones. In a v6 project a story is dropped when `sprint-status.yaml` says so or when its spec file does.
3. **Loop**: the current bmad-loop run (status checked against the pid, story and phase, active session, heartbeat, pause, pending decision, tokens), phases, run stories, ATTENTION, journal events, policy and earlier runs.
4. **Planning**: brief, PRD, UX, architecture, epics, research, readiness and specs with their status. Also reviews and addenda, `*-workflow-status.yaml` files (GDS/WDS), unfinished sessions (`.memlog.md`), brainstorming/forge/party mode/CIS/GDS outputs, the WDS design log and Story Automator.
5. **Quality**: TEA artifacts by kind, quality gates (JSON and frontmatter), test review scores, TEA Academy and build-auto results.
6. **Pending**: retro action items, deferred work by severity, review findings, sprint change proposals and specs outside the sprint.
7. **Modules**: project, installed modules, agents, skills by phase, BMB skills and resolved paths.
8. **Projects**: BMAD projects already seen or found by a scan. Picking one switches the panel to it. The scan button shows that it is running and then the result, for example `12 found, 3 new, 1 removed`. A scan also drops saved projects whose `_bmad` folder is gone. At most 200 projects are kept, the most recently seen first.

Lists that do not fit end with a dim `+N more` line. Keys with the panel focused: `1`–`8` switch tabs, `r` refreshes, `p`/`n` move between epics on the Sprint tab and `s` scans for projects on the Projects tab. If you switch project while a refresh is running, a second refresh for the new project starts right after it.

## Command and tool

- `/bmad-dashboard` opens the panel (outside a BMAD project, on the Projects tab). It also takes a tab name, as in `/bmad-dashboard sprint` or `/bmad-dashboard loop`, plus `refresh`, `scan` and `close`. `scan` searches the same folders as the Projects tab and reports what it found.
- The `mcp__bmad-dashboard__status` tool gives the model a short summary by default: name, BMAD version and layout, modules, git, sprint counts, each epic with its status and progress, stories in progress, the next story, the live bmad-loop run, alerts and the number of open deferred work items, action items and review findings. Its `section` argument returns the detail of one part (`project`, `sprint`, `loop`, `planning`, `quality`, `debt`, `modules` or `alerts`), or the whole snapshot with `all`. The output is JSON without indentation.

## Options (`/config`)

| Option | Default | Effect |
| --- | --- | --- |
| `statusLine` | `true` | summary in the status line |
| `autoOpen` | `true` | open the panel when the session starts (on wide terminals) |
| `refreshSeconds` | `15` | re-read interval while the panel is open (at most once a minute when it is closed) |
| `scanRoots` | empty | comma-separated folders the Projects tab and `/bmad-dashboard scan` search; empty entries are ignored, and with none set the scan starts two levels above the current project |

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

CI (`.github/workflows/ci.yml`) runs both on every push to `main` and on pull requests, with Claude Code pinned to the version the mod was built against. The tests cover the file parsers (YAML, TOML, CSV, frontmatter), the collectors, the derived values (`hooks/derive.ts`), the refresh and scan behaviour, the status tool and every tab of the panel over a virtual BMAD project. The tabs are drawn by `hooks/tabs.tsx`; `hooks/register.tsx` holds the state, the refresh loop, the command and the tool.
