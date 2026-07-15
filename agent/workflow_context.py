"""Active-workflow registry — the wiring between a labeled workflow and the loop.

A workflow is labeled per ``task_id`` (tools carry task_id; the agent loop has
``effective_task_id``). ``begin`` opens a meter+budget for a task; the loop ``feed``s each
model call's real token usage and reads ``status``; ``end`` writes the run to the local
cost ledger and clears it.

**Fails OPEN by design.** Enforcement is a safety backstop, never a gate on legit work: if
anything here errors, callers treat it as "no active workflow / ok" and proceed. The budgets
in cost_model are generous enforcement ceilings (worst-legit-run sized), so a ``halt`` only
ever means a genuine runaway.
"""

from __future__ import annotations

import threading
from typing import Dict, Optional, Tuple

from agent.cost_model import WorkflowMeter, WorkflowBudget, budget_for, Status

_lock = threading.Lock()
_active: Dict[str, Tuple[WorkflowMeter, WorkflowBudget]] = {}


def _key(task_id: Optional[str]) -> str:
    return task_id or "default"


def begin(task_id: Optional[str], workflow_type: str) -> None:
    """Start tracking a labeled workflow for this task (replaces any prior one)."""
    try:
        with _lock:
            _active[_key(task_id)] = (WorkflowMeter(workflow_type=workflow_type), budget_for(workflow_type))
    except Exception:
        pass


def active(task_id: Optional[str]) -> Optional[Tuple[WorkflowMeter, WorkflowBudget]]:
    try:
        with _lock:
            return _active.get(_key(task_id))
    except Exception:
        return None


def feed(task_id: Optional[str], model: str, uncached_input: int, cached_input: int, output: int) -> None:
    """Record one model call against the task's active workflow (no-op if none)."""
    try:
        entry = active(task_id)
        if entry is not None:
            entry[0].add_model_call(model, uncached_input, cached_input, output)
    except Exception:
        pass


def add_browser_steps(task_id: Optional[str], n: int = 1) -> None:
    try:
        entry = active(task_id)
        if entry is not None:
            entry[0].add_browser_steps(n)
    except Exception:
        pass


def status(task_id: Optional[str]) -> Status:
    """Grade the task's active workflow against its ceiling. 'ok' if none/errored (fail open)."""
    try:
        entry = active(task_id)
        if entry is None:
            return "ok"
        return entry[0].status(entry[1])
    except Exception:
        return "ok"


def end(task_id: Optional[str], *, user_id: str = "local", status: str = "ok",
        course_id: Optional[str] = None) -> Optional[dict]:
    """Finish the task's workflow: write it to the local cost ledger and clear it."""
    try:
        with _lock:
            entry = _active.pop(_key(task_id), None)
        if entry is None:
            return None
        meter = entry[0]
        # Imported lazily so importing this module never drags in sqlite at load time.
        from agent import usage_ledger
        return usage_ledger.record_event(
            user_id=user_id,
            workflow_type=meter.workflow_type,
            model="mixed",
            input_tokens=meter.input_tokens - meter.cached_input_tokens,
            cache_hit_tokens=meter.cached_input_tokens,
            output_tokens=meter.output_tokens,
            model_calls=meter.model_calls,
            browser_steps=meter.browser_steps,
            browser_seconds=meter.browser_seconds,
            course_id=course_id,
            status=status,
            cost_usd=meter.cost_usd(),
        )
    except Exception:
        return None


__all__ = ["begin", "active", "feed", "add_browser_steps", "status", "end"]
