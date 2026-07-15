---
name: nemesis-import
description: Migrate a student's existing school life into the Library — agent-led, propose-then-execute, never manual labor
---

# Importing the student's existing world

Posture: the student should never do work you can do. You find, you fetch, you convert,
you file. They approve. Copy, never move; never delete originals. Log every batch in the
activity ledger (nemesis-ledger). Update the semester graph (nemesis-graph) after ingest.

## 1. Local discovery — "Find my school files" (ALWAYS scan for Anki too)
Search ONLY these locations (never the whole disk):
`~/Documents`, `~/Desktop`, `~/Downloads`, and cloud-synced folders under
`~/Library/CloudStorage/` (OneDrive-*, GoogleDrive-*).

Discover TWO things in this pass — coursework files AND existing flashcards — and report
both together, because the student expects you to find their study materials without being
told where they are:

**a) Coursework files.** pdf/pptx/docx/md whose names or paths suggest coursework (course
codes like "PHCY 1205", words like syllabus, lecture, slides, exam, notes; modified within
the current school year).

**b) Anki + exported decks (do this every time, even if they didn't mention Anki).**
- Check whether Anki is installed and has collections: list
  `~/Library/Application Support/Anki2/` — every subfolder that is NOT `addons21` and
  contains a `collection.anki2` is a user profile with cards. Report it: "You have an Anki
  collection (profile '<name>') — want me to bring those cards in with their study history?"
- Glob `~/Downloads` and `~/Desktop` for exported decks: `*.apkg`, `*.colpkg` (Anki) and
  loose `*.tsv`/`*.csv` that look like term/definition pairs (Quizlet exports). Offer to import.

Then:
1) PROPOSE: one short summary covering BOTH — coursework counts by course, plus any Anki
   collection / .apkg / export files found — and ask which to bring in.
2) EXECUTE on approval: copy coursework into the right course folders
   (`<Course>/Slides`, `<Course>/Syllabus`, `<Course>/Notes`, else `Imports/`); import Anki
   per section 2 below.
macOS may show one-time permission dialogs on first access — tell the student that's
Apple asking, and it's expected.

## 2. Anki — read their real collection, keep their history
Anki stores everything locally at
`~/Library/Application Support/Anki2/<profile>/collection.anki2` (SQLite).
1) Ask the student to quit Anki first. 2) COPY the file to a temp path — never open the
original. 3) Use the `sqlite3` CLI (ships with macOS) to read decks, notes, cards:
- decks/notetypes live in JSON columns of `col` (older) or `decks`/`notetypes` tables (newer)
- `notes.flds` fields are separated by the 0x1F unit-separator character
- `revlog` holds review history — use recency/lapses per card to seed a rough mastery
Write each Anki deck as a Nemesis deck `.tsv` in the Library's `Flashcards/` folder (NOT
`Decks/` — the Study page reads `Flashcards/`), with `# course: <Course>` as line 1 so it
groups under the right section (see nemesis-study-decks for the exact format). Note the
seeded mastery in the graph, and report exactly how many decks/cards came over. If the
schema defeats you, fall back to asking for a File → Export `.apkg` and say why.

## 3. Quizlet — via THEIR export, never by scraping
Quizlet bot-blocks automated browsers (verified live 2026-07-14: instant CAPTCHA), so
don't browse it — the export feature is the whole path:
- Walk the student through it: open the set → ⋯ menu → "Export text" (tab-delimited) →
  copy or save; they paste it to you or drop the file in Downloads.
- Convert each export into a Nemesis deck `.tsv` exactly like an Anki import (§2).
- ONLY sets they own or can view. If they have many sets, they repeat export per set —
  it's their content on their account; you do all the conversion work.
- If any CAPTCHA/verification appears anywhere, STOP and ask the student to complete it
  themselves. You never solve CAPTCHAs, and you never retry around a bot-wall.

## 4. Notes from Notion / Google Docs / Word / OneNote
- Notion: their Export (Markdown & CSV zip) → unzip, strip the hash suffixes Notion adds
  to filenames, file the `.md` into course folders.
- Google Docs: download as Markdown or `.docx` (or walk their Drive in the browser and
  download what they point at).
- Word `.docx`: convert with macOS `textutil -convert html` then to markdown text for
  notes; keep the original beside it.
- OneNote: no clean export exists — open OneNote web in the browser and save pages out,
  or accept PDFs. Be honest that this one is slower; Microsoft's fault, not theirs.

## Rules
- Propose before big batches; execute without re-asking for the approved batch.
- Copies only. Originals untouched. Everything logged. `sent`/`submitted` stay false.
- After any import: refresh graph objects (courses, concepts) so Today reflects it.
