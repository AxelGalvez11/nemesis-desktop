---
name: clinical-trials
description: "Search ClinicalTrials.gov for real clinical studies on a drug, disease, or intervention — status (recruiting/completed), phase, sponsor, eligibility, outcomes. Use for 'is there a trial for X', 'what's being studied', evidence pipeline, or research-methods questions."
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [clinicaltrials, trials, ctgov, nct, studies, recruiting, phase, sponsor, research, evidence, drug-development]
    related_skills: [pubmed-evidence, openfda-drug-label]
---

# ClinicalTrials.gov

Answer "what's being studied / is there a trial" questions from the **official U.S. trials
registry**, with real NCT numbers a student can open. Complements [[pubmed-evidence]] (published
findings) and [[openfda-drug-label]] (approved labeling): this is the live pipeline of ongoing and
completed studies. You have the `web` tool — the v2 API is plain HTTPS GET JSON, no key.

## When to use
"Is there a trial for <drug/condition>?", "what phase is <drug> in for <indication>?", "who's
sponsoring research on X?", "find recruiting studies for <condition>", or research-methods/evidence
questions where knowing the trial landscape matters.

## The call
Base: `https://clinicaltrials.gov/api/v2/studies`
```
GET https://clinicaltrials.gov/api/v2/studies?query.term=<terms>&pageSize=8&fields=NCTId,BriefTitle,OverallStatus,Phase,LeadSponsorName,Condition,InterventionName
```
- `query.term=` free text (drug + condition works well, e.g. `semaglutide weight loss`). Or target fields: `query.cond=<disease>`, `query.intr=<intervention>`.
- Filter status with `filter.overallStatus=RECRUITING` (or COMPLETED, ACTIVE_NOT_RECRUITING, TERMINATED…).
- Read each study under `studies[].protocolSection`: `identificationModule.nctId` + `.briefTitle`,
  `statusModule.overallStatus`, `designModule.phases`, `sponsorCollaboratorsModule.leadSponsor.name`,
  `conditionsModule.conditions`, `armsInterventionsModule.interventions`,
  `eligibilityModule.eligibilityCriteria` (fetch when the question is about who qualifies).
- Detail on one study: `GET …/api/v2/studies/<NCTId>`.

## Rules
- **Only cite trials the API returned** — real NCT IDs, titles, statuses. Never fabricate an NCT number.
- **Cite each trial INLINE** next to the claim, as `... (NCT01234567)`. The NCT id becomes a clickable pill automatically — no trailing list of links needed.
- **Registry ≠ result.** A registered or recruiting trial is not evidence of efficacy; say so. For "does it work" use published results ([[pubmed-evidence]]), not the mere existence of a trial. Note when a trial is terminated/withdrawn.
- If nothing matches, say so and suggest loosening terms (generic↔brand, broader condition).
- Keep it to 5-8 studies; summarize the landscape (how many, phases, key sponsors) rather than dumping all.

## Example
> "Are there trials using semaglutide for Alzheimer's?"
1. `GET …/studies?query.intr=semaglutide&query.cond=Alzheimer&pageSize=8&fields=NCTId,BriefTitle,OverallStatus,Phase,LeadSponsorName`
2. Summarize: e.g. Phase 3 program (EVOKE/EVOKE+) by Novo Nordisk, status, plus any others.
3. Cite each with its NCT link; note these are ongoing/registered, not proof of benefit.
