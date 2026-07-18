---
name: nemesis-notes
description: Write CONNECTED Obsidian-flavored markdown notes into the student's Library (~/Documents/Nemesis Library). Use whenever the student says "save this to my library", "make this into notes", "write this up as a note", or when any pipeline (school-sync, research, import) produces notes. Wikilinks are the point — a note without links is a dead end.
---

# Library notes — Obsidian-flavored, always connected

The Library is an Obsidian-compatible vault of plain `.md` files. The app's Library
page renders them; the Graph page draws the wikilink web; `[[links]]` autocomplete
in the editor. Notes you write should look native to that system.

## The prime rule

**"Add this to my library / make it into notes" = markdown note files. NOT a slide
deck, NOT a report, NOT HTML.** Deliverables (nemesis-deliverables) are only for an
explicit "slides / report / handout / PDF" ask. If you just built a deliverable and
the student says "no, into the library as notes" — they mean this skill.

## Where notes go

- Course material → `<Course folder>/<Topic>.md` (match the existing folder names;
  check with `ls` first — never invent a parallel folder for a course that exists).
- Standalone research/topics with no course → the vault root, or a `Research/` folder
  once there are several.
- NEVER write notes into `Flashcards/`, `Mindmaps/`, `Tests/` (Study owns those
  formats), `School/` (calendar), or `.nemesis/` (your scratch + graph).
- One concept per note, named as the student would say it: `Retatrutide.md`, not
  `retatrutide_research_notes_v2.md`. The filename IS the wikilink target.

## Anatomy of a good note

```markdown
---
tags: [pharmacology, incretins]
aliases: [LY3437943]
---

# Retatrutide

Triple agonist (GIP + GLP-1 + glucagon) — next-generation incretin, currently
Phase 3 ([TRIUMPH program](https://clinicaltrials.gov/study/NCT05929066)).

## Mechanism
Extends the dual agonism of [[Tirzepatide]] with glucagon-receptor activity —
raises energy expenditure on top of appetite suppression.

## Evidence
- Obesity (Phase 2): −24.2% body weight at 48 wk (12 mg) — PMID: 37366315
- MASLD (Phase 2a): −82.4% liver fat vs +0.3% placebo — PMID: 38858523

## Safety
GI effects dominate (dose-related, mild-moderate); dose-dependent heart-rate
increase peaking ~24 wk. Ramp-up titration mitigates — same family behavior as
[[Semaglutide]].

> [!warning] Not approved
> No FDA/EMA approval yet — investigational, Phase 3 ongoing.

## Related
- [[GLP-1 receptor agonists]] — the drug class overview
- [[Obesity pharmacotherapy]] — where this fits in the toolkit
```

## Syntax that matters here (Obsidian-flavored)

- `[[Note]]`, `[[Note|shown text]]`, `[[Note#Heading]]` — internal links. Use for
  EVERY mention of a concept that has (or deserves) its own note. External URLs use
  regular `[text](url)` links.
- Frontmatter properties: `tags` (lowercase, hyphenated) and `aliases` (other names
  the student might link by — brand names, abbreviations). Keep to those two unless
  asked.
- `![[image.png]]` embeds an image from the vault; `![[Note#Section]]` embeds a
  section of another note. Embed sparingly — link by default.
- Callouts for the few lines that must not be skimmed past:
  `> [!warning]`, `> [!tip]`, `> [!example]` (title optional, `-` suffix folds).
  One or two per note, not a rainbow.
- Citations stay inline where the claim is: `PMID: 38858523` / trial ids / DOIs
  right after the sentence they support (the chat UI turns these into chips; in
  notes they stay honest plain text).

## Connect, then verify (the part that makes it a library)

1. BEFORE writing, `ls` the course folder and skim `Home.md` — learn what notes
   already exist so your links hit real targets.
2. Link liberally: 3–8 wikilinks per note is healthy. A link to a note that doesn't
   exist yet is fine when it marks an obvious future note (that's how the web grows)
   — but prefer linking things that exist.
3. AFTER writing, add a backlink: open the most related existing note (or the course
   hub note) and add a one-line mention with a `[[link]]` to the new note under its
   Related section. A note nothing points to is invisible.
4. Update `Home.md`'s recent-material line per nemesis-organize when the addition is
   notable.
5. Don't overwrite an existing note blindly — if `Retatrutide.md` exists, MERGE new
   material into it (keep the student's own edits; append/weave, don't clobber).

## Link grammar (the 5 relationship types)

Under a note's `## Related` section, a bullet MAY start with a relationship word before
the `[[link]]` — e.g. `- Prerequisite of: [[Beta blockers]]`. If you use one, it MUST be
one of these five (case-insensitive, trailing colon required). A plain bullet with no
relationship word (`- [[Note]]` or `- [[Note]] — one-line note`, like the ones in the
example above) is still fine — you don't have to type every link, only never invent a
sixth relationship word when you do.

1. **`Prerequisite of:`** — this note must be understood before the target makes sense.
   `Adrenergic receptors.md` → `- Prerequisite of: [[Beta blockers]]`
2. **`Part of:`** — this note is a member of the target's larger class/group.
   `ACE inhibitors.md` → `- Part of: [[RAAS-targeting drugs]]`
3. **`Related to:`** — associated, same family or topic, no hierarchy between them.
   `Retatrutide.md` → `- Related to: [[Tirzepatide]]`
4. **`Contrasts with:`** — meaningfully different from the target; the comparison is the point.
   `Dabigatran.md` → `- Contrasts with: [[Warfarin]]`
5. **`Applied in:`** — this concept is used/demonstrated in the target context. Alias:
   `Example of:`, for phrasing it from the other direction ("this note IS an example of
   the target").
   `ACE inhibitors.md` → `- Applied in: [[Heart failure with reduced ejection fraction]]`
   `Lisinopril.md` → `- Example of: [[ACE inhibitors]]`

**No other relationship word.** Not "Causes:", not "Leads to:", not "See also:" — if none
of the five fit, use `Related to:` or leave the link untyped. The app's note panel flags
any `## Related`/`## Connections` bullet whose relationship word isn't one of these five
as "Off-grammar links" — that's a signal to fix the note, not license to invent a sixth type.

**Root-relative links only — never `../`.** Write `[[Beta blockers]]` or
`[[Pharmacology/Beta blockers]]`, never `[[../Pharmacology/Beta blockers]]`. The resolver
(`keysForNote` in `links.ts`) only indexes a note by its bare title and its
vault-root-relative `folder/Title` path — it never walks `../` segments, so a `../` link
shows broken forever even when the target file exists exactly where you think it is.

**Cite your source.** Every note carries a `Source:` line (near the top, under the title,
or as frontmatter `source:`) naming the file and slide/page the material came from, e.g.
`Source: Incretins Lecture 4.pptx, slide 12`. That's what lets a claim be traced back to
the lecture it came from.

## Tone

Notes are for the student's own review: dense, factual, exam-oriented — headings,
short bullets, numbers kept exact. No chat voice ("Here's what I found!"), no
filler, no first person.
