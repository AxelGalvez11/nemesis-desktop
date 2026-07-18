---
name: nemesis-study-decks
description: Create flashcard decks from chat, lectures, or documents — writes TSV files to the Nemesis Library Flashcards folder for the Study page.
version: 1.1.0
metadata:
  hermes:
    tags: [flashcards, study, decks, pharmacology, nemesis, cards]
---

# Create Study flashcard decks

Use this skill whenever the student asks you to make flashcards, a deck, or study cards —
from the current chat, a lecture note, a topic, or a document. You create decks by
WRITING A FILE; the Study page imports it automatically.

## First: pick the deliverable that fits the FIELD (don't default to cards)

Flashcards are the right study tool for **memorization-heavy** fields — pharmacology,
medicine, anatomy, biology, law terms, languages. But the best study material differs by
discipline, and forcing cards onto a problem-based subject helps no one. Choose:

- **Memorization-heavy** (pharma, med, bio, anatomy, vocab) → **flashcards** (this skill).
- **Problem-based** (engineering, math, physics, chemistry-quant, CS) → **worked-example
  problem sets**: a note titled `<Topic> — Worked problems` with, for each problem, the
  prompt, the full solution METHOD (steps, not just the answer), and the formula used —
  because these students learn by re-solving. Optionally also a small "flag the formula"
  deck for the equations themselves. Practice **tests** (Study page tests) suit them well too.
- **Argument-based** (humanities, law, social science, essays) → **argument outlines**: a
  note mapping thesis → evidence → counterargument → significance for each topic/reading,
  plus a few cards for names/dates/definitions only. Mind maps fit these well.

When unsure, ask the student which they prefer, or make the field-default and offer the
alternative. The rest of this skill is the flashcard mechanics for when cards are the pick.

## Before you start

Check **USER.md memory** for a default course preference
(e.g. "flashcard decks default to course: Pharmacology"). If one exists, use it as the
course header automatically. If none exists, ask the student once and save it to USER.md.

## How

1. Write ONE file per deck to `~/Documents/Nemesis Library/Flashcards/<Deck name>.tsv`
   (create the folder if missing). The file name becomes the deck name — make it a clean
   title like `Renal dosing essentials.tsv`.
2. File format:
   - First line for grouping: `# course: <Course name>` — use the default from USER.md
     memory, or the course the student specified. Always include this line.
   - Then one card per line: `front<TAB>back` — a real TAB character between front and back.
   - No other headers, no numbering, no blank fronts/backs.
   - **Cloze (fill-in-the-blank) cards** — put `{{c1::the hidden term}}` markers INSIDE the
     front; the back stays a short source/why note (still two TAB fields). Multiple markers
     on one line become multiple cards that schedule independently, so one line can test a
     whole set: `The {{c1::renal}} system clears {{c2::hydrophilic}} drugs<TAB>Basic pharmacokinetics.`
     Optional hint: `{{c1::term::hint shown in the blank}}`. This is the cheapest high-value
     card type — several tested facts from one written line — so prefer it for lists and
     paired terms. (Malformed markers just show as text; keep the `{{cN::…}}` shape exact.)
     - **NEVER leak a clozed term's own answer elsewhere on the line.** On the card where a
       term is blanked, every OTHER part of the line is still visible — so a synonym or
       definition of the hidden term sitting in a non-clozed parenthetical hands the answer
       over. BAD: `...and {{c2::NETosis}} (extruding NETs)` — on the c2 card the student sees
       `[...] (extruding NETs)`, which *is* the answer. FIX: clozify the giveaway too
       (`{{c2::NETosis}} ({{c2::extruding NETs}})`) or drop the parenthetical. The back is a
       source/why note only — never the answer restated (that back shows on every card).
3. 8–20 cards is the sweet spot. Application-level questions (mechanisms, adverse
   effects, interactions, monitoring, "patient on X develops Y — why?"), one concept per
   card, no "what is X" filler. Card-quality rules: **one fact per card** (back ≤ 1
   sentence, never join two facts with "and"/"vs"); use a **cloze** for any enumeration or
   list instead of stuffing a semicolon-separated answer into one back; for the highest-
   yield numbers/thresholds, make BOTH a Q/A card (recognition) and a cloze card (exact recall).
4. GROUNDING RULE: every card must come from the conversation, note, or sources actually
   discussed or retrieved. Never pad a deck with facts you didn't ground — a wrong card
   is worse than a missing card. **Plain text only** — the Study page shows card text as-is,
   so no HTML tags and no LaTeX/MathJax (they render as literal `<b>`/`\frac{}` garbage);
   write equations in Unicode (`Cₛ`, `≤`, `→`).
5. Don't overwrite an existing deck file; check with `test -f ~/Documents/Nemesis\ Library/Flashcards/<Name>.tsv` first; if it exists, append ` 2` to the file name.
6. **Verify the TSV** immediately after writing. Run:
   ```sh
   python3 -c "
   import os
   with open(os.path.expanduser('~/Documents/Nemesis Library/Flashcards/<Deck name>.tsv')) as f:
       lines = f.readlines()
   print(f'Lines: {len(lines)}')
   for i, l in enumerate(lines[1:], 1):
       parts = l.split('\t')
       if len(parts) != 2:
           print(f'WARNING card {i}: {len(parts)} fields (need 2)')
   print('Verification done.')
   "
   ```
   Fix any cards with more or fewer than 2 TAB-delimited fields before telling the student.
7. After writing and verifying, tell the student: the deck will appear in the Study page automatically
   (they may need to open or revisit Study), under the course you set.

## Generate cost-smart (read the source ONCE, build from a digest)

Making cards from a document is where cost runs away if you re-read the source for every
step. Do it once:

1. **Extract text once, never page-images.** Pull a PDF/slide's TEXT (the file already has a
   text layer — read it as text). Do NOT send rendered page images to yourself to "read" a
   deck — that costs 15–30× more per page and repeats every step. OCR (local) is only for a
   scanned page with no text layer.
2. **Write a short digest first**, then build from it. Stage the lecture's atomic
   concepts + key terms + numbers-with-source into `.nemesis/scratch/<lecture>-digest.md`,
   then generate the cards (and any note or practice test) by reading that small digest —
   not by re-reading the whole PDF for each artifact. A structured digest also makes cards
   more accurate, not just cheaper.
3. **Generate in one batch.** Write all the cards for one lecture/topic in a single pass
   (≤ ~15 per batch), not one card per step.
4. **Quick self-check before you show the student (the QA pass):** does every number and
   claim on a card actually appear in the digest? Drop or fix any that don't — this is the
   cheap guard against a confident-but-wrong card.

## Example

Student: "Turn this chat about ACE inhibitors into flashcards."
→ write `~/Documents/Nemesis Library/Flashcards/ACE inhibitors essentials.tsv`:

```
# course: Pharmacology
A patient on lisinopril develops a persistent dry cough. Mechanism, and what do you switch to?	Bradykinin accumulation from ACE inhibition; switch to an ARB (losartan) — blocks AT1, spares bradykinin.
Why are ACE inhibitors contraindicated in pregnancy?	Fetal renal toxicity (oligohydramnios, renal dysgenesis) — all RAAS blockers.
```

Then: "Deck 'ACE inhibitors essentials' is ready — it'll show up in your Study page under Pharmacology."

## Mind maps (Study page renders these per section)

When the student asks for a mind map / concept map of a topic, lecture, or section:
1. Write ONE markdown file to `~/Documents/Nemesis Library/Mindmaps/<Title>.md`.
2. First line: `<!-- course: <Course name> -->` (same course names as decks — this groups it
   into the right Study section).
3. Then a markdown OUTLINE: one `#` root (the topic), `##` main branches, nested `-` bullets
   for leaves. 2–4 levels deep, 15–40 nodes. Short node labels (2–6 words), not sentences.
4. GROUNDING: every branch comes from the discussed/retrieved material. A mind map is a map
   of what was actually covered — never pad with ungrounded facts.
5. Don't overwrite an existing file (`test -f` first; append ` 2` if taken).

## Practice tests (Study page gives a take-test flow with scoring)

When the student asks for a test, quiz, or practice exam on a topic or section:
1. Write ONE JSON file to `~/Documents/Nemesis Library/Tests/<Title>.json`:
   `{ "course": "<Course>", "title": "<Title>", "questions": [ { "q": "...", "options": ["...","...","...","..."], "answer": 0, "why": "..." } ] }`
   - `answer` is the 0-based index into `options`.
   - `why` explains the right answer in 1–2 sentences; cite inline (PMID/label) when clinical.
2. 8–15 questions; application-level (patient scenarios, "which drug…", "what do you monitor…"),
   one concept per question; distractors must be PLAUSIBLE (same drug class, adjacent concepts),
   never joke options.
3. GROUNDING rule applies: every question and its correct answer must come from material
   actually discussed or retrieved. A wrong answer key is worse than a missing question —
   double-check the `answer` index before writing.
4. Validate the JSON after writing (`python3 -c "import json;json.load(open('<path>'))"`).
5. Don't overwrite an existing file; check first.

## Student performance (READ-ONLY — build for weakness, not in bulk)

The Study app mirrors the student's real performance to disk. READ these to decide WHAT
to build; NEVER write or delete them — the app owns both files, and your copy would be
clobbered by its next save anyway. Both are `{ "version": 1, "updatedAt": ..., "data": ... }`
envelopes; everything below is inside `data`.

1. `~/Documents/Nemesis Library/.study/state.json` — flashcard mastery.
   - `decks[]`: every deck (`name`, `course`, `cards[]` with `id`/`front`/`back`/`tags`).
   - `schedule{}`: cardId → FSRS entry. Weakness signals: high `lapses`, low `stability`,
     `due` in the past. A card with `lapses ≥ 3` (leech territory) needs a DIFFERENT card —
     reformulate the concept (new angle, cloze, scenario), don't duplicate it.
   - `reviews[]`: append-only review log (grade per review) — recent `again` streaks show
     what's actively failing this week.
2. `~/Documents/Nemesis Library/.study/test-attempts.json` — quiz/test performance.
   - Keyed by test file name: `attempts[]` of `{ date, score, total, misses[] }`.
   - `misses[]` = `{ q, selected }`, 0-based indices into that test file's `questions` —
     join against the JSON in `Tests/` to see exactly which question was missed and which
     wrong option the student picked. A question missed on ≥2 attempts is a flashcard
     candidate; the picked distractor tells you the specific confusion to target.

When asked to "build cards for my weak spots" (or the Study page sends that request):
read both files first, name the 3–8 weakest concepts in one line each, then build ONE
tight deck (or extend the right existing deck file) for those — grounded in the original
material, never invented from the schedule data alone. Files may be absent on a fresh
install: fall back to asking what felt hard.
