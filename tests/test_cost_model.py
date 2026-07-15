"""Tests for the cost model + per-workflow budget governor (agent/cost_model.py)."""

import pytest

from agent import cost_model as cm


# ── cost ─────────────────────────────────────────────────────────────────────

def test_flash_cost_matches_rate_card():
    # 1M uncached input @ $0.14, 1M cached @ $0.0028, 1M output @ $0.28
    assert cm.compute_cost("deepseek-v4-flash", 1_000_000, 0, 0) == pytest.approx(0.14)
    assert cm.compute_cost("deepseek-v4-flash", 0, 1_000_000, 0) == pytest.approx(0.0028)
    assert cm.compute_cost("deepseek-v4-flash", 0, 0, 1_000_000) == pytest.approx(0.28)


def test_pro_costs_more_and_is_detected():
    assert cm.is_pro("deepseek-v4-pro") is True
    assert cm.is_pro("deepseek-reasoner") is True
    assert cm.is_pro("deepseek-v4-flash") is False
    assert cm.compute_cost("deepseek-v4-pro", 1_000_000, 0, 0) == pytest.approx(0.435)


def test_cached_is_far_cheaper_than_uncached():
    uncached = cm.compute_cost("flash", 100_000, 0, 0)
    cached = cm.compute_cost("flash", 0, 100_000, 0)
    assert cached < uncached / 40  # ~50x cheaper


# ── budgets + meter ──────────────────────────────────────────────────────────

def test_budget_for_falls_back_to_default():
    assert cm.budget_for("lms_sync").max_browser_steps == 50
    assert cm.budget_for("nonsense") is cm._DEFAULT_BUDGET


def test_meter_status_thresholds():
    b = cm.WorkflowBudget(max_output_tokens=1000, max_model_calls=0, max_browser_steps=0,
                          max_input_tokens=0, max_browser_minutes=0, max_retries=0, max_pro_calls=0)
    m = cm.WorkflowMeter(workflow_type="t")
    m.add_model_call("flash", 0, 0, 500)   # 50% of output ceiling
    assert m.status(b) == "ok"
    m.add_model_call("flash", 0, 0, 250)   # 75%
    assert m.status(b) == "compress"
    m.add_model_call("flash", 0, 0, 160)   # 91%
    assert m.status(b) == "degrade"
    m.add_model_call("flash", 0, 0, 100)   # 101%
    assert m.status(b) == "halt"


def test_meter_peak_picks_worst_dimension():
    b = cm.WorkflowBudget(max_model_calls=10, max_browser_steps=10, max_output_tokens=100_000,
                          max_input_tokens=1_000_000, max_browser_minutes=100, max_retries=100, max_pro_calls=100)
    m = cm.WorkflowMeter()
    m.add_model_call("flash", 0, 0, 10)   # model_calls 1/10 = 0.1
    m.add_browser_steps(10)               # browser_steps 10/10 = 1.0
    assert m.peak_fraction(b) == pytest.approx(1.0)
    assert m.status(b) == "halt"
    assert "browser_steps" in m.tripped(b)


def test_zero_ceilings_are_skipped():
    b = cm.WorkflowBudget(max_model_calls=0, max_browser_steps=0, max_output_tokens=0,
                          max_input_tokens=0, max_browser_minutes=0, max_retries=0, max_pro_calls=0)
    m = cm.WorkflowMeter()
    m.add_model_call("flash", 5000, 0, 5000)
    assert m.fractions(b) == {}
    assert m.status(b) == "ok"


def test_meter_tracks_pro_calls_and_cost():
    b = cm.budget_for("homework")
    m = cm.WorkflowMeter(workflow_type="homework")
    m.add_model_call("flash", 10_000, 0, 2_000)
    m.add_model_call("deepseek-v4-pro", 5_000, 0, 1_000)
    assert m.pro_calls == 1 and m.model_calls == 2
    assert m.cost_usd() == pytest.approx(
        cm.compute_cost("flash", 10_000, 0, 2_000) + cm.compute_cost("pro", 5_000, 0, 1_000)
    )
