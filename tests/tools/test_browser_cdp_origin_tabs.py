"""Per-origin tab reuse for the CDP-override (persistent app-managed browser) path.

Regression coverage for the browser-session-isolation bug: browser_navigate()
previously always ran ``agent-browser open <url>`` against whichever tab the
daemon happened to have active, with no origin awareness. For a throwaway
local-headless or cloud/Browserbase session that's harmless — but a
persistent CDP browser (``browser.cdp_url`` / ``BROWSER_CDP_URL``, e.g. the
desktop app's app-managed Chromium on 127.0.0.1:9333) can carry a logged-in
SPA (webmail, an LMS) whose client-side state gets corrupted when its tab is
navigated to an unrelated origin and back — even though its auth cookies
remain valid, because the corruption is in the SPA's in-memory JS state, not
in the browser's stored session data.

These tests cover the pure decision/parsing helpers (_origin_for_tab_routing,
_label_for_origin, _plan_origin_tab) and the orchestration function
(_ensure_origin_tab) that browser_navigate() calls, gated on
_get_cdp_override(), before every "open". See tools/browser_tool.py's
_ensure_origin_tab docstring for the full mechanism writeup.
"""

from unittest.mock import patch


class TestOriginForTabRouting:
    def test_parses_scheme_and_netloc_only(self):
        from tools.browser_tool import _origin_for_tab_routing

        assert (
            _origin_for_tab_routing("https://outlook.office.com/mail/inbox/id/1")
            == "https://outlook.office.com"
        )

    def test_different_paths_same_origin_collapse_to_one_key(self):
        from tools.browser_tool import _origin_for_tab_routing

        a = _origin_for_tab_routing("https://outlook.office.com/mail/inbox")
        b = _origin_for_tab_routing("https://outlook.office.com/mail/id/AAA?x=1")
        assert a == b

    def test_different_hosts_are_different_origins(self):
        from tools.browser_tool import _origin_for_tab_routing

        outlook = _origin_for_tab_routing("https://outlook.office.com/mail")
        pubmed = _origin_for_tab_routing("https://pubmed.ncbi.nlm.nih.gov/123")
        assert outlook != pubmed

    def test_port_is_part_of_the_origin(self):
        from tools.browser_tool import _origin_for_tab_routing

        a = _origin_for_tab_routing("http://127.0.0.1:9333/foo")
        b = _origin_for_tab_routing("http://127.0.0.1:9444/foo")
        assert a == "http://127.0.0.1:9333"
        assert a != b

    def test_scheme_and_host_are_case_insensitive(self):
        from tools.browser_tool import _origin_for_tab_routing

        a = _origin_for_tab_routing("https://Outlook.Office.com/mail")
        b = _origin_for_tab_routing("HTTPS://outlook.office.com/other")
        assert a == b

    def test_non_origin_url_falls_back_without_raising(self):
        from tools.browser_tool import _origin_for_tab_routing

        # Must not raise for values with no scheme/netloc — malformed input
        # must never crash navigation, only degrade the tab-routing decision.
        assert _origin_for_tab_routing("about:blank") == "about:blank"
        assert _origin_for_tab_routing("") == ""


class TestLabelForOrigin:
    def test_deterministic_for_same_origin(self):
        from tools.browser_tool import _label_for_origin

        assert _label_for_origin("https://outlook.office.com") == _label_for_origin(
            "https://outlook.office.com"
        )

    def test_different_origins_get_different_labels(self):
        from tools.browser_tool import _label_for_origin

        a = _label_for_origin("https://outlook.office.com")
        b = _label_for_origin("https://pubmed.ncbi.nlm.nih.gov")
        assert a != b

    def test_label_is_cli_safe(self):
        """agent-browser receives this as a bare `--label <value>` CLI arg —
        it must not contain characters that could be misparsed as another
        flag or break shell/argv quoting (':', '/', spaces)."""
        from tools.browser_tool import _label_for_origin

        label = _label_for_origin("https://outlook.office.com:8443")
        assert " " not in label
        assert ":" not in label
        assert "/" not in label
        assert label.startswith("o-")


class TestPlanOriginTab:
    def test_unseen_origin_plans_new_tab(self):
        from tools.browser_tool import _plan_origin_tab

        action, label = _plan_origin_tab("https://outlook.office.com", {})
        assert action == "new"
        assert label

    def test_known_origin_plans_switch_to_its_existing_label(self):
        from tools.browser_tool import _plan_origin_tab

        known = {"https://outlook.office.com": "o-outlook-abc123"}
        action, label = _plan_origin_tab("https://outlook.office.com", known)
        assert action == "switch"
        assert label == "o-outlook-abc123"

    def test_second_distinct_origin_also_plans_new_not_switch(self):
        """Regression guard: a second, different origin must get its own new
        tab — it must never be told to 'switch' to the first origin's tab."""
        from tools.browser_tool import _plan_origin_tab

        known = {"https://outlook.office.com": "o-outlook-abc123"}
        action, label = _plan_origin_tab("https://pubmed.ncbi.nlm.nih.gov", known)
        assert action == "new"
        assert label != "o-outlook-abc123"

    def test_outlook_pubmed_outlook_cycle_switches_back_to_original_tab(self):
        """The exact bug scenario: Outlook -> PubMed -> back to Outlook must
        resolve to 'switch' back to Outlook's ORIGINAL tab label, not 'new'.
        A 'new' here would mean the fix never lets the agent get back to the
        tab it was actually logged into and mid-task on."""
        from tools.browser_tool import _plan_origin_tab

        known: dict = {}
        action1, label1 = _plan_origin_tab("https://outlook.office.com", known)
        known["https://outlook.office.com"] = label1
        assert action1 == "new"

        action2, label2 = _plan_origin_tab("https://pubmed.ncbi.nlm.nih.gov", known)
        known["https://pubmed.ncbi.nlm.nih.gov"] = label2
        assert action2 == "new"

        action3, label3 = _plan_origin_tab("https://outlook.office.com", known)
        assert action3 == "switch"
        assert label3 == label1


class TestEnsureOriginTab:
    """_ensure_origin_tab() orchestrates _plan_origin_tab() against the live
    agent-browser 'tab' CLI command via _run_browser_command(). It must be
    best-effort: any failure is swallowed so the caller's subsequent 'open'
    still runs, exactly as it did before this mechanism existed."""

    def setup_method(self):
        import tools.browser_tool as browser_tool

        browser_tool._origin_tabs.clear()

    def test_new_origin_issues_tab_new_with_label(self):
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool, "_run_browser_command", return_value={"success": True, "data": {}}
        ) as mock_run:
            browser_tool._ensure_origin_tab("task-1", "https://outlook.office.com/mail")

        first_call_args = mock_run.call_args_list[0][0]
        assert first_call_args[0] == "task-1"
        assert first_call_args[1] == "tab"
        assert first_call_args[2][0] == "new"
        assert "--label" in first_call_args[2]

    def test_new_origin_always_ends_with_an_explicit_switch_to_the_new_tab(self):
        """Regression guard: 'tab new' is NOT assumed to leave the new tab
        active (the README's own usage example issues a separate 'tab
        <label>' after 'tab new --label <label>' before acting on it). If
        _ensure_origin_tab only created the tab and never explicitly
        switched to it, the caller's subsequent 'open <url>' would land on
        whichever tab was active BEFORE this call -- i.e. the exact
        cross-origin corruption this mechanism exists to prevent, just
        moved one navigation later. Every 'new' must be followed by a
        'tab <label>' switch to that same label."""
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool, "_run_browser_command", return_value={"success": True, "data": {}}
        ) as mock_run:
            browser_tool._ensure_origin_tab("task-1b", "https://outlook.office.com/mail")

        assert mock_run.call_count == 2, (
            f"expected 'tab new' + explicit 'tab <label>' switch (2 calls), "
            f"got {mock_run.call_count}: {mock_run.call_args_list}"
        )
        create_args = mock_run.call_args_list[0][0]
        switch_args = mock_run.call_args_list[1][0]

        assert create_args[1] == "tab" and create_args[2][0] == "new"
        created_label = create_args[2][2]  # ["new", "--label", <label>]

        assert switch_args[1] == "tab"
        assert switch_args[2] == [created_label], (
            "the call immediately after 'tab new' must be an explicit "
            f"switch to that same label, got {switch_args[2]!r}"
        )

    def test_successful_tab_command_records_origin_label_mapping(self):
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool, "_run_browser_command", return_value={"success": True, "data": {}}
        ):
            browser_tool._ensure_origin_tab("task-2", "https://outlook.office.com/mail")

        origin = browser_tool._origin_for_tab_routing("https://outlook.office.com/mail")
        assert origin in browser_tool._origin_tabs.get("task-2", {})

    def test_known_origin_on_second_call_switches_instead_of_creating(self):
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool, "_run_browser_command", return_value={"success": True, "data": {}}
        ) as mock_run:
            browser_tool._ensure_origin_tab("task-3", "https://outlook.office.com/mail")
            create_args = mock_run.call_args_list[0][0]
            first_label = create_args[2][2]  # ["new", "--label", <label>]
            assert mock_run.call_count == 2  # create + switch

            browser_tool._ensure_origin_tab("task-3", "https://outlook.office.com/mail/id/2")

        # The revisit must add exactly one more call: a single switch, no
        # second "new" (that would be a duplicate-label tab).
        assert mock_run.call_count == 3
        second_call_args = mock_run.call_args_list[2][0]
        assert second_call_args[1] == "tab"
        assert second_call_args[2] == [first_label]

    def test_switch_failure_after_successful_create_still_records_mapping_and_retries_switch_not_create(self):
        """If 'tab new' succeeds but the immediate follow-up switch fails
        (daemon hiccup), the origin->label mapping must still be recorded --
        otherwise the NEXT navigation to this origin would see it as unknown
        and re-issue 'tab new --label <same label>', risking a duplicate-
        label tab. The next call must retry only the switch."""
        import tools.browser_tool as browser_tool

        def flaky_switch(session_key, command, args, timeout=None):
            if args and args[0] == "new":
                return {"success": True, "data": {}}
            return {"success": False, "error": "daemon busy"}

        with patch.object(browser_tool, "_run_browser_command", side_effect=flaky_switch):
            browser_tool._ensure_origin_tab("task-3b", "https://outlook.office.com/mail")

        origin = browser_tool._origin_for_tab_routing("https://outlook.office.com/mail")
        assert origin in browser_tool._origin_tabs.get("task-3b", {}), (
            "mapping must be recorded even when the post-create switch fails"
        )
        label = browser_tool._origin_tabs["task-3b"][origin]

        with patch.object(
            browser_tool, "_run_browser_command", return_value={"success": True, "data": {}}
        ) as mock_run:
            browser_tool._ensure_origin_tab("task-3b", "https://outlook.office.com/mail/id/2")

        mock_run.assert_called_once()
        retry_args = mock_run.call_args[0]
        assert retry_args[1] == "tab"
        assert retry_args[2] == [label], "retry must be a switch to the existing label, not a new 'tab new'"

    def test_different_task_ids_get_independent_origin_maps(self):
        """Two tasks navigating the same origin must not share tab state --
        the map is keyed per session_key, matching _active_sessions'
        per-task-id isolation."""
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool, "_run_browser_command", return_value={"success": True, "data": {}}
        ):
            browser_tool._ensure_origin_tab("task-a", "https://outlook.office.com/mail")
            browser_tool._ensure_origin_tab("task-b", "https://outlook.office.com/mail")

        assert "task-a" in browser_tool._origin_tabs
        assert "task-b" in browser_tool._origin_tabs
        assert browser_tool._origin_tabs["task-a"] is not browser_tool._origin_tabs["task-b"]

    def test_tab_command_failure_does_not_raise_and_does_not_record_mapping(self):
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool,
            "_run_browser_command",
            return_value={"success": False, "error": "daemon unreachable"},
        ):
            browser_tool._ensure_origin_tab("task-4", "https://outlook.office.com/mail")  # must not raise

        assert browser_tool._origin_tabs.get("task-4", {}) == {}

    def test_tab_command_exception_is_swallowed(self):
        """A hard exception from _run_browser_command (not just a
        {"success": False} result) must also never propagate out of
        _ensure_origin_tab -- browser_navigate calls this unconditionally
        before its own try/except-free 'open' call."""
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool, "_run_browser_command", side_effect=RuntimeError("boom")
        ):
            browser_tool._ensure_origin_tab("task-5", "https://outlook.office.com/mail")  # must not raise

    def test_empty_origin_is_a_noop(self):
        import tools.browser_tool as browser_tool

        with patch.object(browser_tool, "_run_browser_command") as mock_run:
            browser_tool._ensure_origin_tab("task-6", "")

        mock_run.assert_not_called()


class TestBrowserNavigateGatesOnCdpOverrideOnly:
    """The per-origin tab mechanism must fire ONLY on the CDP-override
    (persistent app-managed browser) path -- never for the normal
    local-headless-per-task or cloud/Browserbase sessions, which must keep
    navigating whatever tab _run_browser_command already targets, unchanged.

    Regression guard for gating on the wrong signal: cloud/Browserbase
    sessions populate session_info["cdp_url"] via provider.create_session(),
    but _get_cdp_override() (env BROWSER_CDP_URL / config browser.cdp_url)
    stays empty for them. Gating on session_info["cdp_url"] instead of
    _get_cdp_override() would incorrectly turn this on for cloud sessions
    too and change their behavior, which is out of scope for this fix.

    The first two tests below exercise the *gating pattern itself* in
    isolation (they don't call the real browser_navigate — its SSRF checks,
    session creation, recording, and auto-snapshot side effects would need
    heavy mocking disproportionate to what this is guarding). The third test
    closes that gap directly: it inspects browser_navigate's actual source
    to assert the real call site is gated on _get_cdp_override() and not on
    session_info/session-dict access, so a future edit that swaps the gate
    condition at the real call site fails this suite even though the first
    two tests would still pass.
    """

    def test_ensure_origin_tab_not_invoked_when_no_cdp_override(self):
        import tools.browser_tool as browser_tool

        with patch.object(browser_tool, "_get_cdp_override", return_value=""), \
                patch.object(browser_tool, "_ensure_origin_tab") as mock_ensure:
            if browser_tool._get_cdp_override():
                browser_tool._ensure_origin_tab("task-7", "https://example.com")

        mock_ensure.assert_not_called()

    def test_ensure_origin_tab_invoked_when_cdp_override_present(self):
        import tools.browser_tool as browser_tool

        with patch.object(
            browser_tool,
            "_get_cdp_override",
            return_value="ws://127.0.0.1:9333/devtools/browser/abc",
        ), patch.object(browser_tool, "_ensure_origin_tab") as mock_ensure:
            if browser_tool._get_cdp_override():
                browser_tool._ensure_origin_tab("task-8", "https://example.com")

        mock_ensure.assert_called_once_with("task-8", "https://example.com")

    def test_real_browser_navigate_call_site_is_gated_on_get_cdp_override(self):
        """Source-level guard on the actual wiring in browser_navigate(),
        since exercising the live function end-to-end is impractical here.
        Fails loudly if a future edit moves _ensure_origin_tab's call site
        onto a different (wrong) condition."""
        import inspect

        import tools.browser_tool as browser_tool

        source = inspect.getsource(browser_tool.browser_navigate)
        call_site_idx = source.index("_ensure_origin_tab(nav_session_key, url)")
        preceding = source[:call_site_idx]

        # The nearest 'if' before the call must test _get_cdp_override(),
        # and nothing about session_info/session dict access.
        guard_idx = preceding.rindex("if ")
        guard_line = preceding[guard_idx:].splitlines()[0]
        assert "_get_cdp_override()" in guard_line, (
            f"expected the _ensure_origin_tab call site to be guarded by "
            f"_get_cdp_override(), found guard line: {guard_line!r}"
        )
        assert "session_info" not in guard_line and "cdp_url" not in guard_line.replace(
            "_get_cdp_override()", ""
        ), (
            "guard must not also key off session_info/session cdp_url "
            f"(would wrongly include cloud/Browserbase sessions): {guard_line!r}"
        )


class TestCleanupClearsOriginTabs:
    """_cleanup_single_browser_session must forget a task's origin->label
    map alongside _active_sessions, or labels for a reaped/closed session
    would survive and _ensure_origin_tab could later hand out a stale label
    for a tab that no longer exists in a fresh daemon."""

    def test_cleanup_pops_origin_tabs_for_the_session(self):
        import tools.browser_tool as browser_tool

        browser_tool._origin_tabs["task-9"] = {"https://outlook.office.com": "o-abc"}
        browser_tool._active_sessions["task-9"] = {
            "session_name": "cdp_test9",
            "bb_session_id": None,
            "cdp_url": "ws://127.0.0.1:9333/devtools/browser/abc",
            "features": {"cdp_override": True},
        }
        browser_tool._session_last_activity["task-9"] = 0

        try:
            with patch.object(browser_tool, "_stop_cdp_supervisor"), \
                    patch.object(browser_tool, "_is_camofox_mode", return_value=False), \
                    patch.object(browser_tool, "_maybe_stop_recording"), \
                    patch.object(
                        browser_tool,
                        "_run_browser_command",
                        return_value={"success": True, "data": {}},
                    ), \
                    patch.object(browser_tool, "_get_cloud_provider", return_value=None):
                browser_tool._cleanup_single_browser_session("task-9")

            assert "task-9" not in browser_tool._origin_tabs
            assert "task-9" not in browser_tool._active_sessions
        finally:
            browser_tool._origin_tabs.pop("task-9", None)
            browser_tool._active_sessions.pop("task-9", None)
            browser_tool._session_last_activity.pop("task-9", None)
