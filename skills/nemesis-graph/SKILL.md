---
name: nemesis-graph
description: Keep the student's academic object graph up to date — the structured model of their courses, deadlines, exams, lectures, concepts, professors, and applications that powers the Today command center. Use whenever you learn something new or changed about the student's academic world (from Blackboard/Outlook/Canvas, a syllabus, a lecture, an email, or the student telling you).
version: 1.0.0
metadata:
  hermes:
    tags: [graph, state, academic, planning, today, dashboard, courses, deadlines, nemesis]
---

# Keep the academic graph current

Nemesis has one structured model of the student's academic world at
`~/Documents/Nemesis Library/.nemesis/graph.json`. The Today home screen, the calendar,
and the planner all read it. Your job: whenever you observe something new or changed —
a due date on Blackboard, an exam announcement, a new lecture, a professor email, an
IPPE/rotation window — record it here so the student's dashboard reflects reality.

This is the difference between Nemesis being a chatbot that searches files and being an
operating system that knows the student's semester. Update it proactively, not only when
asked.

## The file

```json
{
  "version": 1,
  "student": { "name": "..." },
  "semester": { "id": "...", "title": "...", "start": "...", "end": "..." },
  "objects": [ ... ],
  "changes": [ ... ]
}
```

Each **object**:
```json
{
  "id": "assignment:phcy-1205:quiz-4",      // stable "type:course-code:slug"
  "type": "course|concept|assignment|exam|lecture|announcement|grade|professor|project|application|contact|meeting|credential|syllabus|semester",
  "title": "Quiz 4 · Cardio-renal pharmacology",
  "course": "course:phcy-1205",              // owning course id (omit for cross-course)
  "status": "open|upcoming|done|submitted|graded|at-risk",
  "date": "2026-07-14",                       // ISO yyyy-mm-dd or yyyy-mm-ddTHH:mm
  "confidence": "instructor-stated|course-material|student-added|ai-inference|unverified",
  "source": { "kind": "lms|email|lecture|file|note|manual|web", "ref": "<url/file/msg>", "ts": "<ISO>" },
  "fields": { "weight": 15, "mastery": 54 },  // type-specific extras
  "relationships": [{ "rel": "covers", "to": "concept:renal-dosing" }],
  "history": [{ "ts": "<ISO>", "change": "Date moved from Fri to Mon" }]
}
```

Each **change** (feeds "what changed since yesterday"):
```json
{ "ts": "<ISO now>", "objectId": "<id>", "kind": "created|updated|date-changed|status-changed|removed", "summary": "Quiz 4 moved from Friday to Monday", "confidence": "instructor-stated" }
```

## The one rule: READ-MERGE-WRITE (never overwrite)

The student and the app also touch this file. Always:
1. **Read** the existing graph.json first (`test -f` then read).
2. **Merge**: update the object with the matching `id` in place (append to its `history`);
   add new objects; only remove an object if the source shows it's truly gone.
3. **Append** a `changes` entry for anything you created or changed (with a real ISO
   timestamp — use the current date/time).
4. **Write** the whole file back and **validate**: `python3 -c "import json;json.load(open('<path>'))"`.
Never blow away objects the student or another process added.

## Confidence — be honest about provenance

The dashboard shows a provenance tag on every fact. Tag truthfully:
- `instructor-stated` — the professor/coordinator said it (announcement, email, lecture). Highest trust.
- `course-material` — pulled from a slide, syllabus, or reading.
- `student-added` — the student told you.
- `ai-inference` — you derived it (e.g. estimated a concept's exam relevance). Lowest trust; never dress an inference as instructor-stated.
- `unverified` — seen once, not corroborated.

## When to update (proactively)

- Reading Blackboard/Canvas/Outlook (school-portal skill): every due date, exam, quiz,
  announcement, new lecture, grade → an object + a change. A due date that MOVED → update
  the object's `date`, append `history`, and add a `date-changed` change (this is the
  headline the student most needs to see).
- A syllabus → a `syllabus` object + `assignment`/`exam` objects for each dated item +
  `professor` + `course`.
- A lecture recording → a `lecture` object; the concepts it introduced →
  `concept` objects with `covers` relationships; if it's prerequisite for a weak area,
  note it.
- An email about a research position, internship, scholarship, or rotation → an
  `application`/`meeting`/`contact` object (student life, not just coursework).
- Mastery: when a study/test session reveals a weak concept, set/adjust that concept's
  `fields.mastery` (0–100) and add a change.

## Don't
- Don't fabricate objects to make the graph look full — a wrong deadline is worse than a
  missing one. Ground every object in something you actually read.
- Don't put raw secrets, full email bodies, or passwords in the graph — titles, dates,
  and a source ref are enough.
- Don't touch graded-assessment objects beyond recording that they exist and their dates.
