---
name: nemesis-homework
description: Fetch an assignment or discussion-board post from the school portal, gather its materials, and DRAFT the work for the student to review and submit themselves — never auto-submit. Use when the student says "help me with this assignment", "draft my discussion post", "what does this homework ask", or "start my problem set".
version: 1.0.0
metadata:
  hermes:
    tags: [homework, assignment, discussion, draft, school, blackboard, canvas, nemesis]
    related_skills: [school-portal, nemesis-deliverables, nemesis-graph, nemesis-ledger, pubmed-evidence]
---

# Homework & discussion drafting — fetch, draft, hand back. NEVER submit.

The student should never do the busywork you can do: finding the assignment, reading its
rubric, pulling the materials, and turning out a first draft. But the graded thinking is
theirs, and **you never submit.** Everything you make here is a draft they review, edit,
and turn in themselves.

## The hard line (this is the product's integrity, and the student's enrollment)
- **Never submit, post, or send.** No "Submit assignment", no "Post" on a discussion board,
  no "Start attempt" on a quiz, no emailing it in. You fill a draft; the student presses the
  button. If a task can't be done without submitting, stop and say so.
- **Draft, don't ghost-write the graded core.** You gather, structure, explain, and draft —
  but the work is the student's own, framed as a draft they own and must review. Cite real
  sources for any factual/clinical claim (never invent one). For a discussion post, write in
  the student's own plain register, not an AI voice.
- **No sensitive forms.** Never enter SSN, financial-aid/FAFSA data, payment details, or
  passwords into any form — hand those back to the student every time.
- **Login/CAPTCHA are the student's** — pause and let them clear it in the browser panel.

## The cheap loop: fetch in bulk → digest → draft from the digest
1. **Fetch the assignment in ONE pull, not click-by-click.** On the assignment/discussion
   page, use one `browser_console` call (per school-portal's fast-extraction rule) to pull
   the prompt, the rubric/grading criteria, the due date, and the list of attachment links
   — as structured text, in a single step. Don't screenshot-and-re-read the page.
2. **Gather materials as TEXT.** Download the linked readings/files (they land in Downloads;
   file them per school-portal) and extract their text — never read a document as page-images.
3. **Stage a digest.** Write the prompt + rubric + the key points from each material into
   `.nemesis/scratch/<assignment>-digest.md`. **Reuse what you already have first** — if the
   topic is in the Library or the semester graph, or you researched it earlier this session,
   read that instead of re-researching from scratch.
4. **Draft from the digest**, matched to what the rubric actually rewards:
   - A written assignment / essay / discussion post → draft into a note in
     `~/Documents/Nemesis Library/School/<Course>/`, or per nemesis-deliverables if it wants
     a formatted document. Map the draft to each rubric point so nothing's missed.
   - A problem set → worked solutions showing the METHOD (steps, not just answers) so the
     student learns by re-solving, per nemesis-study-decks' problem-set shape.
5. **Hand it back clearly.** Tell the student where the draft is, that it's a draft to review
   and submit themselves, and flag anything you were unsure of or couldn't verify. If the
   portal has an answer box, you MAY fill it for their review — then STOP at Submit and say so.

## Budget
A single assignment is a small job — one page fetched, a few materials read, one draft. If
it balloons past ~25 browser steps or you're re-reading the same material repeatedly, stop
and check in rather than looping. Log the draft in the ledger (nemesis-ledger; sent/submitted
always false).
