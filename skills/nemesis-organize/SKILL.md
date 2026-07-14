---
name: nemesis-organize
description: Organize the student's Nemesis workspace — notes, folders, flashcard decks, and lecture recordings. Move, rename, group, tidy, and clean up files in the Library so Study/Library/Recorder stay orderly. Use when the student says "organize/clean up/tidy/sort/rename/group/file my notes/decks/folders/recordings/library".
version: 1.3.0
metadata:
  hermes:
    tags: [organize, library, notes, folders, flashcards, decks, recordings, study, nemesis, cleanup]
---

# Organize the Nemesis workspace

The whole workspace is plain files on the student's Mac. The app reads these folders live,
so your changes show up in the Library, Study, and Recorder pages.

**How you touch files (tool choice determines speed):** prefer your built-in file tools
(read_file, write_file, search_files, patch) for single-file operations — they run
instantly. Shell commands (`terminal`) are fine for batch operations like `find` to
survey a folder tree, `cat` to dump several small files, or `mv` to relocate many
files — these do not prompt for approval in the desktop app. Avoid `execute_code`
scripts for file I/O: they freeze the turn on a consent prompt that the user must
explicitly approve, breaking the flow. Use the shell for batch moves and surveys;
use read_file/write_file for individual file reads and writes.

Use this skill when the student asks you to organize, clean up, tidy, sort, rename, group,
or file their notes, folders, flashcard decks, or recordings.

## The layout (memorize this)

```
~/Documents/Nemesis Library/                 ← the vault (notes + decks live here)
  <Folder>/<Note>.md                         ← notes; a subfolder is a "folder" in the UI
  Flashcards/<Deck name>.tsv                 ← one flashcard deck per file (Study page)
  Lectures/<Lecture note>.md                 ← auto-saved recording notes
  School/<Course>/…                          ← files captured from Blackboard/Outlook
  School/calendar.json                       ← the Calendar page's events
~/Documents/Nemesis Recordings/<name>.webm   ← the actual audio recordings
```

- **Notes** are Markdown (`.md`). The subfolder a note sits in IS its "folder" in the
  Library sidebar. Moving a note between folders = moving the file between subdirectories.
- **Flashcard decks** are tab-separated `.tsv` files in `Flashcards/`. The file name is the
  deck name. The first line `# course: <Course>` is what groups decks into a **section** on
  the Study page. See the `nemesis-study-decks` skill for the exact file format.
- **Recordings** are audio files in `~/Documents/Nemesis Recordings/`; each usually has a
  companion note in `Lectures/` that references it by filename (`*Audio: <file>*`).

## Golden rules

1. **Look before you touch.** List the relevant folder first (with your built-in file
   tools, not the shell) and tell the student the plan — what you'll move/rename/delete
   and where — before doing it. For any delete, name the exact files and get a yes.
2. **Move to Trash, don't hard-delete.** Prefer the app's trash (or `mv` into a
   `~/.Trash`-style holding folder) over `rm` so nothing is unrecoverable. Never `rm -rf`.
3. **Keep pairs together.** When you move or rename a recording, move/rename its companion
   `Lectures/` note too, and keep the `*Audio: <file>*` marker line pointing at the right
   filename — otherwise the Recorder page can't match them.
4. **Don't rewrite content while organizing.** Organizing = moving/renaming/grouping files.
   Do not edit the inside of a note or a card as a side effect of tidying.
5. **Quote paths** — these folders have spaces (`Nemesis Library`). Always quote or escape.
6. **Report what you did** in plain English: a short list of what moved where, what was
   renamed, what (if anything) went to Trash.

## Common jobs

### Group notes into folders by course/topic
List loose notes at the vault root, propose a folder scheme (e.g. `Pharmacology/`,
`Cardiology/`, `Infectious disease/`), create the folders (`mkdir -p`), and `mv` each note
in. Confirm the scheme with the student first if it isn't obvious.

**After moving: audit every wikilink in Home.md.** Moving a note into a folder breaks
any bare `[[wikilink]]` that pointed to it (e.g. `[[ACE inhibitors]]` breaks when the
file moves to `Pharmacology/`). The safest approach is to update all wikilinks to
include the folder prefix:

1. Read `Home.md` and extract every `[[wikilink]]` (grep via terminal).
2. For each link, verify it resolves with `[ -f "<link>.md" ]` in the terminal.
3. Patch Home.md: `[[Note]]` → `[[Folder/Note]]` for every broken link.
4. Also check the Priority/This-week section and Reference section — they often
   have bare wikilinks that need the same treatment.
5. **Fix pre-existing broken links too.** You may discover wikilinks to files you
   didn't move (e.g. `[[Heart failure]]` when Heart failure.md was already in
   `Cardiology/` before your changes). Patch those as well — the issue is real even
   though it predates your work.

### Regroup flashcard decks into sections
The Study page's section headers come from each deck's `# course:` line. To move a deck to a
different section, edit ONLY that first line. To rename a deck, rename the `.tsv` file. To
merge two decks, append one file's card lines (not its `# course:` line) onto the other,
then Trash the empty one. Verify the result is still valid TSV (a real TAB between front and
back, `# course:` on line 1).

### Rename / move / retire recordings
Rename the audio file in `Nemesis Recordings/` AND its `Lectures/` companion note together,
fixing the `*Audio: <file>*` marker. To retire an old recording, move both to Trash after
confirming with the student.

### Clean up duplicates and stray files
Find obvious duplicates (same title with ` 2`, `.md.md`, empty files) and propose removing
them. Always list them for the student before removing.

## The knowledge library: Home.md + Vocabulary.md (maintain these)

A pile of well-filed notes is storage; a LIBRARY has a front desk. You maintain two
top-level notes at the vault root that turn the Library into an organized body of knowledge:

**`Home.md` — the front page.** A short, link-dense menu of the whole Library (a map of
content, not an essay — aim for under ~40 lines):
- `# Home` and one orienting line.
- `## Courses` — a block per course folder: 2–5 `[[wikilinks]]` to its most important
  notes (wikilink targets are note TITLES, the filename without `.md`), each with a
  half-line of context.
  - **Wikilinks must include folder prefix** when a note lives in a subfolder that
    is not the root. E.g. `[[Pharmacology/ACE inhibitors]]` not `[[ACE inhibitors]]`
    when the file is at `Pharmacology/ACE inhibitors.md`. The app may resolve bare
    wikilinks across folders inconsistently — always use the full relative path from
    the vault root for reliability.
- `## This week` — links to the notes/decks that matter for upcoming deadlines and exams
  (read them from `.nemesis/graph.json`).
- `## Recent lectures` — the last 2–3 `Lectures/` notes.
- `## Reference` — `[[Vocabulary]]` plus any index notes.

**`Vocabulary.md` — the glossary.** One alphabetized bullet per term the student's material
actually uses: `**term** — one-line plain definition`, with a `[[wikilink]]` to the deeper
note when one exists. Append new terms as they come up in lectures, questions, and decks;
merge duplicates instead of re-adding; keep every definition to a single line.

Rules for both:
- **Read-merge-write.** These notes are student-owned; they may edit them. Never blow away
  their manual lines — update around them.
- **Update as part of the job.** Whenever you organize, import, or add notable material,
  refresh the relevant Home.md block in the same turn (and add new terms to Vocabulary.md).
- If either file doesn't exist yet, create it the first time you organize.
- Log the update to the activity ledger (area "files") like any other write.

### Workflow: build Home.md + Vocabulary.md from scratch

When neither file exists and you're creating them for the first time, follow this
five-phase pipeline. It comes from real use — the survey-and-synthesis pattern is
the main gap agents miss, leaving the front desk empty.

**Phase 1 — Survey the full Library.**
Run these in parallel (independent calls, same turn):
- List every note file: `find ~/Documents/Nemesis\ Library -name '*.md' -not -path '*/\\.*'`
- List every flashcard deck: `ls ~/Documents/Nemesis\ Library/Flashcards/`
- List every lecture note: `ls ~/Documents/Nemesis\ Library/Lectures/`
- Read `.nemesis/graph.json` — extract course names, upcoming exams/assignments
  (their `date` field and `title`), concepts/terms the student is studying.
- Read the ledger `ledger.jsonl` to see its JSONL format before writing entries later.

**Phase 2 — Read every content file.**
For each unique note, mindmap, and flashcard deck:
- Read the file with `read_file` or batched `cat` via terminal.
- Extract all drug names, mechanism terms, adverse effects, monitoring parameters,
  and clinical pearls. Note any wikilinks (`[[...]]`) already present — those become
  the cross-reference targets in Vocabulary.md.
- For flashcard decks: the first line (`# course:`) tells you the course; the Q&A
  pairs contain terms to seed the glossary.
- For mindmaps (under `Mindmaps/`): these often pack condensed exam-specific
  knowledge — prioritize them for glossary extraction.

**Phase 3 — Synthesize.**
- Build the term list: deduplicate, merge synonyms, keep the most student-facing
  definition (the one that connects to their known material — "AT1 receptor" should
  cite "ARBs", not a disembodied physiology text).
- Organize A–Z. Every term gets: `**Term** — one-line definition. [[wikilink]]`
- Build Home.md sections:
  - `## Courses` — one block per course from graph.json. Link the 3–6 most important
    notes per course with a half-line of context.
  - `## This week` — a table of upcoming deadlines from graph.json objects where
    `type` is `exam` or `assignment` and `date` is within ±3 days. Highlight the
    nearest/highest-weight item. Read the `relationships[].to` field for concept
    links to recommend in "Priority" callout.
  - `## Recent lectures` — the last 3 lecture notes by filename date.
  - `## Reference` — `[[Vocabulary]]` plus any Tests/, Exports/, and standalone
    anchor notes (Renal dosing, Vancomycin, Warfarin interactions).

**Phase 4 — Write.**
- Write `Home.md` first, then `Vocabulary.md` (two independent writes).
- Home.md should be ~25–40 lines — a menu, not an essay.
- Vocabulary.md is as long as it needs to be (30–60 terms is typical for a
  1–2 course semester snapshot). Keep definitions to one line.

**Phase 5 — Log to ledger.**
- Read the last few lines of `ledger.jsonl` to confirm the JSONL format.
- Append one entry per file created, matching the existing timestamp style:
  `{"ts":"<ISO timestamp>","action":"Created Home.md — <brief description>","area":"files","wrote":["Home.md"],"sent":false,"submitted":false}`
- For organize/file-move operations, use this template:
  `{"ts":"<ISO timestamp>","action":"Organized Library: created <folders>; moved <N> notes to <folder1>, <N> to <folder2>; trashed <N> test files; updated Home.md wikilinks","area":"files","wrote":["Home.md"],"sent":false,"submitted":false}`

**Pitfalls:**
- Don't write Home.md or Vocabulary.md until you've read every content file. If you
  start writing mid-survey you'll miss terms and end up patching twice.
- Don't invent terms from general pharmacology knowledge — only terms the student's
  own material actually uses. If a protein or pathway isn't mentioned in any note,
  deck, or lecture transcript, don't include it.
- If execute_code is blocked (times out without user consent), fall back to
  individual terminal calls and read_file — slower per-turn but reliable.

## Quality-check the Library (do this after any reorganize, and when asked to "check/audit my library")

A tidy pile of files isn't a library — a library's connections have to actually hold. After
you move things (and whenever the student asks you to check or clean up the Library), run a
structure audit and FIX what you find:

1. **Every [[wikilink]] resolves.** Collect every `[[target]]` across all notes (including
   `Home.md`, `Vocabulary.md`, course overviews). For each, confirm a note with that title —
   or that `Folder/Title` path — exists. A link that points nowhere is either (a) a note you
   should create, or (b) a stale link to fix or remove. Never leave dead links. Note that
   after moving a note into a folder, links to it must become `[[Folder/Title]]` (the app
   resolves path-qualified links).
2. **Important notes aren't orphans.** A note that nothing links to and that links to nothing
   is marooned — the student will never find it. Link it in from `Home.md` or the relevant
   course overview, or from a related note.
3. **The structure makes sense.** Notes live under the right course/topic folder; decks carry
   the right `# course:` line; each course has an Overview note linked from Home; Home's
   "Courses" and "This week" reflect what's actually there. Fix mismatches.
4. **No junk or duplicates.** Empty notes, `.md.md`, ` 2` duplicates, stray test files —
   list them and (with the student's ok) Trash them.

Report the audit plainly: how many links checked, how many were broken and what you did about
each, any orphaned notes you linked in, and anything that needs the student's decision. This
is the "does the web of connections actually make sense?" pass — run it proactively when you
touch the Library, not only when asked.

## After organizing

Tell the student to glance at the Library / Study / Recorder page — it refreshes when the
window regains focus, so their reorganized workspace shows up right away. If something looks
off, you can still see the true state by listing the folders again.
