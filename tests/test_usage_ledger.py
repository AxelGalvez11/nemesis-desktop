"""Tests for the local per-workflow cost ledger (agent/usage_ledger.py)."""

import pytest

from agent import usage_ledger as ul
from agent import cost_model as cm


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMESIS_USAGE_DB", str(tmp_path / "usage.db"))
    yield


def test_record_computes_cost_and_roundtrips():
    row = ul.record_event(
        user_id="u1", workflow_type="flashcards", model="deepseek-v4-flash",
        input_tokens=40_000, cache_hit_tokens=10_000, output_tokens=12_000,
        model_calls=3, status="ok",
    )
    assert row["cost_usd"] == pytest.approx(
        cm.compute_cost("deepseek-v4-flash", 40_000, 10_000, 12_000)
    )
    s = ul.summary()
    assert s["events"] == 1 and s["by_workflow"]["flashcards"]["events"] == 1


def test_summary_aggregates_across_users_and_workflows():
    ul.record_event(user_id="u1", workflow_type="lms_sync", model="flash",
                    input_tokens=0, cache_hit_tokens=0, output_tokens=0, model_calls=0, status="ok")
    ul.record_event(user_id="u1", workflow_type="homework", model="deepseek-v4-pro",
                    input_tokens=100_000, cache_hit_tokens=50_000, output_tokens=20_000, model_calls=6)
    ul.record_event(user_id="u2", workflow_type="email_triage", model="flash",
                    input_tokens=20_000, cache_hit_tokens=0, output_tokens=2_000, model_calls=1)

    s = ul.summary()
    assert s["events"] == 3
    assert set(s["by_workflow"]) == {"lms_sync", "homework", "email_triage"}
    # 1 of 3 workflows ran with zero model calls (the free LMS replay).
    assert s["pct_workflows_without_llm"] == pytest.approx(1 / 3)
    # cache_hit_rate = 50k cached / (120k uncached + 50k cached)
    assert s["cache_hit_rate"] == pytest.approx(50_000 / 170_000, abs=1e-4)
    assert s["cost_per_student"] == pytest.approx(s["total_cost_usd"] / 2)


def test_summary_scoped_to_one_user():
    ul.record_event(user_id="u1", workflow_type="homework", model="flash",
                    input_tokens=10_000, cache_hit_tokens=0, output_tokens=1_000, model_calls=1)
    ul.record_event(user_id="u2", workflow_type="homework", model="flash",
                    input_tokens=99_000, cache_hit_tokens=0, output_tokens=9_000, model_calls=1)
    s1 = ul.summary(user_id="u1")
    assert s1["events"] == 1 and s1["total_cost_usd"] == pytest.approx(
        cm.compute_cost("flash", 10_000, 0, 1_000)
    )
