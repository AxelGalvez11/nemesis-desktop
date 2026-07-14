---
name: nemesis-semester-scaffold
description: "Start-of-term setup: read a course syllabus and SCAFFOLD the whole semester before capturing materials — build the course skeleton (weekly topic schedule, every exam/assignment with date + grade weight, grading breakdown, policies) in the graph, and a per-course home note. Run once per course at the start of term (or when a syllabus is added); the daily school-sync then hangs each new lecture/reading onto the right week. Use when the student says 'set up my semester', 'scaffold my courses', 'I have a new syllabus', or connects for the first time."
version: 1.0.0
metadata:
  hermes:
    tags: [syllabus, semester, scaffold, setup, schedule, course, weekly, exams, grading, nemesis]
    related_skills: [nemesis-graph, nemesis-school-sync, nemesis-organize, nemesis-calendar]
---

# Scaffold the semester — frame first, fill in second

A strong student starts a term by reading the syllabus and building a mental skeleton of
the whole course — the weekly topics, when the exams are, what's worth what — and then
hangs each lecture and reading onto that frame as the weeks go. Nemesis should do the same.
This runs ONCE per course at the start (or whenever a new syllabus appears); after it, the
daily `nemesis-school-sync` fills the skeleton in.

Do this BEFORE bulk-capturing materials. A lecture that lands is far more useful as "Week 6,
the topic the syllabus weights at 20%" than as a loose file.

## 1. Find the syllabus
- If the student points to one, use it. Otherwise look in the Library (`School/<Course>/`,
  `Imports/`, root) and their Mac (per nemesis-import discovery) for `*syllab*` pdf/docx.
- Or, if portals are connected, the syllabus usually lives under each Blackboard course's
  Content / Course Information (school-portal skill).
- No syllabus found? Say so and offer to scaffold from whatever schedule/calendar the
  course DOES expose (a Blackboard "Course Schedule" page, a first-day handout). Never
  invent weeks or dates.

## 2. Read it and extract the skeleton (per course)
Pull, and only what's actually stated (tag provenance `course-material`):
- **Course identity**: code, title, term, instructor(s) + contact.
- **Weekly/topic schedule**: the sequence of topics with their week or date. This is the
  spine — capture every row.
- **Every dated item**: exams, quizzes, midterms, finals, assignments, projects,
  presentations — with date AND grade weight (%).
- **Grading breakdown**: what percentage each category is worth.
- **Key policies worth surfacing**: attendance, late work, exam format, required materials.

## 3. Write the skeleton into the graph (nemesis-graph, READ-MERGE-WRITE)
- A `course` object (identity, term), a `professor` object, a `syllabus` object.
- One `exam`/`assignment` object per dated item with `date` and `fields.weight`,
  `confidence: "course-material"`.
- The topic schedule as `concept` objects (or a lecture placeholder per week) tagged with
  their week, so later lectures/readings attach to the right topic via a `covers`
  relationship. Include the week/date in `fields`.
- Add `changes` entries so "what changed" reflects the setup.
- Validate the JSON after writing.

## 4. Write a per-course home note
Create `School/<Course>/<Course> — Overview.md` (and link it from Home.md):
- Header: course, instructor, term, meeting time.
- `## Grading` — the weight table.
- `## Schedule` — the week-by-week topic list; leave a spot beside each week to link the
  lecture/reading once it arrives (`Week 6 — Renal dosing · [[…]]`).
- `## Exams & big dates` — every dated item with its weight, newest work first.
- `## Policies` — the few that matter (exam format, late work).
Read-merge-write; never clobber a version the student edited.

## 5. Calendar + report
- Put every dated item on the Calendar (`School/calendar.json`).
- Ledger the scaffold (nemesis-ledger, area "files").
- Report plainly: "Set up <Course>: 15 weeks, 3 exams (weights…), next big date is …. As
  lectures come in I'll file each under its week. Want me to pull this week's materials now?"

## Rules
- Only what the syllabus states. Dates/weights you can't find → say "not specified", never guess.
- One scaffold per course; re-running updates the skeleton in place (a syllabus revision =
  update the changed rows + a `date-changed`/`updated` change), never a duplicate.
- This is setup, not teaching — don't write lecture notes or flashcards here; that's the
  daily sync's job once real material lands on the skeleton.
