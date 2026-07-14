---
name: nemesis-images
description: Generate images (diagrams, illustrations, study visuals) through the metered Nemesis image service and deliver them inline in chat or into the Library
---

# Image generation

Nemesis provides (and bills for) image generation — the student never needs an API key.
Use it when the student asks for an illustration, a visual explainer, deck art, or when
a study material genuinely benefits from a generated picture. Prefer REAL sourced images
(per nemesis-deliverables "Image sourcing") for factual/clinical figures — generate when
no real image fits (custom diagrams, mnemonics, stylized study art).

## How to generate (one shell call)

The metering device key is already in the backend environment (`DEEPSEEK_API_KEY`, a
`nmk_...` key — it authenticates ALL Nemesis services, not just chat). Fallback: read it
from `$HERMES_HOME/.env`.

```bash
KEY="${DEEPSEEK_API_KEY:-$(grep -o 'nmk_[0-9a-f]*' "${HERMES_HOME:-$HOME/.nemesis}/.env" 2>/dev/null | head -1)}"
OUT="$HOME/Documents/Nemesis Library/Media/gen-$(date +%s).png"
curl -s -m 120 "https://qyjmivntajbigjswhahb.supabase.co/functions/v1/nemesis-media/images/generations" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "$(python3 -c 'import json,sys; print(json.dumps({"prompt": sys.argv[1]}))' "YOUR PROMPT HERE")" \
| python3 -c "
import sys, json, base64, pathlib
r = json.load(sys.stdin)
if 'error' in r:
    print('GENERATION FAILED:', r['error'].get('message', r['error']) if isinstance(r['error'], dict) else r['error'])
    raise SystemExit(1)
p = pathlib.Path('$OUT'); p.parent.mkdir(parents=True, exist_ok=True)
p.write_bytes(base64.b64decode(r['data'][0]['b64_json']))
print(p)
"
```

- On success the script prints the saved file path. Deliver it inline by including
  `MEDIA:/absolute/path/to/file.png` on its own line in your reply.
- Save into `~/Documents/Nemesis Library/Media/` with a DESCRIPTIVE name
  (`synapse-diagram.png`, not `gen-123.png`) when the image belongs to coursework;
  ledger-log the creation (nemesis-ledger).

## Rules

- **Write a real prompt.** Describe subject, style ("clean textbook diagram", "flat
  illustration"), background, and any labels. One retry with a refined prompt if the
  first result misses; don't loop.
- **Budget:** image generation is metered per plan per day (the response includes
  `remaining`). On `daily_image_budget_exhausted` (429), tell the student plainly it
  resets at midnight UTC — don't retry.
- **If the service says billing/not configured:** say image generation isn't enabled
  yet and move on — never ask the student for an API key.
- **Academic integrity unchanged:** generated images are study aids and drafts; never
  pass one off as real data, a real micrograph, or a real clinical photo — say it's
  AI-generated in the caption when it appears in a deliverable.
