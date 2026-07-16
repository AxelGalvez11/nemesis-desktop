---
name: nemesis-study-planner
description: "Decide WHAT study material to build and WHEN, driven by need — not eagerly for every lecture. Reads the semester graph (upcoming exams with dates + grade weights, the concepts they cover, and each concept's mastery) and builds the RIGHT study tool for mastery (flashcards, cloze, worked practice problems, a practice quiz, or a mind map) for what's coming soonest and matters most. Use after a sync, when an exam approaches, or when the student asks 'what should I study'."
version: 1.0.0
metadata:
  hermes:
    tags: [study, planner, mastery, exams, flashcards, quiz, practice, spaced, nemesis]
    related_skills: [nemesis-graph, nemesis-study-decks, nemesis-semester-scaffold, nemesis-school-sync, nemesis-ledger]
---

# Study planner — build what's needed, when it's needed, in the method that builds mastery

Don't make flashcards for every lecture the moment it lands. That spends the student's
allowance on decks nobody opens and ignores how studying actually works. Instead, let the
semester graph tell you what's coming and how ready the student is, and build the RIGHT
study tool for it, timed to the exam. The note is the durable record (build it on capture);
the study material is need-driven and lives here.

## 1. Read the need from the graph

Read `~/Documents/Nemesis Library/.nemesis/graph.json` (nemesis-graph). Pull:
- **Upcoming exams/quizzes** — `type: exam` objects with a `date` in the next ~10 days (the
  planning window; widen for a big cumulative final). Note each one's `fields.weight` (grade
  %) and, if recorded, its format (MC, problem set, essay, mixed).
- **What each exam covers** — follow its `relationships` (`covers` → concept ids), or the
  topics the syllabus schedule (semester-scaffold) puts in that exam's weeks.
- **Mastery per concept** — each `concept` object's `fields.mastery` (0–100). Missing = treat
  as unknown/low. This is the "how ready are they" signal.
- **What already exists** — check the Library (`Flashcards/`, `Tests/`, `Mindmaps/`, notes)
  so you REFRESH/extend rather than duplicate.

## 2. Prioritize — soonest × heaviest × weakest

Rank the covered concepts by roughly `exam-proximity × grade-weight × (100 − mastery)`. Build
for the top of that list first: the weak concepts on the soon, high-stakes exam. Skip
concepts already at high mastery with material built, and skip exams outside the window
(note them: "Pharmacology final is 3 weeks out — I'll start its set next week").

## 3. Choose the METHOD that builds mastery (the core job)

Don't default to flashcards. Mastery is built in stages — *understand → recall → apply* — and
different material and different exams need different tools. Pick per concept:

- **Match the exam's format first.** A multiple-choice exam → a **practice quiz** (Tests) so
  they rehearse choosing under exam conditions. A problem-set/quant exam → **worked practice
  problems** (method, not just answers). An essay exam → **argument outlines**. Mixed → a mix.
- **Match the material's nature.** Memorization-heavy facts (drugs, doses, terms, anatomy) →
  **flashcards**, with **cloze** for exact values/enumerations. Problem-based (math, physics,
  engineering, quant chem) → **worked problems**. Relationship/synthesis-heavy → a **mind map**
  plus a quiz.
- **Match the student's specific gap.** Low mastery because they can't *recall* → flashcards.
  Can't *apply* → practice problems or a quiz. Can't see how it *connects* → a mind map. If
  you don't know the gap yet, a short **practice quiz** both teaches and reveals it (then set
  that concept's mastery from the result).
- **Usually combine, lightly.** For a high-stakes weak concept, a small deck to lock the facts
  PLUS a short quiz to test application beats a big pile of one type.

Build each via **nemesis-study-decks** (flashcards `.tsv`, practice tests `.json`, mind maps
`.md`) or a worked-problems note. Keep sets tight (8–15 items) — targeted, not exhaustive.

## 4. Surface the plan (this is what the student sees)

Tell them plainly, prioritized: which exam, when, how much it's worth, their weak spots, what
you built and WHY that method, and where to start. E.g.:
> "Cardio-renal exam in 8 days (25% of grade). Weakest: renal dosing and RAAS. I built a
> practice quiz for renal dosing (it's MC and you need application reps) and a cloze deck for
> the RAAS drug values (exact recall). Start with the quiz — that's where you're thinnest."

## 5. Close the loop

After a study/test session, update the concept's `fields.mastery` in the graph (nemesis-graph)
and add a change, so the next plan targets what's still weak and eases off what's mastered.
Log built material in the ledger (nemesis-ledger).

## Budget
Study-material generation is need-gated on purpose — that IS the cost control. Build for the
current window only, cap at a few concepts per run (the weakest/soonest), refresh before
rebuilding, and reuse the lecture digests you already wrote (don't re-read source PDFs).
