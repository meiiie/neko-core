---
name: deliverable-contract
description: Lock the exact deliverable contract (file names, formats, sheet/section/column names, required elements) before work and re-verify every saved deliverable from disk before finishing.
match: \b(?:deliverables?|output (?:directory|folder)|save (?:the )?(?:final )?(?:files?|report|workbook|memo)s?|san pham ban giao)\b
---

# Deliverable contract — the request owns the shape

The most common silent loss on deliverable tasks is not wrong analysis but a deliverable whose SHAPE differs from what was asked: a renamed sheet, a missing section, a wrong file name or format, a requested chart or value left out. Writing a file successfully is execution evidence, not completion evidence.

## 1. Before doing the work: write the contract

As soon as you have read the full task (including any instruction file it points to), write `contract.md` in a scratch location OUTSIDE the output directory, listing verbatim:

- every deliverable file: exact name and extension, and where it must be saved;
- for each file, every named internal part: sheet names, tab order, section headings, column headers, slide titles, required fields;
- every required element: charts/visualizations, tables, specific values, counts ("five services", "two measures"), date or period, audience;
- explicit constraints: "only final deliverables in the output directory", length limits, format rules.

Copy names character-for-character from the request (case, spaces, punctuation, dashes). Do not paraphrase a required name; do not add your own sheets/columns to a fixed structure unless the request allows it.

## 2. Do the work against the contract

When a choice conflicts with the contract (e.g. a nicer sheet name), the contract wins. If the request is ambiguous or inputs conflict, choose, then state the reasoning inside the deliverable where the request asks for analysis.

## 3. Before finishing: reopen every deliverable from disk

Run a fresh process that opens each saved file and prints its actual structure, then compare item by item with `contract.md`. Example for common formats:

```bash
python3 - <<'PY'
import sys, pathlib
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "output")
for f in sorted(out.iterdir()):
    print("==", f.name, f.stat().st_size, "bytes")
    if f.suffix == ".xlsx":
        import openpyxl; wb = openpyxl.load_workbook(f)
        for ws in wb.worksheets:
            print("  sheet", repr(ws.title), ws.max_row, "x", ws.max_column, "charts", len(ws._charts),
                  "header", [c.value for c in next(ws.iter_rows(max_row=1))][:12])
    elif f.suffix == ".docx":
        import docx; d = docx.Document(f)
        print("  headings", [p.text for p in d.paragraphs if p.style.name.lower().startswith("heading")][:40])
    elif f.suffix == ".pdf":
        import subprocess; print(subprocess.run(["pdftotext", "-l", "2", str(f), "-"], capture_output=True, text=True).stdout[:1500])
    elif f.suffix in (".csv", ".md", ".txt"):
        print("  ", f.read_text(errors="replace")[:800])
PY
```

Then, for each contract line, mark PASS/FAIL with the observed evidence. Fix every FAIL and re-run the check. Confirm no scratch or intermediate files remain in the output directory. Only then give the final answer, listing the delivered files.
