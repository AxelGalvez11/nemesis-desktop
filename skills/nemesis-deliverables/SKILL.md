---
name: nemesis-deliverables
description: Generate slide decks, reports, handouts, and one-pagers for the student — build files, preview inline, cite real sources
---

# Generate deliverables (slides, reports, handouts)

Use this skill when the student asks for a slide deck, presentation, report, brief,
handout, or one-pager. You BUILD A FILE and the app previews it beside the chat.

## The mechanism

1. Write ONE self-contained HTML file to `~/Documents/Nemesis Library/Exports/<Title>.html`
   (create the folder if missing; use the absolute home path, not `~`, when you write).
2. Everything inline: CSS in a `<style>` tag, no external fonts, images, or scripts.
3. The file appears automatically in the app's Library under the Exports folder, where
   it previews live — always tell the student it's there ("It's in Library → Exports").
4. ALSO end your reply with this EXACT link on its own final line (it opens the deck in
   the chat's side panel instantly). This must be the literal markdown token, not prose:
   `[Preview: <Title>](#preview/<URL-ENCODED ABSOLUTE FILE PATH>)`
   — URL-encode the absolute path (spaces → %20). Do not describe it in words instead;
   emit the actual `[Preview: …](#preview/…)` link or the panel won't open.
5. Mention that Print → Save as PDF (from the preview) gives them the PDF file.

## Hard rules

- **Grounding**: every fact, number, and citation comes from this conversation or from
  sources you actually retrieved. Cite inline (PMID/NCT/label) in small type on the
  slide or paragraph where the claim lives. Never invent content to fill a slide.
- **No product branding** in the file. No "Nemesis", no logos — the student presents
  this as their own work aid. Neutral, professional design only.
- Drafts, not submissions: you never submit or upload the deliverable anywhere.
- **Context economy**: research findings, outlines, and source excerpts go into a
  working file (`.nemesis/scratch/<topic>-notes.md`) AS you gather them — build the
  deliverable by reading that file, not by re-printing material into the conversation.
  Long deliverable jobs re-read the whole conversation every step; a lean conversation
  is the difference between a 2M-token job and a 9M-token job on the student's meter.

## Image sourcing (drug/clinical slide decks)

When the student asks for a drug literature overview or clinical slide deck:

1. **Search for real web images first** — don't default to hand-drawn SVGs or inline icon-only layouts.
   - Wikimedia Commons (commons.wikimedia.org) — chemical structures, molecule SVGs
   - Open-access journal figures (Nature Communications, Cell Discovery, PLOS, BMJ Open, etc.) — cryo-EM structures, mechanism diagrams, trial outcome figures
   - Pharmaceutical company press release images / infographics
   - PubMed Central (pmc.ncbi.nlm.nih.gov) — figures from open-access full texts
2. **Cite the image source** in a caption below each image (journal name, license type, URL).
3. **Fallback to inline SVGs** only when no freely usable real image exists for that concept.
4. **Check image loads** — if an image URL 404s, skip that image rather than leaving a broken link.

## References slide — required for literature decks

Every academic/literature overview deck MUST end with a dedicated references slide that includes:
- Numbered list of all sources cited inline
- Hyperlinked PMIDs, DOI URLs, or press release URLs
- A disclaimer line: "Investigational — Not FDA approved" or equivalent for the drug's regulatory status

## Dual-format for inline preview

- If the student asks for **.pptx**: build the pptx file, BUT ALSO create an HTML version in the same pass so it can preview in the side panel. Tell the student both exist.
- The HTML version is the primary deliverable for preview; the .pptx is for editing in PowerPoint.
- The final reply MUST include the `[Preview: …](#preview/…)` link to the HTML file.

## Deep-research-to-deck workflow (literature overviews)

For a drug literature overview, do this in order before building slides:

1. **Deep research pass** — launch 4–8 searches simultaneously (PubMed, web, ClinicalTrials.gov, openFDA):
   - Mechanism / pharmacology search (e.g. "retatrutide mechanism GIP GLP-1 glucagon")
   - Phase 2/3 trial search (e.g. "retatrutide phase 3 obesity diabetes results")
   - Safety/tolerability search (e.g. "retatrutide adverse effects")
   - Meta-analysis/systematic review search
2. **Extract key data** from the best sources — extract full tables and figures from press releases, meta-analyses, and landmark trials.
3. **Image search** — Wikimedia Commons, open-access journal figures for that drug.
4. **Build the deck** in this structure:
   - Slide 1: Title (drug name, class, subtitle, date)
   - Slide 2: What is it? / mechanism (with card layout for multi-receptor drugs)
   - Slide 3: Why it matters / evolution from prior therapies (comparison table)
   - Slide 4–7: Key trials (phase 2, phase 3 by indication) with data tables
   - Slide 8: Safety profile (AE table, discontinuation rates)
   - Slide 9: Meta-analysis / pooled evidence if available
   - Slide 10: Key takeaways + pipeline
   - Slide 11+: References (numbered, hyperlinked)

## Slide deck format

- 16:9 sections, one `<section class="slide">` per slide; first slide = title + subtitle
  + date; content slides ≤ 5 bullets or one focused diagram/table; last slide =
  references list. 6–11 slides is the sweet spot.
- Base CSS (adapt colors/spacing, keep structure):

```html
<style>
  * { margin: 0; box-sizing: border-box; }
  html { scroll-snap-type: y mandatory; }
  body { font: 18px/1.55 -apple-system, "Segoe UI", sans-serif; color: #1a1a1a; background: #eceff1; }
  .slide { width: 100vw; height: 100vh; scroll-snap-align: start; padding: 7vh 9vw;
    display: flex; flex-direction: column; justify-content: center; background: #fff;
    border-bottom: 1px solid #e0e0e0; page-break-after: always; position: relative; }
  h1 { font-size: 2.6em; letter-spacing: -0.02em; line-height: 1.15; }
  h2 { font-size: 1.7em; letter-spacing: -0.01em; margin-bottom: 0.8em; }
  ul { padding-left: 1.1em; } li { margin: 0.45em 0; }
  .kicker { text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.7em;
    color: #b3382e; font-weight: 600; margin-bottom: 1.2em; }
  .cite { position: absolute; bottom: 4vh; left: 9vw; right: 9vw; font-size: 0.65em;
    color: #777; }
  .num { position: absolute; bottom: 4vh; right: 5vw; font-size: 0.7em; color: #aaa; }
  @media print { .slide { height: 100vh; } @page { size: landscape; margin: 0; } }
</style>
```

## Report / handout format

- A4-ish document: title block (title, course, date), section headings, short paragraphs,
  tables where they beat prose, references section at the end with PMIDs as
  `https://pubmed.ncbi.nlm.nih.gov/<id>/` links.
- Base CSS: max-width 46rem centered, 16px/1.65 system sans, h1 2em with a thin bottom
  rule, h2 1.3em with 2em top margin, tables full-width with 1px #ddd borders and a
  shaded header row, `.cite` footnote size #777, `@page { margin: 2cm }` for print.

## Example ending of a reply

"Saved to Library → Exports. Print → Save as PDF when you need the file.
[Preview: ACE inhibitor cough — 6 slides](#preview/%2FUsers%2Fjane%2FDocuments%2FNemesis%20Library%2FExports%2FACE%20inhibitor%20cough.html)"
