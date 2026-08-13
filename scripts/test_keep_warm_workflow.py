#!/usr/bin/env python3
"""Focused executable tests for the keep-warm GitHub Actions workflow."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "keep-warm.yml"


def extract_run_step(step_name: str) -> str:
    """Return the literal bash body for a named workflow step."""
    lines = WORKFLOW.read_text(encoding="utf-8").splitlines()
    name_index = next(
        index
        for index, line in enumerate(lines)
        if line.strip() == f"- name: {step_name}"
    )
    run_index = next(
        index
        for index in range(name_index + 1, len(lines))
        if lines[index].strip() == "run: |"
    )
    run_indent = len(lines[run_index]) - len(lines[run_index].lstrip())
    body_indent = run_indent + 2
    body = []
    for line in lines[run_index + 1 :]:
        indentation = len(line) - len(line.lstrip())
        if line and indentation < body_indent:
            break
        body.append(line[body_indent:] if line else "")
    return "\n".join(body) + "\n"


class WorkflowHarness:
    def __init__(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory(
            prefix="keep-warm-workflow-"
        )
        self.root = Path(self._temporary_directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.clock = self.root / "clock"
        self.clock.write_text("0\n", encoding="utf-8")
        self.sleep_log = self.root / "sleep.log"
        self.timeout_log = self.root / "timeout.log"
        self.curl_calls = self.root / "curl.calls"
        self.curl_log = self.root / "curl.log"
        self.gh_log = self.root / "gh.log"
        self._write_executable(
            "date",
            """#!/bin/bash
now=$(<"$FAKE_CLOCK_FILE")
if [ "${1:-}" = "+%s" ]; then
  printf '%s\\n' "$now"
else
  printf 'FAKE-T+%ssZ\\n' "$now"
fi
""",
        )
        self._write_executable(
            "sleep",
            """#!/bin/bash
printf '%s\\n' "$1" >> "$SLEEP_LOG_FILE"
now=$(<"$FAKE_CLOCK_FILE")
printf '%s\\n' "$((now + $1))" > "$FAKE_CLOCK_FILE"
""",
        )
        self._write_executable(
            "timeout",
            """#!/bin/bash
printf '%s\\n' "$2" >> "$TIMEOUT_LOG_FILE"
shift 2
"$@"
""",
        )
        self._write_executable(
            "curl",
            """#!/bin/bash
calls=0
if [ -f "$CURL_CALLS_FILE" ]; then
  calls=$(<"$CURL_CALLS_FILE")
fi
calls=$((calls + 1))
printf '%s\\n' "$calls" > "$CURL_CALLS_FILE"
printf '%s\\n' "$*" >> "$CURL_LOG_FILE"
IFS=',' read -r -a results <<< "${CURL_RESULTS:-0}"
index=$((calls - 1))
if [ "$index" -ge "${#results[@]}" ]; then
  index=$((${#results[@]} - 1))
fi
exit "${results[$index]}"
""",
        )
        self._write_executable(
            "gh",
            """#!/bin/bash
printf '%s\\n' "$*" >> "$GH_LOG_FILE"
exit "${GH_EXIT:-0}"
""",
        )

    def close(self) -> None:
        self._temporary_directory.cleanup()

    def _write_executable(self, name: str, content: str) -> None:
        path = self.bin / name
        path.write_text(content, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def _environment(self, **overrides: str) -> dict[str, str]:
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.bin}:/usr/bin:/bin",
                "FAKE_CLOCK_FILE": str(self.clock),
                "SLEEP_LOG_FILE": str(self.sleep_log),
                "TIMEOUT_LOG_FILE": str(self.timeout_log),
                "CURL_CALLS_FILE": str(self.curl_calls),
                "CURL_LOG_FILE": str(self.curl_log),
                "GH_LOG_FILE": str(self.gh_log),
                "CURL_RESULTS": "0",
                "GH_EXIT": "0",
            }
        )
        environment.update(overrides)
        return environment

    def run_ping_loop(
        self, loop_seconds: str, curl_results: str = "0"
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/bash", "-c", extract_run_step(
                "Ping backend /health every 4 minutes for ~5h50m"
            )],
            cwd=ROOT,
            env=self._environment(
                LOOP_SECONDS=loop_seconds, CURL_RESULTS=curl_results
            ),
            text=True,
            capture_output=True,
            check=False,
        )

    def run_handoff(self) -> subprocess.CompletedProcess[str]:
        script = extract_run_step(
            "Re-trigger this workflow to continue the chain"
        ).replace(
            "${{ github.repository }}", "owner/ehparkleh"
        ).replace(
            "${{ github.ref_name }}", "fm/ehparkleh-keepwarm-r1"
        )
        return subprocess.run(
            ["/bin/bash", "-c", script],
            cwd=ROOT,
            env=self._environment(GH_TOKEN="test-token"),
            text=True,
            capture_output=True,
            check=False,
        )

    def numbers(self, path: Path) -> list[int]:
        if not path.exists():
            return []
        return [int(line) for line in path.read_text(encoding="utf-8").splitlines()]


class KeepWarmWorkflowTests(unittest.TestCase):
    evidence: dict[str, object] = {}

    @classmethod
    def tearDownClass(cls) -> None:
        destination = os.environ.get("KEEP_WARM_EVIDENCE_JSON")
        if destination:
            Path(destination).write_text(
                json.dumps(cls.evidence, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )

    def setUp(self) -> None:
        self.harness = WorkflowHarness()

    def tearDown(self) -> None:
        self.harness.close()

    def test_production_loop_cadence_and_deadline_budgets(self) -> None:
        result = self.harness.run_ping_loop(loop_seconds="")
        sleeps = self.harness.numbers(self.harness.sleep_log)
        budgets = self.harness.numbers(self.harness.timeout_log)
        curl_arguments = self.harness.curl_log.read_text(encoding="utf-8")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            "Ping summary: 88 succeeded, 0 failed, 88 attempted", result.stdout
        )
        self.assertEqual(sleeps[:-1], [240] * 87)
        self.assertEqual(sleeps[-1], 120)
        self.assertEqual(sum(sleeps), 21_000)
        self.assertEqual(budgets[0], 20_900)
        self.assertEqual(budgets[-1], 20)
        self.assertIn("--connect-timeout 10", curl_arguments)
        self.assertIn("--max-time 30", curl_arguments)
        self.assertIn("--retry 2", curl_arguments)
        self.assertIn(
            "https://ehparkleh-backend.onrender.com/health", curl_arguments
        )
        self.__class__.evidence["production_loop"] = {
            "duration_seconds": sum(sleeps),
            "ping_attempts": len(budgets),
            "regular_sleep_seconds": sorted(set(sleeps[:-1])),
            "final_sleep_seconds": sleeps[-1],
            "first_request_budget_seconds": budgets[0],
            "last_request_budget_seconds": budgets[-1],
            "result": result.stdout.strip().splitlines()[-1],
        }
        print(
            "PRODUCTION LOOP: 88 pings over 21000 simulated seconds; "
            "87 cadence sleeps were exactly 240s; final sleep was bounded "
            "to 120s; last curl budget was bounded to 20s."
        )

    def test_short_dispatch_override_finishes_at_its_deadline(self) -> None:
        result = self.harness.run_ping_loop(loop_seconds="20")
        sleeps = self.harness.numbers(self.harness.sleep_log)
        budgets = self.harness.numbers(self.harness.timeout_log)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sleeps, [20])
        self.assertEqual(budgets, [20])
        self.assertIn(
            "Ping summary: 1 succeeded, 0 failed, 1 attempted", result.stdout
        )
        self.__class__.evidence["short_dispatch_override"] = {
            "requested_seconds": 20,
            "actual_simulated_seconds": sum(sleeps),
            "request_budget_seconds": budgets[0],
            "result": result.stdout.strip().splitlines()[-1],
        }
        print(
            "SHORT OVERRIDE: loop_seconds=20 made one successful ping and "
            "finished at 20s without an unbounded 240s sleep."
        )

    def test_input_validation_rejects_unsafe_values_before_ping(self) -> None:
        rejected: dict[str, str] = {}
        for value in ("0", "-1", "abc", "21001"):
            with self.subTest(loop_seconds=value):
                result = self.harness.run_ping_loop(loop_seconds=value)
                self.assertEqual(result.returncode, 1)
                self.assertIn(
                    "loop_seconds must be a positive integer no greater than 21000",
                    result.stderr,
                )
                self.assertFalse(self.harness.curl_calls.exists())
                rejected[value] = result.stderr.strip()
        self.__class__.evidence["rejected_inputs"] = rejected
        print("INPUT VALIDATION: rejected 0, -1, abc, and 21001 before curl.")

    def test_transient_ping_failure_does_not_break_loop(self) -> None:
        result = self.harness.run_ping_loop(
            loop_seconds="481", curl_results="1,0"
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ping FAILED (continuing loop)", result.stdout)
        self.assertIn(
            "Ping summary: 1 succeeded, 1 failed, 2 attempted", result.stdout
        )
        self.__class__.evidence["transient_failure"] = {
            "curl_results": ["failure", "success"],
            "workflow_result": "success",
            "summary": result.stdout.strip().splitlines()[-1],
        }
        print(
            "TRANSIENT FAILURE: first curl failed, second succeeded, and the "
            "loop completed successfully with both attempts reported."
        )

    def test_all_ping_failures_fail_the_ping_step(self) -> None:
        result = self.harness.run_ping_loop(
            loop_seconds="481", curl_results="1"
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "Ping summary: 0 succeeded, 2 failed, 2 attempted", result.stdout
        )
        self.assertIn("No keep-warm ping succeeded", result.stderr)
        self.__class__.evidence["persistent_failure"] = {
            "curl_results": ["failure", "failure"],
            "ping_step_result": "failure",
            "summary": result.stdout.strip().splitlines()[-1],
        }
        print(
            "PERSISTENT FAILURE: two failed curls produced a failed ping step "
            "and a visible zero-success summary."
        )

    def test_handoff_dispatches_same_workflow_branch(self) -> None:
        result = self.harness.run_handoff()
        invocation = self.harness.gh_log.read_text(encoding="utf-8").strip()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            invocation,
            "workflow run keep-warm.yml --repo owner/ehparkleh "
            "--ref fm/ehparkleh-keepwarm-r1",
        )
        self.__class__.evidence["handoff"] = {
            "command": f"gh {invocation}",
            "result": "success",
        }
        print(f"HANDOFF: gh {invocation}")

    def test_workflow_and_documentation_contract(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        cadence_guide = (ROOT / "docs" / "keep-warm-cadence.md").read_text(
            encoding="utf-8"
        )
        readiness = (ROOT / "docs" / "production-readiness.md").read_text(
            encoding="utf-8"
        )

        for required in (
            "cron: '*/5 * * * *'",
            "workflow_dispatch:",
            "loop_seconds:",
            "actions: write",
            "group: keep-warm",
            "cancel-in-progress: false",
            "timeout-minutes: 355",
            "max_duration=21000",
            "sleep_for=240",
            "if: always()",
        ):
            self.assertIn(required, workflow)
        self.assertIn("keep-warm-cadence.md", readiness)
        self.assertIn("self-relaunching Actions job", readiness)
        self.assertIn("a maintainer must re-enable it first", workflow)
        self.assertIn("must re-enable the workflow first", cadence_guide)
        self.assertNotIn("workflow gets disabled after 60 days", workflow)
        self.assertNotIn(
            "workflow gets disabled after 60 days of inactivity, etc.",
            cadence_guide,
        )
        self.assertNotIn(
            "no paid plan, external scheduler, or additional keepalive was selected here",
            readiness,
        )
        self.assertFalse((ROOT / "AGENTS.md").exists())
        self.assertFalse((ROOT / "CLAUDE.md").exists())
        self.__class__.evidence["contract"] = {
            "cron_role": "backstop",
            "workflow_dispatch_input": "loop_seconds",
            "permissions": "actions: write",
            "concurrency_group": "keep-warm",
            "job_timeout_minutes": 355,
            "agent_tool_files_present": False,
            "production_readiness_links_current_mechanism": True,
            "disabled_workflow_requires_manual_reenable": True,
        }
        print(
            "WORKFLOW CONTRACT: dispatch input, actions:write, keep-warm "
            "concurrency, 355m timeout, always-on handoff, backstop cron, "
            "updated readiness docs, and no agent-tool files are present."
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
