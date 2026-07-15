"""Record-replay recipes for cheap, deterministic browser workflows.

The most expensive thing the school agent does is drive a browser in an LLM loop —
every step re-sends the whole conversation. A *recipe* removes the model from repeat
runs entirely: the first time the agent works out a data-extraction workflow (sweep
Blackboard courses, pull this week's assignments), it saves the navigate + JS-eval
steps that worked; every later run *replays* those steps with ZERO model calls and
returns the extracted data directly.

Design choices that make this robust and safe:

* We record the ``browser_console`` **JS-eval scripts** that worked, not click
  trajectories. A ``document.querySelectorAll(...)`` extraction is far more resilient
  to layout changes than a recorded pixel/ref click, and it returns structured data
  in one shot — which is already the app's cheap path.
* Replay reuses the exact ``browser_navigate`` / ``browser_console`` functions the
  agent uses, so it inherits their CDP handling, eval policy, SSRF guards, and output
  redaction. This module adds no new browser plumbing.
* Replay rides the student's already-authenticated browser session (they logged in
  once). Recipes therefore store only URLs + JS selectors — never cookies, tokens, or
  credentials.
* A recipe that goes **stale** (a step errors, or an extraction returns empty where
  data was expected) does NOT raise — it returns ``{"stale": true}`` so the agent
  falls back to a normal discovery sweep and re-saves the fresh steps.

Storage: ``~/Documents/Nemesis Library/.nemesis/recipes/<slug>.json`` (per student,
alongside their own data). Override with ``NEMESIS_RECIPES_DIR`` (used by tests).
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

MAX_STEPS = 40
_SLUG_RE = re.compile(r"[^a-z0-9]+")


# ── Storage ────────────────────────────────────────────────────────────────

def _recipes_dir() -> Path:
    override = os.environ.get("NEMESIS_RECIPES_DIR")
    base = Path(override) if override else Path(
        os.path.expanduser("~/Documents/Nemesis Library/.nemesis/recipes")
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _slug(name: str) -> str:
    slug = _SLUG_RE.sub("-", name.strip().lower()).strip("-")
    return slug or "recipe"


def _recipe_path(name: str) -> Path:
    return _recipes_dir() / f"{_slug(name)}.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Pure validation / classification (unit-tested without a browser) ─────────

def validate_steps(steps: Any) -> Optional[str]:
    """Return an error string if ``steps`` isn't a valid recipe body, else None."""
    if not isinstance(steps, list) or not steps:
        return "steps must be a non-empty list"
    if len(steps) > MAX_STEPS:
        return f"too many steps ({len(steps)} > {MAX_STEPS})"
    for i, step in enumerate(steps):
        if not isinstance(step, dict):
            return f"step {i} is not an object"
        kind = step.get("kind")
        if kind == "navigate":
            url = step.get("url")
            if not isinstance(url, str) or not url.strip():
                return f"step {i} (navigate) needs a non-empty 'url'"
            if not re.match(r"^https?://", url.strip(), re.IGNORECASE):
                return f"step {i} (navigate) url must be http(s): {url!r}"
        elif kind == "eval":
            expr = step.get("expression")
            if not isinstance(expr, str) or not expr.strip():
                return f"step {i} (eval) needs a non-empty 'expression'"
            key = step.get("as")
            if not isinstance(key, str) or not key.strip():
                return f"step {i} (eval) needs an 'as' key to store its result"
            if "expect_nonempty" in step and not isinstance(step["expect_nonempty"], bool):
                return f"step {i} (eval) 'expect_nonempty' must be a boolean"
        else:
            return f"step {i} has unknown kind {kind!r} (want 'navigate' or 'eval')"
    return None


def _is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, (str, list, dict, tuple)):
        return len(value) == 0
    return False


def classify_eval_result(console_json: str, expect_nonempty: bool) -> Dict[str, Any]:
    """Read a ``browser_console`` eval return and decide ok / stale / errored.

    Pure: takes the JSON string the tool returned. Returns
    ``{"ok": bool, "value": Any, "stale_reason": str|None, "error": str|None}``.
    A JS error is ``error`` (something broke); an empty extraction where data was
    expected is ``stale_reason`` (the page changed) — the agent handles them the same
    way (fall back + re-map) but we keep the distinction for honest reporting.
    """
    try:
        parsed = json.loads(console_json)
    except (json.JSONDecodeError, ValueError):
        return {"ok": False, "value": None, "stale_reason": None,
                "error": "eval returned non-JSON output"}
    if not isinstance(parsed, dict):
        return {"ok": False, "value": None, "stale_reason": None,
                "error": "eval returned an unexpected shape"}
    if not parsed.get("success", False):
        return {"ok": False, "value": None, "stale_reason": None,
                "error": str(parsed.get("error") or "eval failed")}
    value = parsed.get("result")
    if expect_nonempty and _is_empty(value):
        return {"ok": False, "value": value,
                "stale_reason": "extraction returned nothing (page likely changed)",
                "error": None}
    return {"ok": True, "value": value, "stale_reason": None, "error": None}


# ── Tool surface (agent-callable) ────────────────────────────────────────────

def save_recipe(name: str, steps: Any, *, now_iso: Optional[str] = None) -> str:
    """Save a navigate+eval recipe. Preserves the original 'created' on re-save."""
    if not isinstance(name, str) or not name.strip():
        return json.dumps({"success": False, "error": "recipe needs a name"})
    if isinstance(steps, str):
        try:
            steps = json.loads(steps)
        except (json.JSONDecodeError, ValueError):
            return json.dumps({"success": False, "error": "steps was a string but not valid JSON"})
    err = validate_steps(steps)
    if err:
        return json.dumps({"success": False, "error": err})

    path = _recipe_path(name)
    created = now_iso or _now_iso()
    if path.exists():
        try:
            created = json.loads(path.read_text()).get("created", created)
        except (OSError, json.JSONDecodeError, ValueError):
            pass
    recipe = {
        "name": name.strip(),
        "version": 1,
        "created": created,
        "updated": now_iso or _now_iso(),
        "steps": steps,
    }
    try:
        path.write_text(json.dumps(recipe, ensure_ascii=False, indent=2))
    except OSError as exc:
        return json.dumps({"success": False, "error": f"could not write recipe: {exc}"})
    return json.dumps({
        "success": True,
        "name": recipe["name"],
        "slug": path.stem,
        "steps": len(steps),
        "message": f"Saved recipe '{recipe['name']}' ({len(steps)} steps). "
                   "Future runs can replay it with browser_recipe_run — no model calls.",
    }, ensure_ascii=False)


def list_recipes() -> str:
    try:
        files = sorted(_recipes_dir().glob("*.json"))
    except OSError as exc:
        return json.dumps({"success": False, "error": str(exc)})
    out: List[Dict[str, Any]] = []
    for path in files:
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError, ValueError):
            continue
        out.append({
            "name": data.get("name", path.stem),
            "slug": path.stem,
            "steps": len(data.get("steps", [])),
            "updated": data.get("updated"),
        })
    return json.dumps({"success": True, "recipes": out, "count": len(out)}, ensure_ascii=False)


def run_recipe(name: str, *, task_id: Optional[str] = None) -> str:
    """Replay a saved recipe deterministically — no model calls.

    Returns extracted data keyed by each eval step's ``as``, or ``stale: True`` when a
    step no longer works so the agent knows to do a fresh discovery sweep and re-save.
    """
    path = _recipe_path(name)
    if not path.exists():
        return json.dumps({
            "success": False,
            "error": f"No recipe named '{name}'. Use browser_recipe_list to see saved recipes.",
        })
    try:
        recipe = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return json.dumps({"success": False, "error": f"recipe unreadable: {exc}"})
    steps = recipe.get("steps", [])
    err = validate_steps(steps)
    if err:
        return json.dumps({"success": False, "error": f"recipe is malformed: {err}"})

    # Lazy import breaks the module cycle (browser_tool imports us for registration).
    from tools.browser_tool import browser_navigate, browser_console

    data: Dict[str, Any] = {}
    for i, step in enumerate(steps):
        if step["kind"] == "navigate":
            browser_navigate(step["url"], task_id=task_id)
            continue
        # eval step
        expect_nonempty = step.get("expect_nonempty", True)
        console_json = browser_console(expression=step["expression"], task_id=task_id)
        verdict = classify_eval_result(console_json, expect_nonempty)
        if not verdict["ok"]:
            return json.dumps({
                "success": True,
                "stale": True,
                "at_step": i,
                "as": step.get("as"),
                "reason": verdict["stale_reason"] or verdict["error"] or "step failed",
                "message": "This recipe no longer works — the page probably changed. "
                           "Do a normal discovery sweep, then browser_recipe_save the "
                           "fresh steps to repair it.",
                "partial_data": data,
            }, ensure_ascii=False, default=str)
        data[step["as"]] = verdict["value"]

    return json.dumps({
        "success": True,
        "stale": False,
        "steps": len(steps),
        "data": data,
        "message": f"Replayed '{recipe.get('name', name)}' with no model calls.",
    }, ensure_ascii=False, default=str)
