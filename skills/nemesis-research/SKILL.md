---
name: nemesis-research
description: Research-grade web answers — fan out multiple search queries (15-25 sources), read the best pages, and answer with real inline citations. Use for any question that deserves sources, comparisons, "verify this claim", current events, or when the student picked the High answer mode.
---

# Research fan-out — never answer a research question from one search

A single `web_search` with 5 results reads like a guess. A research-grade answer sweeps
the topic from several angles, reads the best pages, and cites what it actually used.
ChatGPT-class research pulls 20+ sources; that is the bar.

## When this applies

- The question asks for evidence, comparisons, current facts, statistics, or "is X true?"
- The student picked the **High** answer mode, or says "research", "sources", "look it up".
- A deliverable (report, poster, deck) needs a sourced section.

Quick factual lookups (one date, one definition) stay a single search — don't ceremony them.

## Procedure

1. **Plan 3–5 query variants** that attack the topic differently: the plain question,
   a synonym/technical phrasing, a counter-angle ("X criticism", "X limitations"),
   a recency angle ("X 2026"), and when relevant a site-specific angle
   ("X site:nih.gov" style). Distinct angles beat rewordings.
2. **Run them all** with `web_search(query, limit=6)` — batch the calls in ONE turn
   where possible. That yields 18–30 raw results.
3. **Dedupe and rank** by URL/domain: drop repeats, prefer primary and reputable
   sources (journals, .gov/.edu, standards bodies, major outlets, official docs)
   over SEO blogs and content farms.
4. **Read the best 4–6 pages** with `web_extract` — snippets are not evidence. Read
   enough to quote accurately; you do not need to extract all 25 results (extracts
   cost tokens — spend them on the pages you will actually cite).
5. **Answer with inline citations**: every factual claim that matters links its source
   as a markdown link right where the claim is made — the app renders these as source
   pills. Never cite a page you didn't at least see in results; NEVER invent a URL,
   title, author, or identifier.
6. **Say what you found AND didn't**: if sources disagree or coverage is thin, say so
   plainly instead of papering over it.

## Budget notes

- Each search query costs one search unit (plans have daily units — Student 75/day);
  a 4-query fan-out is cheap. The token cost lives in the EXTRACTS — cap them at the
  4–6 pages you cite.
- On a search-limit error, fall back to fewer queries and tell the student today's
  search allowance is running low.
