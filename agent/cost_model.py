"""Cost model + per-workflow budget governor for Nemesis.

Two jobs, both pure and independently testable:

1. **Cost** — turn a model call's token counts into dollars, using DeepSeek's real
   rate card. Cached input is ~50x cheaper than uncached, and output is ~2x uncached
   input, so the cost of a workflow is dominated by uncontrolled output and uncached
   re-reads — which is exactly what the budgets below cap.

2. **Budget governor** — each *workflow type* (an LMS sync, an email triage, a homework
   draft) has a ``WorkflowBudget`` of hard ceilings. A ``WorkflowMeter`` accumulates a
   run's usage and reports a status against its budget:
     ok        < 70%   — proceed
     compress  >= 70%   — shrink context before continuing
     degrade   >= 90%   — drop to Flash / non-thinking, skip optional revisions
     halt      >= 100%  — stop and ask the student before spending more

This module is the backbone (definitions + accounting + policy). Enforcing the status
inside the agent loop (auto-compress / auto-degrade / auto-halt) is wired separately
against agent/conversation_loop.py; keeping the policy here makes it unit-testable and
lets skills read the same thresholds.

Rates are current as of 2026-07-15 — keep in sync with https://api-docs.deepseek.com/quick_start/pricing
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Literal

Status = Literal["ok", "compress", "degrade", "halt"]

COMPRESS_AT = 0.70
DEGRADE_AT = 0.90
HALT_AT = 1.00


# ── Rate card (USD per token; provider quotes per million) ───────────────────

@dataclass(frozen=True)
class ModelRate:
    uncached_input: float   # $/token
    cached_input: float
    output: float


def _per_m(v: float) -> float:
    return v / 1_000_000.0


# Keyed by a normalized family. resolve_rate() maps concrete model ids onto these.
MODEL_RATES: Dict[str, ModelRate] = {
    "flash": ModelRate(_per_m(0.14), _per_m(0.0028), _per_m(0.28)),
    "pro": ModelRate(_per_m(0.435), _per_m(0.003625), _per_m(0.87)),
}


def resolve_rate(model: str) -> ModelRate:
    """Map a concrete model id onto a rate family; defaults to Flash (the cheap tier)."""
    m = (model or "").lower()
    if "pro" in m or "reasoner" in m:
        return MODEL_RATES["pro"]
    return MODEL_RATES["flash"]


def is_pro(model: str) -> bool:
    m = (model or "").lower()
    return "pro" in m or "reasoner" in m


def compute_cost(model: str, uncached_input: int, cached_input: int, output: int) -> float:
    """Dollar cost of one (or a batch of) model call(s) given its token split."""
    rate = resolve_rate(model)
    return (
        max(0, uncached_input) * rate.uncached_input
        + max(0, cached_input) * rate.cached_input
        + max(0, output) * rate.output
    )


# ── Per-workflow budgets ─────────────────────────────────────────────────────

@dataclass(frozen=True)
class WorkflowBudget:
    """Hard ceilings for one workflow run. 0 means 'not applicable' (skipped in status)."""
    max_input_tokens: int = 200_000
    max_output_tokens: int = 15_000
    max_model_calls: int = 10
    max_browser_steps: int = 25
    max_browser_minutes: int = 10
    max_retries: int = 3
    max_pro_calls: int = 3


# Two-tier, on purpose:
#   WORKFLOW_TARGETS  = the steady-state numbers a well-behaved run should hit (from the
#                       economics doc). Used for REPORTING ("did this run beat target?").
#   WORKFLOW_BUDGETS  = generous ENFORCEMENT ceilings sized for the WORST LEGIT run (e.g. a
#                       first-time discovery sweep before any recipe exists), so a hard halt
#                       only ever catches a genuine runaway — never legit first-time work.
# Enforcement fails OPEN (see workflow_context): if anything is off, it declines to halt
# rather than block real work.
WORKFLOW_TARGETS: Dict[str, WorkflowBudget] = {
    "lms_sync":         WorkflowBudget(max_input_tokens=20_000,  max_output_tokens=1_000,  max_model_calls=2,  max_browser_steps=50, max_browser_minutes=8,  max_pro_calls=0),
    "email_triage":     WorkflowBudget(max_input_tokens=40_000,  max_output_tokens=3_000,  max_model_calls=2,  max_browser_steps=10, max_browser_minutes=5,  max_pro_calls=0),
    "file_ingest":      WorkflowBudget(max_input_tokens=20_000,  max_output_tokens=2_000,  max_model_calls=2,  max_browser_steps=5,  max_browser_minutes=3,  max_pro_calls=0),
    "lecture_notes":    WorkflowBudget(max_input_tokens=45_000,  max_output_tokens=8_000,  max_model_calls=8,  max_browser_steps=0,  max_browser_minutes=0,  max_pro_calls=1),
    "flashcards":       WorkflowBudget(max_input_tokens=60_000,  max_output_tokens=15_000, max_model_calls=4,  max_browser_steps=0,  max_browser_minutes=0,  max_pro_calls=1),
    "discussion_draft": WorkflowBudget(max_input_tokens=30_000,  max_output_tokens=3_000,  max_model_calls=3,  max_browser_steps=10, max_browser_minutes=5,  max_pro_calls=1),
    "homework":         WorkflowBudget(max_input_tokens=150_000, max_output_tokens=20_000, max_model_calls=10, max_browser_steps=20, max_browser_minutes=8,  max_pro_calls=3),
    "research":         WorkflowBudget(max_input_tokens=1_000_000, max_output_tokens=100_000, max_model_calls=30, max_browser_steps=40, max_browser_minutes=20, max_pro_calls=8),
}

# Enforcement ceilings ≈ worst-legit-run × margin. A run under these is never halted.
WORKFLOW_BUDGETS: Dict[str, WorkflowBudget] = {
    "lms_sync":         WorkflowBudget(max_input_tokens=400_000,   max_output_tokens=40_000,  max_model_calls=30, max_browser_steps=80, max_browser_minutes=15, max_pro_calls=2),
    "email_triage":     WorkflowBudget(max_input_tokens=200_000,   max_output_tokens=20_000,  max_model_calls=15, max_browser_steps=25, max_browser_minutes=8,  max_pro_calls=1),
    "file_ingest":      WorkflowBudget(max_input_tokens=150_000,   max_output_tokens=15_000,  max_model_calls=10, max_browser_steps=15, max_browser_minutes=5,  max_pro_calls=1),
    "lecture_notes":    WorkflowBudget(max_input_tokens=250_000,   max_output_tokens=40_000,  max_model_calls=20, max_browser_steps=0,  max_browser_minutes=0,  max_pro_calls=3),
    "flashcards":       WorkflowBudget(max_input_tokens=250_000,   max_output_tokens=60_000,  max_model_calls=15, max_browser_steps=0,  max_browser_minutes=0,  max_pro_calls=2),
    "discussion_draft": WorkflowBudget(max_input_tokens=150_000,   max_output_tokens=20_000,  max_model_calls=12, max_browser_steps=20, max_browser_minutes=6,  max_pro_calls=2),
    "homework":         WorkflowBudget(max_input_tokens=600_000,   max_output_tokens=80_000,  max_model_calls=30, max_browser_steps=40, max_browser_minutes=10, max_pro_calls=5),
    "research":         WorkflowBudget(max_input_tokens=3_000_000, max_output_tokens=300_000, max_model_calls=80, max_browser_steps=80, max_browser_minutes=25, max_pro_calls=12),
}

# Generous default enforcement ceiling for an unrecognized workflow (still catches a true
# runaway; comfortably above any normal single job).
_DEFAULT_BUDGET = WorkflowBudget(max_input_tokens=1_000_000, max_output_tokens=120_000,
                                 max_model_calls=40, max_browser_steps=80, max_browser_minutes=20, max_pro_calls=8)


def budget_for(workflow_type: str) -> WorkflowBudget:
    """The ENFORCEMENT ceiling for a workflow (generous; halts only runaways)."""
    return WORKFLOW_BUDGETS.get(workflow_type, _DEFAULT_BUDGET)


def target_for(workflow_type: str) -> WorkflowBudget:
    """The steady-state TARGET for a workflow (for reporting, not enforcement)."""
    return WORKFLOW_TARGETS.get(workflow_type, _DEFAULT_BUDGET)


# ── Live meter for one workflow run ──────────────────────────────────────────

@dataclass
class WorkflowMeter:
    """Accumulates one run's usage and grades it against a WorkflowBudget."""
    workflow_type: str = "default"
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    model_calls: int = 0
    pro_calls: int = 0
    browser_steps: int = 0
    browser_seconds: int = 0
    retries: int = 0
    _cost: float = field(default=0.0)

    def add_model_call(self, model: str, uncached_input: int, cached_input: int, output: int) -> None:
        self.model_calls += 1
        if is_pro(model):
            self.pro_calls += 1
        self.input_tokens += max(0, uncached_input) + max(0, cached_input)
        self.cached_input_tokens += max(0, cached_input)
        self.output_tokens += max(0, output)
        self._cost += compute_cost(model, uncached_input, cached_input, output)

    def add_browser_steps(self, n: int = 1) -> None:
        self.browser_steps += max(0, n)

    def add_browser_seconds(self, s: int) -> None:
        self.browser_seconds += max(0, s)

    def add_retry(self, n: int = 1) -> None:
        self.retries += max(0, n)

    def cost_usd(self) -> float:
        return round(self._cost, 6)

    def fractions(self, budget: WorkflowBudget) -> Dict[str, float]:
        """Fraction-of-ceiling for each dimension (skips ceilings set to 0)."""
        pairs = {
            "input_tokens": (self.input_tokens, budget.max_input_tokens),
            "output_tokens": (self.output_tokens, budget.max_output_tokens),
            "model_calls": (self.model_calls, budget.max_model_calls),
            "browser_steps": (self.browser_steps, budget.max_browser_steps),
            "browser_minutes": (self.browser_seconds / 60.0, budget.max_browser_minutes),
            "retries": (self.retries, budget.max_retries),
            "pro_calls": (self.pro_calls, budget.max_pro_calls),
        }
        return {k: (used / cap) for k, (used, cap) in pairs.items() if cap > 0}

    def peak_fraction(self, budget: WorkflowBudget) -> float:
        fr = self.fractions(budget)
        return max(fr.values()) if fr else 0.0

    def tripped(self, budget: WorkflowBudget, at: float = HALT_AT) -> List[str]:
        """Dimensions at or above the given fraction (default: over budget)."""
        return sorted(k for k, v in self.fractions(budget).items() if v >= at)

    def status(self, budget: WorkflowBudget) -> Status:
        peak = self.peak_fraction(budget)
        if peak >= HALT_AT:
            return "halt"
        if peak >= DEGRADE_AT:
            return "degrade"
        if peak >= COMPRESS_AT:
            return "compress"
        return "ok"


__all__ = [
    "Status", "COMPRESS_AT", "DEGRADE_AT", "HALT_AT",
    "ModelRate", "MODEL_RATES", "resolve_rate", "is_pro", "compute_cost",
    "WorkflowBudget", "WORKFLOW_BUDGETS", "WORKFLOW_TARGETS",
    "budget_for", "target_for", "WorkflowMeter",
]
