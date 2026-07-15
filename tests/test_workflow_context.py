"""Tests for the active-workflow registry (agent/workflow_context.py)."""

import pytest

from agent import workflow_context as wf
from agent import cost_model as cm


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMESIS_USAGE_DB", str(tmp_path / "usage.db"))
    # Clear any registry state between tests.
    wf._active.clear()
    yield
    wf._active.clear()


def test_no_active_workflow_is_ok_and_feed_is_noop():
    assert wf.status("t1") == "ok"
    wf.feed("t1", "flash", 10_000, 0, 5_000)  # no active workflow → ignored
    assert wf.active("t1") is None


def test_begin_feed_status_ok_under_ceiling():
    wf.begin("t1", "lms_sync")
    wf.feed("t1", "flash", 1_000, 0, 100)
    assert wf.status("t1") == "ok"
    m, _ = wf.active("t1")
    assert m.model_calls == 1 and m.workflow_type == "lms_sync"


def test_runaway_trips_halt():
    wf.begin("t1", "lms_sync")  # enforcement ceiling: 30 model calls
    for _ in range(31):
        wf.feed("t1", "flash", 100, 0, 10)
    assert wf.status("t1") == "halt"


def test_legit_first_sweep_does_not_halt():
    # A realistic first-time discovery (well under the generous ceiling) stays ok.
    wf.begin("t1", "lms_sync")
    for _ in range(12):  # 12 model calls, some real tokens
        wf.feed("t1", "flash", 8_000, 2_000, 800)
    assert wf.status("t1") in ("ok", "compress")  # never halt


def test_end_records_to_ledger_and_clears():
    from agent import usage_ledger as ul
    wf.begin("t1", "flashcards")
    wf.feed("t1", "flash", 40_000, 10_000, 12_000)
    wf.feed("t1", "deepseek-v4-pro", 5_000, 0, 1_000)
    row = wf.end("t1", user_id="local", status="ok")
    assert row is not None and row["workflow_type"] == "flashcards"
    # Cost is the meter's own sum across Flash + Pro (not a single-model recompute).
    expected = cm.compute_cost("flash", 40_000, 10_000, 12_000) + cm.compute_cost("pro", 5_000, 0, 1_000)
    assert row["cost_usd"] == pytest.approx(expected)
    assert wf.active("t1") is None  # cleared
    assert ul.summary()["by_workflow"]["flashcards"]["events"] == 1


def test_tasks_are_isolated():
    wf.begin("a", "lms_sync")
    wf.begin("b", "homework")
    wf.feed("a", "flash", 100, 0, 10)
    assert wf.active("a")[0].workflow_type == "lms_sync"
    assert wf.active("b")[0].workflow_type == "homework"
    assert wf.active("b")[0].model_calls == 0
