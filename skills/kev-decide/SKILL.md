---
name: kev-decide
description: Use Kev fixed-choice classification to filter search results before they enter the main context, classify folder-wide file sets, or independently process document and table collections.
---

# Kev decide

Use `kev_decide` only when the work can be framed as 2–12 mutually exclusive choices. It is suited to search-result triage, file classification, and document routing—not open-ended summaries.

1. Supply explicit, concrete choices and define what each means.
2. Submit text, files, or folders to `kev_decide`.
3. Poll `kev_decide_status` in small pages for large jobs.
4. Review low-confidence and consequential decisions against each result's `evidence` range.
5. Report skipped inputs and never expose sensitive values from classified files.
