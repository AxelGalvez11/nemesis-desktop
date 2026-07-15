---
name: nemesis-school-sync
description: "THE flagship workflow: sync the student's school world end-to-end. Sweep Blackboard + Outlook (read-only, via the school browser), capture new lectures/slides/attachments into the Library, then INTELLIGENTLY produce structured lecture notes and exam-grade flashcards from the new material, and update the semester graph, calendar, Home page, and ledger. Use when the student says 'sync my school', 'check blackboard/outlook', 'what's new in my courses', 'catch me up', or asks for their daily brief."
version: 1.4.0
metadata:
  hermes:
    tags: [school, sync, blackboard, outlook, lectures, notes, flashcards, daily-brief, pipeline, nemesis]
    related_skills: [school-portal, nemesis-import, nemesis-study-decks, nemesis-organize, nemesis-graph, nemesis-ledger, nemesis-email]
---

# School sync — the main loop

This is the product's core promise: the student logs into their portals ONCE (their
cookies live in the school browser), and from then on one command keeps their whole
academic world current — files captured, notes written, flashcards made, deadlines on
the calendar. You run the pipeline; the student just studies.

Portals have no APIs. The school browser IS the integration: navigate it read-only.

## The student's own portals (read this FIRST — do NOT hardcode a school)

Every student is at a different university, so **their** LMS and email addresses live in
`~/Documents/Nemesis Library/.nemesis/portals.json` — created by YOU the first time the
student names their school sites in chat (ask, then write it; format and rules in the
school-portal skill). Read it at the start of every sync and use those exact URLs:

```json
{ "portals": [
  { "kind": "lms",   "name": "Canvas",  "url": "https://canvas.myschool.edu/" },
  { "kind": "email", "name": "Outlook", "url": "https://outlook.cloud.microsoft/mail/" }
] }
```

- The `lms` entry may be Blackboard, Canvas, Brightspace, Moodle, Schoology, or anything
  else — navigate to its `url`, then apply the matching pattern from the school-portal
  skill (which covers the major LMS families).
- If the file is missing or has no `lms` entry, don't guess a URL: ask the student in chat
  for their school's course-site address and write `portals.json` yourself (per the
  school-portal skill), then continue the sync. Any Blackboard address that appears
  throughout these skills is just a reference example — never assume it is *this* student's school.

## Hard rules (before anything)

- **Read-only on portals.** Never submit, upload, mark-read, delete, or change settings
  on Blackboard/Outlook. You are a reader there.
- **Login walls and CAPTCHAs are the student's.** If a portal shows a login page or a
  CAPTCHA, STOP that portal's sweep and tell the student plainly: "Blackboard needs you
  to log in once in the browser panel — then say 'sync my school' again." Never ask for
  or type credentials.
- **When login walls block BOTH portals (session expired):** Do NOT skip the rest of
  the pipeline. You still need to (a) read the existing local state (graph.json, Home.md,
  Library) and report what is current, (b) write the state file with this attempt's
  timestamp as lastRun — prevents wasted re-attempts before the student logs in, and
  (c) log a ledger entry for the attempted sync (area: browse). If only ONE portal needs
  login, continue with the other — do not bail on both.
- **State file:** `~/Documents/Nemesis Library/.nemesis/school-sync.json` —
  `{ "lastRun": ISO, "seen": { "<stable item id or URL>": ISO } }`. Read it first;
  only process items NOT in `seen`; write it back at the end (read-merge-write).
- **Cap the batch.** Process at most 5 new lecture files' worth of notes+flashcards per
  run. If more are new, capture ALL files but queue the rest for the next sync and say
  so ("Captured 9 new files; made notes for the 5 most recent — run sync again for the
  rest.").
- Ledger-log every capture and every produced artifact (nemesis-ledger; sent/submitted
  always false). Batch lookups and page-reads in the same turn wherever possible.
- **Budget the sweep.** Extract in bulk (Phase 1) and build from digests (Phase 3) so a
  full sync stays in the tens-of-steps range. If the browser half balloons past ~25 steps
  without progress, stop, save what you have, and tell the student what's left — never loop.

## Phase 1 — Sweep (read-only)

Navigate to the URLs from `portals.json` (above), per the school-portal skill's notes:
- **The LMS** (`kind: "lms"` — Blackboard/Canvas/Brightspace/…): for each course the
  student takes — new announcements, new files under Content/Course Documents (slides,
  PDFs, docx), assignment/exam entries with due dates. (Addresses like
  `blackboard.example-university.edu` in these skills are examples — use the student's own `url`.)
- **School email** (`kind: "email"` — Outlook/Gmail): new school emails since lastRun —
  sender, subject, gist; note attachments worth capturing (syllabi, slides, schedules).
  Triage per nemesis-email (read-only; never send). **If Apple Mail has the school
  account, sweep there FIRST** (one AppleScript bulk read beats a webmail click-loop —
  see nemesis-email "Which door"); drop to webmail only for attachment downloads or
  when the account isn't in Mail.app.

**Extract in bulk, don't click row-by-row.** Once you're authenticated on a portal page,
the FAST path is `browser_console` / `browser_cdp` running one `Runtime.evaluate` that
returns the whole list at once — every course tile, the full announcements table, all
unread email rows — as structured text (e.g.
`[...document.querySelectorAll('article h4')].map(e => e.innerText)`). That is one tool
call instead of a click → snapshot → click loop, and it's dramatically faster and cheaper.
Reserve step-by-step `browser_click` + `browser_snapshot` for when you must open a
specific item (download a file, read one email body). The live browser panel the student
watches is only the human-facing mirror; you perceive the page as this structured text.

Collect everything into one worklist before producing anything.

**Course name resolution pitfall:** The graph's course names (e.g. "PHCY 1205 · Pharmacology") may not match any Blackboard shell name (e.g. "Spring 2026: Dosage Dsgn, Deliv, Dispens II"). When you sweep Blackboard and find no matching shell for a graph course:
1. Check ALL terms (Current Courses, Spring 2026, Upcoming Courses, All Terms) — not just "Current Courses"
2. Use `browser_console` to extract course headings via `document.querySelectorAll('article h4')` when the accessibility snapshot truncates
3. If still no match after checking all terms, report it plainly in the sync output and ask: "Which Blackboard shell has your [Course Name] materials? The course code might be different from what's in my graph."
4. Record the mapping in `.nemesis/graph.json` as a `fields.courseCodes` array on the course object so future syncs use the correct shell.

## Phase 2 — Capture

- Download each new file into `School/<Course>/Slides/` (lecture decks) or
  `School/<Course>/` (everything else). Keep original filenames; prefix with a date
  (`2026-07-11 — `) only when the original name has none.
- Announcements: append to `School/<Course>/Announcements.md` (date, title, one-line
  gist, link) — newest first.
- Email attachments worth keeping go the same way; note in the ledger which email they
  came from.

## Phase 3 — Produce (the intelligence; this is why students pay)

**Read each lecture ONCE, then build every artifact from a digest — not from re-reading.**
For each new lecture file: extract its TEXT (never render the pages as images — that costs
15–30× more per page), and stage the atomic concepts + key terms + numbers-with-slide into
`.nemesis/scratch/<lecture>-digest.md`. Then produce the note, the deck, AND the vocabulary
by reading that small digest — so processing lecture 2 doesn't require lecture 1's full
slide text still sitting in the conversation. A lean conversation is the difference between
a ~2M-token sync and a ~9M-token sync on the student's meter.

For each new lecture file (up to the batch cap), from its digest produce:

**A structured lecture note** at `<Course>/<Lecture name>.md`:
- `# <Lecture name>` + one-line "what this lecture is really about".
- `## Key concepts` — the ideas, not a slide-by-slide transcript.
- A field-appropriate structured section (adapt the heading + shape to the discipline):
  pharmacology → `## Drugs` (each drug: mechanism, dosing, adverse effects/interactions/
  monitoring); other sciences → `## Mechanisms` / `## Formulas & when they apply`;
  humanities/law → `## Arguments & evidence` / `## Cases & holdings`. Tight bullets; cite
  slide numbers like `(slide 14)` so the student can verify.
- `## Exam-likely points` — what an examiner would actually ask (call them "clinical
  pearls" for health sciences).
- `[[wikilinks]]` to related existing notes (check what exists first; link, don't duplicate).

**A flashcard deck** per nemesis-study-decks (`Flashcards/<Course> — <Lecture name>.tsv`,
`# course: <Course>` on line 1): 8–15 exam-quality cards — application-level (mechanisms,
adverse effects, interactions, monitoring, dosing decisions), one concept per card, no
"what is X" filler. If a deck for this lecture already exists, ADD only genuinely new
cards.

**Vocabulary**: append new terms the lecture introduced to `Vocabulary.md` (one line
each, per nemesis-organize).

## Phase 4 — Record & report

- **Graph** (.nemesis/graph.json, per nemesis-graph): new/changed deadlines, exams,
  lectures, concepts — tag provenance (blackboard/outlook, date).
- **Calendar** (School/calendar.json): every date found (due dates, exams, events).
- **Home.md**: refresh "This week" and "Recent lectures" (per nemesis-organize).
- **Ledger**: one line per real action.
- **Report to the student, plain and short**: what's new (per course), what you made
  (notes/decks by name), what deadlines changed, what's queued, and anything that needs
  them (a login, an ambiguous course mapping). Lead with the single most urgent thing.

## When there's nothing new

Say so in one line ("Swept Blackboard and Outlook — nothing new since Friday 9pm."),
update lastRun, and stop. Never manufacture work.
