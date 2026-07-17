"""Failed tool results keep their error tail through compaction pruning.

The pre-compression pruning pass replaces old tool outputs with 1-line
synopses. Before this fix a failing `npm test` (or any tool error) was
flattened to "exit 1" BEFORE the LLM summarizer ever ran, so the exact
error text could never reach the summary's "## Blocked" section. Failed
results now keep the last lines of real output next to the synopsis, and a
synopsis from an earlier pass is never re-summarized (which would strip the
kept tail).

Also covers the aux fast-tier mapping: auxiliary tasks (compression, titles)
must never run on thinking/premium DeepSeek tiers.
"""

import json

import pytest
from unittest.mock import patch

from agent.auxiliary_client import _aux_fast_deepseek_model
from agent.context_compressor import (
    ContextCompressor,
    _ERROR_TAIL_MAX_CHARS,
    _PRUNED_SYNOPSIS_RE,
    _error_tail,
    _summarize_tool_result,
)


def _terminal_result(exit_code: int, output: str, error: str = "") -> str:
    return json.dumps({
        "output": output,
        "exit_code": exit_code,
        "error": error,
        "status": "error" if exit_code else "ok",
    })


def _messages_with_terminal(content: str) -> list:
    """A pruneable conversation: one old terminal call + enough tail."""
    return [
        {"role": "system", "content": "sys"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "terminal", "arguments": '{"command": "npm test"}'},
            }],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": content},
        # Tail messages the prune boundary protects.
        {"role": "user", "content": "next question"},
        {"role": "assistant", "content": "answer"},
    ]


@pytest.fixture()
def compressor():
    with patch("agent.context_compressor.get_model_context_length", return_value=100000):
        return ContextCompressor(
            model="test/model",
            threshold_percent=0.85,
            protect_first_n=0,
            protect_last_n=2,
            quiet_mode=True,
        )


class TestSummarizeFailedToolResult:
    def test_failed_terminal_keeps_error_tail(self):
        output = "\n".join(f"line {i}" for i in range(40)) + "\nFAIL src/auth.test.ts"
        summary = _summarize_tool_result(
            "terminal", '{"command": "npm test"}',
            _terminal_result(1, output, error="2 tests failed"),
        )
        assert summary.startswith("[terminal] ran `npm test` -> exit 1")
        assert "[kept error output]" in summary
        assert "FAIL src/auth.test.ts" in summary
        assert "2 tests failed" in summary
        # Early lines were dropped — only the tail is kept.
        assert "line 0" not in summary

    def test_successful_terminal_stays_one_line(self):
        summary = _summarize_tool_result(
            "terminal", '{"command": "npm test"}',
            _terminal_result(0, "\n".join(f"line {i}" for i in range(40))),
        )
        assert summary.startswith("[terminal] ran `npm test` -> exit 0")
        assert "[kept error output]" not in summary
        assert "\n" not in summary

    def test_generic_tool_error_keeps_tail(self):
        content = "Error: ENOENT no such file or directory, open 'notes.md'" + " pad" * 60
        summary = _summarize_tool_result("read_file", '{"path": "notes.md"}', content)
        assert "[kept error output]" in summary
        assert "ENOENT" in summary

    def test_tail_is_char_bounded(self):
        one_huge_line = "x" * 5000 + " the actual error"
        tail = _error_tail(_terminal_result(1, one_huge_line))
        assert len(tail) <= _ERROR_TAIL_MAX_CHARS + 1  # +1 for the ellipsis
        # Left-truncation keeps the END, where the error lives.
        assert tail.endswith("the actual error")


class TestPruneDurability:
    def test_second_prune_pass_keeps_error_tail(self, compressor):
        output = "\n".join(f"line {i}" for i in range(40)) + "\nTypeError: null is not a function"
        messages = _messages_with_terminal(_terminal_result(1, output))

        once, pruned_once = compressor._prune_old_tool_results(messages, protect_tail_count=2)
        assert pruned_once >= 1
        synopsis = once[2]["content"]
        assert _PRUNED_SYNOPSIS_RE.match(synopsis)
        assert "TypeError: null is not a function" in synopsis

        # A later compaction pruning the same region must not degrade it.
        twice, _ = compressor._prune_old_tool_results(once, protect_tail_count=2)
        assert twice[2]["content"] == synopsis

    def test_success_synopsis_not_resummarized(self, compressor):
        messages = _messages_with_terminal(_terminal_result(0, "ok " * 200))
        once, _ = compressor._prune_old_tool_results(messages, protect_tail_count=2)
        synopsis = once[2]["content"]
        twice, _ = compressor._prune_old_tool_results(once, protect_tail_count=2)
        assert twice[2]["content"] == synopsis


class TestAuxFastTier:
    @pytest.mark.parametrize("model,expected", [
        ("deepseek-reasoner", "deepseek-chat"),
        ("deepseek-v4-pro", "deepseek-chat"),
        ("deepseek/deepseek-v4-pro", "deepseek-chat"),
        ("deepseek-v4-flash", "deepseek-v4-flash"),
        ("deepseek-chat", "deepseek-chat"),
        ("anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6"),
        # v4-pro in a non-DeepSeek name must pass through untouched.
        ("acme/other-v4-pro", "acme/other-v4-pro"),
        ("", ""),
    ])
    def test_mapping(self, model, expected):
        assert _aux_fast_deepseek_model(model) == expected
