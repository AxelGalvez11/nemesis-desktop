---
name: openfda-drug-label
description: "Look up official FDA drug labeling (indications, dosing, warnings, contraindications, adverse reactions, boxed warnings, drug interactions) from openFDA — the authoritative source for what a drug's label actually says. Use for any question about approved use, dosing, or safety of a specific medication."
version: 1.2.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [openfda, fda, drug, label, dosing, indications, warnings, contraindications, adverse-effects, boxed-warning, interactions, medication, pharmacy]
    related_skills: [pubmed-evidence]
---

# openFDA Drug Label

Answer "what does the label say" questions from the **official FDA labeling**, not memory.
For a pharmacy/health-sciences student this is the source of truth for approved indications,
dosing, contraindications, warnings, and boxed (black-box) warnings. You have the `web` tool —
openFDA is a plain HTTPS GET JSON API, no key needed for light use.

## When to use
Any question about a specific drug's **approved use, dose, safety, warnings, contraindications,
interactions, or adverse reactions** ("What's the boxed warning on X?", "renal dosing of Y?",
"contraindications for Z?"). For evidence from studies/comparisons use [[pubmed-evidence]] instead
(or alongside — label for "what's approved", PubMed for "what does the research show").

## The call
Base: `https://api.fda.gov/drug/label.json`
```
GET https://api.fda.gov/drug/label.json?search=openfda.generic_name:"<drug>"&limit=1
```
- Search by `openfda.generic_name:"lisinopril"` (generic) or `openfda.brand_name:"Prinivil"` (brand). Quote multi-word names.
- The response `results[0]` is the label. Useful fields (each an array of text blocks):
  `indications_and_usage`, `dosage_and_administration`, `contraindications`, `warnings` /
  `warnings_and_cautions`, `boxed_warning`, `adverse_reactions`, `drug_interactions`,
  `use_in_specific_populations` (pregnancy/renal/hepatic/pediatric/geriatric), `mechanism_of_action`,
  `how_supplied`. Read only the fields the question needs — these blocks are long.
- Narrow further with `+AND+`: e.g. `search=openfda.generic_name:"metformin"+AND+_exists_:boxed_warning`.

## Rules (same trust posture as the whole product)
- **Quote/paraphrase only what the label returned.** Never invent a warning, dose, or contraindication. If a field is absent, say "the label doesn't list a boxed warning" rather than guessing.
- **Cite the source.** Mention inline, where the claim is made, that it comes from the FDA label via openFDA (generic: <name>), with the label URL if useful. Do NOT append a trailing Source/Sources section — inline citations become clickable pills automatically.
- **High-stakes specifics.** For exact dosing decisions, overdose, or pregnancy questions, note once, in context, that the current official label or a preceptor should confirm — no boilerplate disclaimers.
- If the drug isn't found, loosen: try the other of generic/brand, check spelling, or fall back to [[pubmed-evidence]].
- openFDA rate-limits unauthenticated (~40 req/min, 1000/day) — one or two calls per question is plenty.

## Drug status: "is X discontinued / in shortage / recalled?"

FAST-lane: issue the 2–3 GETs below TOGETHER in one turn, then answer. Three different
databases answer three different things — check the ones the question implies:

**Marketing status (discontinued or not)** — Drugs@FDA:
```
GET https://api.fda.gov/drug/drugsfda.json?search=openfda.brand_name:"<brand>"&limit=1
```
`results[0].products[]` — each strength/form carries `marketing_status`: `Prescription` /
`Over-the-counter` = actively marketed; `Discontinued` = no longer marketed. Report per
strength when they differ ("the 3 mg is discontinued; the 7 and 14 mg remain marketed").

**Shortage / availability** — FDA Drug Shortages database:
```
GET https://api.fda.gov/drug/shortages.json?search=generic_name:"<generic>"&limit=5
```
Fields: `status` (`Current` / `Resolved` / `To Be Discontinued`), `shortage_reason`,
`update_date`, `presentation`. This catches ANNOUNCED discontinuations before Drugs@FDA
flips — a product can be `Prescription` there yet listed `To Be Discontinued` here.
Always check it when the question is about availability or discontinuation.

**Recalls** — enforcement reports:
```
GET https://api.fda.gov/drug/enforcement.json?search=product_description:"<drug>"&limit=5
```
Fields: `status` (`Ongoing`/`Completed`/`Terminated`), `classification` (Class I = serious
harm risk, II = temporary/reversible harm, III = unlikely harm), `reason_for_recall`,
`recall_initiation_date` (YYYYMMDD). Most recalls are specific lots/batches, not the whole
drug — say so plainly.

Answer with the signals TOGETHER: "Not discontinued — every strength is still marketed per
Drugs@FDA — but FDA's availability database lists it 'To Be Discontinued' as of <date>"
beats a bare yes/no. Cite inline: `Drugs@FDA via openFDA (<drug>)`, `FDA drug shortage
database (updated <date>)`.

## Fallback: DailyMed (when openFDA is down or times out)

If the openFDA API returns no data, times out (common in some hosting environments), or
the drug is a biologic/old enough that openFDA's label index doesn't carry it, switch to
**DailyMed** (NIH/NLM's database of FDA labeling). DailyMed HAS a REST API — use it first;
drive the browser only when you actually need to read long label sections.

**Workflow (API-first):**

1. Find the current label set:
   `GET https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?drug_name=<name>&pagesize=5`
   → each hit has `setid`, `title` (product + manufacturer), `published_date`. Pick the most
   recently published entry for the product asked about (current formulations usually carry
   the newer suffix, e.g. `EGRIFTA SV` is current; `EGRIFTA WR` is an older formulation).
2. Read the label — either:
   - open `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=<setid>` directly in the
     school browser and read the needed sections from the `DRUG LABEL INFORMATION` panel
     (sections are collapsed and show truncated previews — click a section link to expand
     it before reading), or
   - fetch the full SPL document `GET …/services/v2/spls/<setid>.xml` (plain XML, roughly
     100–500 KB) and read just the section you need from it.
3. Cite with the update date: `FDA label via DailyMed (<product>, updated <published_date>)`.

**Pitfalls:**
- Multiple setids per drug (brand vs generic, old vs new formulation) — pick the most
  recent `published_date` that matches the product actually asked about.
- In the browser, collapsed sections show truncated preview text only — expand first.
- No DailyMed entry either → fall back to [[pubmed-evidence]] for a literature-based answer.

## Example (standard openFDA)
> "What's the boxed warning for metformin, and when is it contraindicated?"
1. `GET .../drug/label.json?search=openfda.generic_name:"metformin"&limit=1`
2. Read `boxed_warning` (lactic acidosis) + `contraindications` (severe renal impairment eGFR <30, acute/unstable HF, metabolic acidosis).
3. Answer in plain language, quote the boxed-warning phrasing, cite `FDA label via openFDA (metformin)`, add the verify-with-instructor line.

## Example (DailyMed fallback)
> "What's the label for tesamorelin?"
1. openFDA search timed out -- switch to DailyMed fallback
2. `GET …/services/v2/spls.json?drug_name=tesamorelin` → `EGRIFTA SV` (newer published_date)
   and `EGRIFTA WR` (older formulation)
3. Open `drugInfo.cfm?setid=<EGRIFTA SV setid>` in the school browser -- label updated
   December 23, 2025
4. Read key sections from the DRUG LABEL INFORMATION panel:
   - Indication: reduction of excess abdominal fat in HIV-infected adult patients with lipodystrophy
   - Contraindications: disruption of hypothalamic-pituitary axis, pregnancy
   - Warnings: increased risk of neoplasms, elevated IGF-1
   - Dosage: 2 mg SC once daily
5. Cite as `FDA label via DailyMed (Egrifta SV, updated Dec 2025)`

## See also
references/dailymed-navigation.md -- detailed notes on DailyMed page structure, section
expansion patterns, and real-world label lookups performed via this method.
