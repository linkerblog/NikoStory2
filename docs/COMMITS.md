# NikoStory2 — Commit messages

How every commit message in this repo is written, by any agent or by hand. The rules below can be
pasted as-is into any agent as its commit prompt.

## 1. Format

Output only the message: no extra text, no code fences.

```text
vX.Y.Z

**[<Tag>]**
- [<scope>] <change>
- [<scope>] <change>

**[<Tag>]**
- [<scope>] <change>

**[TL;DR]**
<one line summarizing the whole commit>
```

The first line is the bare version, not bold, so `git log --oneline` reads `100f32d v0.7.0`.

## 2. Version rules

- The previous version is the first line of the latest commit that starts with `v`
  (`git log -1 --format=%s`).
- Bump it by how big the change is, **one level only**, the highest that applies:
  - **X (Major):** breaking changes, incompatible API, data or schema changes, big rewrites.
    Reset Y and Z to 0.
  - **Y (Minor):** new features or backward-compatible upgrades. Reset Z to 0.
  - **Z (Fix):** bug fixes, small tweaks, refactors, docs, config.
- If no previous version exists, use `v0.0.1`.
- Keep the `version` field in `package.json` in sync with the version line. There is no separate
  version file; the latest `v` commit is the project version.
- There is no module-level versioning.

## 3. Tag rules

Group changes under these tags, in this order. Omit any tag with no changes. Each tag appears
once, in bold, with a blank line before it.

| Tag | Use |
|---|---|
| `**[Breaking]**` | Changes that break compatibility |
| `**[Feature]**` | New functionality |
| `**[Upgrade]**` | Improvements to existing functionality |
| `**[Bugfix]**` | Bug fixes |
| `**[Refactor]**` | Restructuring with no behavior change |
| `**[Docs]**` | Documentation |
| `**[Chore]**` | Dependencies, config, build, cleanup |

## 4. Bullet rules

- One change per bullet, starting with `- `.
- Scope in square brackets, then an imperative verb (Add, Fix, Update, Remove...):
  `- [engine] Fix NPC branch on a blocked tile`.
- **Scopes are the source module names** — `db`, `world`, `engine`, `rng`, `narrator`, `game`,
  `server` — plus `client` (`public/`), `data` (`data/`), and `docs`, `tests` and `tooling` for
  files outside every module.
- Use `inline code` for file names, functions, variables and commands.
- At most ~72 characters per bullet.
- Only describe changes present in the diff. Never invent changes.

## 5. Markdown rules

- Allowed: **bold** for tags, `- ` bullets, `inline code`.
- Never start a line with `#`: git strips those lines as comments.
- No headings, tables, links or code blocks.

## 6. TL;DR rules

- A single line, at most 100 characters, describing the overall purpose of the commit.
- When the commit delivers a named feature or task, name it: `Objects`, `Zone generation`.

## 7. Procedure

1. One commit per task. A task too big for one commit is split into smaller tasks, not into
   partial commits.
2. Read the staged diff (`git diff --staged`), never the working tree alone.
3. Compute the version [Sec. 2], keep `package.json` in sync, and stage it.
4. Write the message to a file and commit with `git commit -F <file>`, so bold and blank lines
   survive the shell.
5. Never `--no-verify`, never amend a pushed commit, unless the user asks for it.

## 8. Example

```text
v0.1.0

**[Feature]**
- [engine] Add `examine` action for nearby objects
- [db] Add `object` table and migration `0002_objects`
- [client] Render objects on tiles with one facing

**[Bugfix]**
- [narrator] Fix JSON extraction from fenced responses

**[Docs]**
- [docs] Update `README.md` with the new action list

**[TL;DR]**
Objects become data, with `examine` and object rendering.
```

---

## TL;DR

First line `vX.Y.Z` (bare), then bold tags in fixed order with `- [scope] change` bullets, then a
one-line `**[TL;DR]**`. Bump one semver level from the latest `v` commit and keep `package.json`
in sync in the same commit. Scopes are the source module names. Committed with `git commit -F`.
