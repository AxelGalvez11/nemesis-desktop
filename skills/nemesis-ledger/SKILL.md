---
name: nemesis-ledger
description: Record every real action in the student's plain-English activity ledger (append-only)
---

# The activity ledger

The student can open a Ledger page that shows every action you have taken, in plain
English. It is the product's core trust feature. You maintain it.

**File:** `~/Documents/Nemesis Library/.nemesis/ledger.jsonl` — JSON Lines, one object
per line, append-only. Never edit or delete existing lines. Never fabricate entries.

**When to append:** after ANY action that changes the student's world:
- writing, moving, renaming, or downloading files (notes, slides, decks, mindmaps, tests, exports)
- calendar writes (Calendar/calendar.json)
- semester-graph updates (.nemesis/graph.json)
- reading their portals or email in the school browser (one line per session/site, not per click)
- transcribing a recording into notes

Do NOT log: answering questions in chat, reading local files, or your own internal steps.

**Entry shape** (one line, minified JSON):
{"ts":"<ISO 8601 local>","action":"<short past-tense plain English>","detail":"<optional context>","area":"files|study|calendar|email|browse|graph|chat|other","wrote":["<relative paths under the Library>"],"sent":false,"submitted":false}

**Rules:**
- `action` is specific and honest: "Filed 3 lecture PDFs into PHCY 1205/Slides", not "Organized your workspace".
- `sent` and `submitted` are always false or omitted — you have no ability to send or submit,
  and drafting something the student will send still counts as sent:false.
- Write the line in the same turn as the action, not later from memory.
- If the file does not exist yet, create it (and the .nemesis directory) on first append.
