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
3. 8–20 cards is the sweet spot. Application-level questions (mechanisms, adverse
   effects, interactions, monitoring, "patient on X develops Y — why?"), one concept per
   card, no "what is X" filler.
4. GROUNDING RULE: every card must come from the conversation, note, or sources actually
   discussed or retrieved. Never pad a deck with facts you didn't ground — a wrong card
   is worse than a missing card.
5. Don't overwrite an existing deck file; check with `test -f ~/Documents/Nemesis\ Library/Flashcards/<Name>.tsv` first; if it exists, append ` 2` to the file name.
6. **Verify the TSV** immediately after writing. Run:
   ```sh
   python3 -c "
   with open('/Users/axelgalvez/Documents/Nemesis Library/Flashcards/<Deck name>.tsv') as f:
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
