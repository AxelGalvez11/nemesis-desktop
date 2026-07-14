# DailyMed Navigation Reference

Real-world notes on navigating DailyMed (dailymed.nlm.nih.gov) for FDA label retrieval
when openFDA is unavailable. Captured during a tesamorelin label lookup session.

## Page Structure (Search Results)

After searching by drug name, DailyMed returns a list of matching labels. Each result
includes:

- **Heading**: Brand name + generic name + dosage form, e.g.
  `EGRIFTA SV (tesamorelin) kit` or `EGRIFTA WR (tesamorelin) kit`
- **NDC Code**: e.g. `62064-241-30`
- **Packager**: e.g. `Theratechnologies Inc.`

### Formulation suffixes
- `SV` = newer/current formulation
- `WR` = older/prior formulation
- When both exist, prefer the one with the more recent label update date

## Page Structure (Label View)

After clicking a label, the page has a `DRUG LABEL INFORMATION` panel with sections:

| Label Section | What It Contains |
|---|---|
| HIGHLIGHTS OF PRESCRIBING INFORMATION | Condensed prescribing info |
| 1 INDICATIONS AND USAGE | Approved indication(s) |
| 2 DOSAGE AND ADMINISTRATION | Dosing regimen, route, preparation |
| 3 DOSAGE FORMS AND STRENGTHS | What the product looks like |
| 4 CONTRAINDICATIONS | Who should NOT take it |
| 5 WARNINGS AND PRECAUTIONS | Safety concerns |
| 6 ADVERSE REACTIONS | Side effect profile |
| 7 DRUG INTERACTIONS | Clinically significant interactions |
| 8 USE IN SPECIFIC POPULATIONS | Pregnancy, renal/hepatic impairment, etc. |
| 11 DESCRIPTION | Chemical/pharmacologic description |

### Reading Content

Each section title is a clickable link. The accessibility tree shows a **truncated
preview** (first ~150 chars) when collapsed. Click the section link to expand the
full text -- the browser_snapshot will then show the expanded content.

The page metadata (top of the `DRUG LABEL INFORMATION` panel) shows:
- `Updated <date>` -- e.g. `Updated December 23, 2025`

## Workflow Summary

1. Navigate to `https://dailymed.nlm.nih.gov/dailymed/index.cfm`
2. Type drug name in search box, click Search
3. Identify correct label from results (prefer current formulation, check update date)
4. Click the label link to open
5. Click individual section links to expand full content
6. Read and cite with `FDA label via DailyMed (Brand, updated <date>)`

## Known Limitations

- No public JSON API as simple as openFDA -- browser navigation required
- Sections must be expanded individually (collapsed by default)
- Some very old drugs may have multiple legacy setids
- Does not include non-FDA-registered products
