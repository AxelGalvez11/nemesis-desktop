"""Local per-workflow cost ledger — 'track actual cost, not estimated cost'.

Records one row per completed workflow with its real token split, browser usage, and
computed dollar cost, so the app can show cost per student / per outcome / per lecture-
hour and gross margin by tier — the metrics that turn 'margins look fine' into numbers.

This is a LOCAL SQLite ledger in the agent's data dir (separate from the server-side
billing meter, which stays the source of truth for daily allowances). Override the path
with ``NEMESIS_USAGE_DB`` (used by tests). Cost is computed from agent.cost_model so the
rate card lives in exactly one place.
"""

from __future__ import annotations

import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from agent.cost_model import compute_cost

_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  course_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_hit_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER NOT NULL,
  model_calls INTEGER DEFAULT 1,
  browser_steps INTEGER DEFAULT 0,
  browser_seconds INTEGER DEFAULT 0,
  files_processed INTEGER DEFAULT 0,
  cache_key TEXT,
  status TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_workflow ON usage_events(workflow_type);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);
"""


def _db_path() -> Path:
    override = os.environ.get("NEMESIS_USAGE_DB")
    path = Path(override) if override else Path(
        os.path.expanduser("~/Documents/Nemesis Library/.nemesis/usage_ledger.db")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn


def record_event(
    *,
    user_id: str,
    workflow_type: str,
    model: str,
    input_tokens: int,          # uncached (billed) input
    output_tokens: int,
    cache_hit_tokens: int = 0,  # cached input (cheap)
    model_calls: int = 1,
    browser_steps: int = 0,
    browser_seconds: int = 0,
    files_processed: int = 0,
    course_id: Optional[str] = None,
    cache_key: Optional[str] = None,
    status: str = "ok",
    event_id: Optional[str] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Record one workflow event; cost is computed from the token split. Returns the row."""
    cost = compute_cost(model, input_tokens, cache_hit_tokens, output_tokens)
    row = {
        "id": event_id or uuid.uuid4().hex,
        "user_id": user_id,
        "workflow_type": workflow_type,
        "course_id": course_id,
        "model": model,
        "input_tokens": int(input_tokens),
        "cache_hit_tokens": int(cache_hit_tokens),
        "output_tokens": int(output_tokens),
        "model_calls": int(model_calls),
        "browser_steps": int(browser_steps),
        "browser_seconds": int(browser_seconds),
        "files_processed": int(files_processed),
        "cache_key": cache_key,
        "status": status,
        "cost_usd": round(cost, 6),
        "created_at": created_at or datetime.now(timezone.utc).isoformat(),
    }
    conn = _connect()
    try:
        conn.execute(
            """INSERT OR REPLACE INTO usage_events
               (id,user_id,workflow_type,course_id,model,input_tokens,cache_hit_tokens,
                output_tokens,model_calls,browser_steps,browser_seconds,files_processed,
                cache_key,status,cost_usd,created_at)
               VALUES (:id,:user_id,:workflow_type,:course_id,:model,:input_tokens,
                :cache_hit_tokens,:output_tokens,:model_calls,:browser_steps,:browser_seconds,
                :files_processed,:cache_key,:status,:cost_usd,:created_at)""",
            row,
        )
        conn.commit()
    finally:
        conn.close()
    return row


def summary(*, user_id: Optional[str] = None) -> Dict[str, Any]:
    """Dashboard metrics — the ones that answer 'cost per outcome, margin by tier'."""
    where = "WHERE user_id = ?" if user_id else ""
    args = (user_id,) if user_id else ()
    conn = _connect()
    try:
        totals = conn.execute(
            f"""SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) cost,
                       COALESCE(SUM(input_tokens),0) inp, COALESCE(SUM(cache_hit_tokens),0) cache,
                       COALESCE(SUM(output_tokens),0) out,
                       COALESCE(SUM(CASE WHEN model_calls=0 THEN 1 ELSE 0 END),0) no_llm,
                       COUNT(DISTINCT user_id) users
                FROM usage_events {where}""",
            args,
        ).fetchone()
        by_workflow = {
            r["workflow_type"]: {"events": r["n"], "cost_usd": round(r["cost"], 6)}
            for r in conn.execute(
                f"SELECT workflow_type, COUNT(*) n, SUM(cost_usd) cost FROM usage_events {where} GROUP BY workflow_type",
                args,
            ).fetchall()
        }
    finally:
        conn.close()

    n = totals["n"] or 0
    inp, cache = totals["inp"] or 0, totals["cache"] or 0
    users = totals["users"] or 0
    return {
        "events": n,
        "total_cost_usd": round(totals["cost"] or 0.0, 6),
        "cost_per_student": round((totals["cost"] or 0.0) / users, 6) if users else 0.0,
        "cache_hit_rate": round(cache / (inp + cache), 4) if (inp + cache) else 0.0,
        "pct_workflows_without_llm": round((totals["no_llm"] or 0) / n, 4) if n else 0.0,
        "by_workflow": by_workflow,
    }


__all__ = ["record_event", "summary"]
