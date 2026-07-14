---
name: nemesis-spreadsheet
description: "Read and reason over the student's spreadsheets — Excel (.xlsx), CSV, TSV. Compute real statistics IN CODE (never eyeball numbers), summarize gradebooks/lab data/datasets, answer questions about them, and turn them into notes or study material. Use when the student shares a .xlsx/.csv/.tsv or asks about a spreadsheet, gradebook, dataset, or lab results."
version: 1.0.0
metadata:
  hermes:
    tags: [spreadsheet, excel, xlsx, csv, tsv, gradebook, dataset, statistics, data, lab]
    related_skills: [nemesis-import, nemesis-study-decks]
---

# Spreadsheets

Students bring data in three shapes — Excel `.xlsx`, `.csv`, `.tsv` — gradebooks, lab
results, datasets, dosing tables. Read them, reason over them, and **compute every number
in code**. Never estimate a mean, count, or total by eye: a made-up statistic is exactly
the kind of confident-wrong answer that destroys trust.

## Reading them

**CSV / TSV** — plain text; read the file directly, or with Python's stdlib `csv`
(no dependency). Detect the delimiter (comma vs tab) from the content.

**Excel `.xlsx`** — use `openpyxl` (installed in the student build). Minimal recipe:
```python
import openpyxl
wb = openpyxl.load_workbook("<path>", data_only=True)   # data_only = computed values, not formulas
for name in wb.sheetnames:
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    header, body = rows[0], rows[1:]
```
- `data_only=True` returns the last-computed value of formula cells (what the student sees),
  not the `=SUM(...)` text.
- Multi-sheet files: report which sheets exist; work the one the student means (ask if unclear).
- Old `.xls` (not `.xlsx`) isn't supported by openpyxl — ask the student to re-save as `.xlsx`.

**Reason in code, not in your head.** For any statistic — mean, median, stdev, min/max,
counts, group-bys, correlations, "who's failing", "class average per exam" — write and run
a short Python snippet over the parsed rows and report what it computed. Show the number AND
one line on how you got it ("mean of column Exam1 across 42 rows"). This honors the product
rule that meta/stats are computed, never guessed.

## What to do with them

- **Summarize**: shape (rows × columns), what each column is, obvious data-quality issues
  (blanks, mixed types, outliers) — briefly.
- **Answer questions**: compute the specific thing asked; don't dump the whole sheet.
- **Gradebooks**: per-assignment averages, the student's own standing vs class, trend across
  exams, what to focus on. Be encouraging and specific.
- **Turn into study material**: a lab dataset or a drug/dosing table can become a note or a
  flashcard deck (per nemesis-study-decks) — offer it, don't force it.

## Rules
- Compute, never eyeball. Every reported number traces to code you ran.
- Read-only unless the student asks you to produce a new file; then WRITE a copy, never
  overwrite their original.
- Big files: report row/column counts first; summarize rather than pasting thousands of cells.
- Log a ledger entry when you import a spreadsheet into the Library or create a file from one.
