"""Tests for the browser record-replay recipe harness (tools/browser_recipe.py)."""

import json
import sys
import types

import pytest

from tools import browser_recipe as br


@pytest.fixture(autouse=True)
def _isolated_recipes_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMESIS_RECIPES_DIR", str(tmp_path / "recipes"))
    yield


# ── validate_steps ───────────────────────────────────────────────────────────

def test_validate_accepts_navigate_and_eval():
    steps = [
        {"kind": "navigate", "url": "https://blackboard.example.edu/"},
        {"kind": "eval", "expression": "document.title", "as": "title"},
        {"kind": "eval", "expression": "[1,2]", "as": "nums", "expect_nonempty": True},
    ]
    assert br.validate_steps(steps) is None


@pytest.mark.parametrize("steps,needle", [
    ([], "non-empty list"),
    ("nope", "non-empty list"),
    ([{"kind": "navigate"}], "needs a non-empty 'url'"),
    ([{"kind": "navigate", "url": "ftp://x"}], "must be http"),
    ([{"kind": "eval", "as": "x"}], "needs a non-empty 'expression'"),
    ([{"kind": "eval", "expression": "1"}], "needs an 'as' key"),
    ([{"kind": "eval", "expression": "1", "as": "x", "expect_nonempty": "yes"}], "must be a boolean"),
    ([{"kind": "click"}], "unknown kind"),
    ([{"kind": "eval", "expression": "1", "as": "x"}] * 41, "too many steps"),
])
def test_validate_rejects_bad_steps(steps, needle):
    err = br.validate_steps(steps)
    assert err is not None and needle in err


# ── classify_eval_result ─────────────────────────────────────────────────────

def test_classify_ok_with_data():
    out = br.classify_eval_result('{"success": true, "result": ["a", "b"]}', True)
    assert out["ok"] is True and out["value"] == ["a", "b"]


def test_classify_empty_when_data_expected_is_stale():
    out = br.classify_eval_result('{"success": true, "result": []}', True)
    assert out["ok"] is False and out["stale_reason"] and out["error"] is None


def test_classify_empty_allowed_when_not_expecting_data():
    out = br.classify_eval_result('{"success": true, "result": []}', False)
    assert out["ok"] is True and out["value"] == []


def test_classify_js_error_is_error_not_stale():
    out = br.classify_eval_result('{"success": false, "error": "ReferenceError: x"}', True)
    assert out["ok"] is False and out["error"] and out["stale_reason"] is None


def test_classify_non_json_is_error():
    out = br.classify_eval_result("not json", True)
    assert out["ok"] is False and out["error"]


# ── save / list round-trip ───────────────────────────────────────────────────

def test_save_then_list_and_preserve_created():
    steps = [{"kind": "eval", "expression": "document.title", "as": "title"}]
    first = json.loads(br.save_recipe("Blackboard Sweep", steps, now_iso="2026-07-15T00:00:00+00:00"))
    assert first["success"] and first["slug"] == "blackboard-sweep"

    listed = json.loads(br.list_recipes())
    assert listed["count"] == 1 and listed["recipes"][0]["name"] == "Blackboard Sweep"

    # Re-save later keeps the original created timestamp, bumps updated.
    again = json.loads(br.save_recipe("Blackboard Sweep", steps, now_iso="2026-08-01T00:00:00+00:00"))
    assert again["success"]
    saved = json.loads((br._recipes_dir() / "blackboard-sweep.json").read_text())
    assert saved["created"] == "2026-07-15T00:00:00+00:00"
    assert saved["updated"] == "2026-08-01T00:00:00+00:00"


def test_save_rejects_invalid_steps():
    out = json.loads(br.save_recipe("bad", [{"kind": "nope"}]))
    assert out["success"] is False and "unknown kind" in out["error"]


def test_save_accepts_json_string_steps():
    steps_json = json.dumps([{"kind": "eval", "expression": "1", "as": "x"}])
    out = json.loads(br.save_recipe("stringy", steps_json))
    assert out["success"] is True and out["steps"] == 1


# ── run_recipe (browser stubbed) ─────────────────────────────────────────────

def _stub_browser(monkeypatch, console_returns):
    """Inject a fake tools.browser_tool so run_recipe's lazy import gets stubs.

    console_returns: list of JSON strings returned by successive browser_console calls.
    """
    calls = {"nav": [], "console": iter(console_returns)}
    fake = types.ModuleType("tools.browser_tool")
    fake.browser_navigate = lambda url, task_id=None: calls["nav"].append(url) or "{}"
    fake.browser_console = lambda expression=None, task_id=None: next(calls["console"])
    monkeypatch.setitem(sys.modules, "tools.browser_tool", fake)
    return calls


def test_run_replays_and_returns_data(monkeypatch):
    br.save_recipe("sweep", [
        {"kind": "navigate", "url": "https://bb.example.edu/"},
        {"kind": "eval", "expression": "courses()", "as": "courses"},
    ])
    _stub_browser(monkeypatch, ['{"success": true, "result": ["PHCY 1205", "BIOL 2020"]}'])
    out = json.loads(br.run_recipe("sweep"))
    assert out["success"] is True and out["stale"] is False
    assert out["data"]["courses"] == ["PHCY 1205", "BIOL 2020"]


def test_run_flags_stale_when_extraction_empties(monkeypatch):
    br.save_recipe("sweep", [
        {"kind": "eval", "expression": "courses()", "as": "courses", "expect_nonempty": True},
    ])
    _stub_browser(monkeypatch, ['{"success": true, "result": []}'])
    out = json.loads(br.run_recipe("sweep"))
    assert out["success"] is True and out["stale"] is True and out["at_step"] == 0


def test_run_unknown_recipe():
    out = json.loads(br.run_recipe("does-not-exist"))
    assert out["success"] is False and "No recipe" in out["error"]
