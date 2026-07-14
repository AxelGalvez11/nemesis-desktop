---
name: pubmed-evidence
description: "Answer clinical/pharmacology/health-science questions from REAL PubMed literature via NCBI E-utilities, with verifiable PMID citations. Use for any drug, disease, treatment, mechanism, guideline, or 'is it true that…' medical claim."
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [pubmed, ncbi, evidence, clinical, pharmacology, medicine, citations, literature, drugs, guidelines, verify]
    related_skills: []
---

# PubMed Evidence

Ground medical answers in **real, retrievable literature** instead of memory. This is the
trust core of Nemesis for health-sciences students: every clinical claim should trace to a
citation the student can open. You have the `web` tool — that's all you need; NCBI's
E-utilities are plain HTTPS GET endpoints that return JSON/XML.

## When to use this
Activate for any question touching: a drug (mechanism, dose, adverse effects, interactions,
monitoring, contraindications), a disease or treatment, a clinical guideline, a comparison
("X vs Y"), or a claim to verify ("is it true that…"). If the question is clinical and you're
about to answer from memory, **stop and search first.**

## The workflow (3 steps)
Base URL: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/`

**1. Search → get PMIDs.** `esearch.fcgi`
```
GET esearch.fcgi?db=pubmed&retmode=json&retmax=8&sort=relevance&term=<QUERY>
```
- URL-encode the query. Combine concepts with `+AND+`, e.g. `lisinopril+AND+cough`.
- Bias toward strong evidence when useful: append
  `+AND+(guideline[pt]+OR+meta-analysis[pt]+OR+randomized+controlled+trial[pt])`,
  and/or recency `+AND+2015:2026[dp]`.
- Read `esearchresult.idlist` (the PMIDs) and `count` (total hits). Empty idlist = say so.

**2. Fetch details → get titles/journals/years.** `esummary.fcgi`
```
GET esummary.fcgi?db=pubmed&retmode=json&id=<PMID1,PMID2,PMID3>
```
- From `result[<pmid>]` read `title`, `fulljournalname` (or `source`), `pubdate`,
  and `authors[0].name` (first author → "et al.").
- Need the abstract to actually answer? Fetch it:
  `GET efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=<PMIDs>`

**3. Answer from what you read, and cite.** Synthesize the abstracts/summaries — do not pad
with unsourced memory. Cite each PMID INLINE next to the claim it supports, e.g. "(PMID: 36628825)". Do NOT append a Sources/References list — the app renders your inline PMIDs as clickable source pills automatically:
```
- First-author et al. Title. Journal. Year. PMID: 12345678
  https://pubmed.ncbi.nlm.nih.gov/12345678/
```

## Non-negotiable honesty rules (this is the moat — do not break it)
- **Never invent a PMID, title, author, journal, or year.** Only cite what step 2/3 actually returned. A fabricated citation is worse than no citation.
- **If the search returns nothing**, say plainly: "I couldn't find PubMed literature on this" — do not fall back to unsourced claims dressed up as evidence.
- **Separate evidence from inference.** If you reason beyond what a source states, label it ("Based on the mechanism, likely…") rather than implying the paper said it.
- **High-stakes specifics.** For exact dosing in a real patient, overdose, or pregnancy questions, say once, in context, that the current official label or a preceptor should confirm — no boilerplate disclaimers.
- Prefer recent (last ~10 yr) and higher-tier evidence (guidelines, systematic reviews, RCTs) when they exist; note when the best available is weaker.

## Practical notes
- NCBI rate-limits ~3 requests/sec unauthenticated — do the 2-3 calls sequentially, don't fan out dozens.
- If a query is too broad (thousands of hits) tighten it; too narrow (0 hits) loosen synonyms (generic ↔ brand, MeSH terms).
- Keep it tight: 5-8 PMIDs is plenty for a study answer; you don't need 40.

## Example
> Student: "Why do ACE inhibitors cause a cough and what do you switch to?"
1. `esearch … term=ACE+inhibitor+cough+AND+angiotensin+receptor+blocker`
2. `esummary … id=<top PMIDs>` → titles/journals/years
3. Answer: bradykinin accumulation → cough; ARBs spare bradykinin so they don't — with the real PMIDs cited inline where each claim is made.
