# NikoStory2: Development Docs

[Guide] [Process] [Planning]

How to write `Dev-XYZ.md` documents in this repository. A DEV is a development plan for a change
to a game module (`src/`, `public/` or `data/`), not a commit message or a general project log.
Naming and lifecycle rules remain in `AGENTS.md`, and the commit format in `docs/COMMITS.md`.

## 1. Required shape

Every Development Doc has these parts, in this order:

1. A title naming the DEV number and the change.
2. One or more development tags, each in square brackets.
3. A concise description of the purpose and intended result.
4. A Todo checklist using Markdown checkboxes.
5. A final `TL;DR` section summarizing the result or intended outcome.

Example of the opening and closing syntax:

```md
# Dev-001: Short, descriptive change title

[Feature] [Engine] [DB]

Explain the problem and the intended outcome in a few sentences.

## 1. Todo

- [ ] Implement the change.
- [ ] Run `npm run check`.

---

## TL;DR

One concise summary of the change.
```

Use the next `Dev-XYZ` number in the repository's development sequence. The `Dev-` prefix and
three-digit number are part of the established filename and title style. Tags describe the kind or
area of work; choose relevant labels rather than copying a fixed list. Observed labels include
`[Feature]`, `[Bugfix]`, `[Architecture]`, `[Migration]`, `[Engine]`, `[World]`, `[Narrator]`,
`[Client]`, `[Data]` and `[Tooling]`.

## 2. Sections and content

There is no mandatory list or fixed order for the body sections. Choose headings that make the
specific change easy to review and implement. Common sections in existing DEVs include:

- **Findings / current state:** measured facts that motivate the change. Distinguish observations
  from proposed decisions.
- **Decisions:** choices and, when useful, their rationale. Mark decisions that still need approval
  as such; do not present an open choice as settled.
- **Scope / changes / stages:** what will be done, grouped by behavior, module or implementation
  stage when that improves clarity.
- **What must not break:** existing contracts the change must preserve, such as the engine being
  the only writer of state, the single `Action` API, the client never simulating, determinism
  through `rngFor`, and migrations staying append-only.
- **Acceptance:** observable conditions that establish completion.
- **Version:** the `package.json` bump and the commit message the work requires, per
  `docs/COMMITS.md`. There is no module-level versioning.
- **Out of scope:** related work explicitly left for later.

Use only sections that help explain the work. A small change may need only a short description,
changes, acceptance and Todo; a large architectural change may need decisions, staged work and
preservation constraints. Do not add boilerplate sections just to match another DEV.

## 3. Markdown syntax and references

- Use a level-one heading for the document title: `# Dev-XYZ: ...`.
- Put development tags on their own line, separated by spaces: `[Feature] [Engine] [DB]`.
- Use Markdown headings for sections. Existing plans commonly number top-level sections (`## 1.`,
  `## 2.`) and use decimal numbering for nested sections (`### 2.1`); number sections when their
  references need stable section numbers.
- Use `- [ ]` for an unfinished Todo item and `- [x]` when it is complete. Keep each item actionable
  and aligned with actual work or verification.
- Keep a section reference local as `[Sec. N]`. For an external section, write `` `X.md` [Sec. N] ``;
  when a filename itself has a section citation, `` `X.md` ([Sec. N]) `` is also used. A bare
  `[Sec. N]` immediately after a filename refers to that file. These forms are a convention, not
  machine-checked: keep them consistent by hand.
- Use fenced code blocks for exact code, commands or structured examples, and inline code for
  identifiers, paths, commands and literals.
- Keep the final section heading exactly `## TL;DR`; place it at the end of the document.

## 4. Acceptance and verification

Each acceptance item identifies how it can be verified: name the relevant test file
(`test/smoke.test.ts`, `test/narrator.test.ts`), identify the visual shot/capture, or label it
`manual` and explain why it cannot or should not be automated. Prefer observable outcomes over
implementation activity. For a multi-module change, cover each affected behavior and any
compatibility or regression constraint that matters.

Record verification results honestly. Keep unfinished checks visible in Todo; do not mark a check
complete merely because code was written. Test files are named for the feature they test, not after
the DEV document. The end-to-end check for any change is `npm run check` (types plus tests).

## 5. Writing practice and lifecycle

- Write in concise, technical English, consistent with the repository's documentation convention.
- State the problem, intended outcome and boundaries before implementation detail. Explain why a
  non-obvious decision matters; avoid repeating the same requirement in several sections.
- Make scope and acceptance specific enough that a different implementer can act without guessing.
  Include rationale where it helps preserve a constraint, not as a running diary.
- Aim for about 200 lines. This is a target for focused plans, not a reason to omit necessary design
  or acceptance detail.
- Keep active plans in `docs/`. When the plan's content is implemented, move it to `docs/done/`.
  That directory holds the finished docs of the current phase, not a living reference.
- Follow the repository's commit and version rules in `docs/COMMITS.md` when the change lands; this
  format guide does not replace them.

---

## TL;DR

A DEV plans a change to a game module (`src/`, `public/`, `data/`). Use the `Dev-XYZ` title,
relevant bracketed tags, concise and fit-for-purpose sections, verifiable acceptance criteria run
through `npm run check`, a checked Todo list and a final `TL;DR`; do not treat optional section
patterns as mandatory.
