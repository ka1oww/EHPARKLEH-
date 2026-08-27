#!/usr/bin/env python3
"""Executable tests for the backend deploy workflow and its verifier.

The workflow cannot be exercised end to end from here: it needs a repository
secret this repo does not hold and a Render service nothing here may touch. So
each shell step's literal body is extracted from the YAML and run against a fake
`curl`, and scripts/verify_live_deploy.py is driven directly with a fake
fetcher. That is what proves the branching - secret missing, hook rejected,
wrong commit live, unknown commit, stale dataset - behaves as intended before
the first real merge.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-backend.yml"
FAKE_HOOK = "https://api.render.com/deploy/srv-fake?key=super-secret-value"
COMMIT = "a" * 40
OTHER_COMMIT = "b" * 40

sys.path.insert(0, str(ROOT / "scripts"))
import verify_live_deploy as verifier  # noqa: E402


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
        if line.strip() and indentation < body_indent:
            break
        body.append(line[body_indent:] if line.strip() else "")
    return "\n".join(body) + "\n"


class ShellHarness:
    """A PATH holding a scripted fake curl, plus a captured $GITHUB_ENV."""

    def __init__(self) -> None:
        self._temporary_directory = tempfile.TemporaryDirectory(
            prefix="deploy-backend-workflow-"
        )
        self.root = Path(self._temporary_directory.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.curl_log = self.root / "curl.log"
        self.github_env = self.root / "github_env"
        self.github_env.write_text("", encoding="utf-8")
        # Prints CURL_BODY, logs its arguments, and always writes something to
        # stderr so a test can prove the step is not relaying curl's stderr.
        self._write_executable(
            "curl",
            """#!/bin/bash
printf '%s\\n' "$*" >> "$CURL_LOG_FILE"
printf '%s' "${CURL_BODY:-}"
echo "curl: (22) error for url $*" >&2
exit "${CURL_EXIT:-0}"
""",
        )

    def close(self) -> None:
        self._temporary_directory.cleanup()

    def _write_executable(self, name: str, content: str) -> None:
        path = self.bin / name
        path.write_text(content, encoding="utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def run(self, script: str, **overrides: str) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        environment.update(
            {
                "PATH": f"{self.bin}:/usr/bin:/bin:/usr/local/bin",
                "GITHUB_ENV": str(self.github_env),
                "CURL_LOG_FILE": str(self.curl_log),
                "CURL_BODY": "",
                "CURL_EXIT": "0",
            }
        )
        environment.update(overrides)
        return subprocess.run(
            ["/bin/bash", "-c", script],
            cwd=ROOT,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )


class DeployWorkflowStaticTests(unittest.TestCase):
    """Checks about the workflow file itself, not its bash bodies."""

    def setUp(self) -> None:
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_triggers_on_main_push_and_manual_dispatch(self) -> None:
        trigger_block = self.text.split("concurrency:", 1)[0]
        self.assertIn("push:", trigger_block)
        self.assertIn("branches: [main]", trigger_block)
        self.assertIn("workflow_dispatch:", trigger_block)

    def test_deploys_are_serialised_and_never_cancelled(self) -> None:
        self.assertIn("group: deploy-backend", self.text)
        self.assertIn("cancel-in-progress: false", self.text)

    def test_hook_is_only_ever_read_from_the_secret(self) -> None:
        # No literal Render deploy-hook URL anywhere, and every binding of the
        # hook comes from the secret rather than an inlined value.
        self.assertNotIn("api.render.com/deploy", self.text)
        bindings = re.findall(r"^\s*RENDER_DEPLOY_HOOK:\s*(.+)$", self.text, re.M)
        self.assertTrue(bindings, "the workflow never reads the secret")
        for value in bindings:
            self.assertEqual(value.strip(), "${{ secrets.RENDER_DEPLOY_HOOK }}")

    def test_hook_value_is_never_written_to_the_log(self) -> None:
        for line in self.text.splitlines():
            stripped = line.strip()
            if not stripped.startswith(("echo", "printf")):
                continue
            self.assertNotIn("RENDER_DEPLOY_HOOK}", stripped, f"hook echoed: {stripped}")
            self.assertNotIn(
                "$RENDER_DEPLOY_HOOK", stripped, f"hook echoed: {stripped}"
            )

    def test_verification_settings_the_steps_depend_on_are_defined(self) -> None:
        for key in ("BACKEND_URL:", "VERIFY_TIMEOUT_SECONDS:", "VERIFY_POLL_SECONDS:"):
            self.assertIn(key, self.text)

    def test_the_workflow_actually_runs_the_verifier(self) -> None:
        self.assertIn("scripts/verify_live_deploy.py", self.text)

    def test_the_yaml_parses_and_the_job_keeps_its_steps_in_order(self) -> None:
        try:
            import yaml
        except ModuleNotFoundError:
            self.skipTest("PyYAML is not installed")
        document = yaml.safe_load(self.text)
        steps = document["jobs"]["deploy"]["steps"]
        names = [step.get("name") for step in steps if step.get("name")]
        self.assertEqual(
            names,
            [
                "Resolve the commit this run must see live",
                "Check the deploy hook secret exists",
                "Trigger the Render deploy",
                "Verify the new commit is live and serving current data",
            ],
        )


class ResolveCommitStepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.harness = ShellHarness()
        self.script = extract_run_step("Resolve the commit this run must see live")

    def tearDown(self) -> None:
        self.harness.close()

    def test_main_publishes_the_expected_commit(self) -> None:
        result = self.harness.run(
            self.script, GITHUB_REF_NAME="main", GITHUB_SHA=COMMIT
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            f"EXPECTED_COMMIT={COMMIT}",
            self.harness.github_env.read_text(encoding="utf-8"),
        )

    def test_other_branches_are_rejected_before_any_deploy(self) -> None:
        result = self.harness.run(
            self.script, GITHUB_REF_NAME="some-branch", GITHUB_SHA=COMMIT
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("must run on main", result.stderr)
        self.assertEqual(self.harness.github_env.read_text(encoding="utf-8"), "")


class SecretPresenceStepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.harness = ShellHarness()
        self.script = extract_run_step("Check the deploy hook secret exists")

    def tearDown(self) -> None:
        self.harness.close()

    def test_missing_secret_fails_loudly_and_actionably(self) -> None:
        result = self.harness.run(self.script, RENDER_DEPLOY_HOOK="")
        self.assertEqual(result.returncode, 1, "a missing secret must fail, not skip")
        message = result.stderr
        self.assertIn("RENDER_DEPLOY_HOOK", message)
        self.assertIn("Render", message)
        self.assertIn("Settings", message)
        self.assertIn("Deploy Hook", message)
        self.assertIn("NOT deployed", message)

    def test_present_secret_passes_without_printing_it(self) -> None:
        result = self.harness.run(self.script, RENDER_DEPLOY_HOOK=FAKE_HOOK)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(FAKE_HOOK, result.stdout + result.stderr)


class TriggerDeployStepTests(unittest.TestCase):
    def setUp(self) -> None:
        self.harness = ShellHarness()
        self.script = extract_run_step("Trigger the Render deploy")

    def tearDown(self) -> None:
        self.harness.close()

    def _run(self, body: str, exit_code: str = "0"):
        return self.harness.run(
            self.script,
            RENDER_DEPLOY_HOOK=FAKE_HOOK,
            CURL_BODY=body,
            CURL_EXIT=exit_code,
        )

    def test_accepted_hook_call_passes(self) -> None:
        for status in ("200", "201", "202"):
            with self.subTest(status=status):
                harness = ShellHarness()
                self.addCleanup(harness.close)
                result = harness.run(
                    self.script, RENDER_DEPLOY_HOOK=FAKE_HOOK, CURL_BODY=status
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Deploy hook accepted", result.stdout)

    def test_hook_url_is_passed_to_curl_but_never_printed(self) -> None:
        result = self._run("200")
        self.assertIn(FAKE_HOOK, self.harness.curl_log.read_text(encoding="utf-8"))
        self.assertNotIn(FAKE_HOOK, result.stdout + result.stderr)

    def test_rejected_hook_call_fails_and_stays_quiet_about_the_url(self) -> None:
        result = self._run("401")
        self.assertEqual(result.returncode, 1)
        self.assertIn("HTTP 401", result.stderr)
        self.assertIn("stale URL", result.stderr)
        self.assertNotIn(FAKE_HOOK, result.stdout + result.stderr)

    def test_server_error_from_the_hook_fails(self) -> None:
        result = self._run("500")
        self.assertEqual(result.returncode, 1)
        self.assertIn("HTTP 500", result.stderr)

    def test_unreachable_hook_fails_without_leaking_curl_stderr(self) -> None:
        result = self._run("", exit_code="6")
        self.assertEqual(result.returncode, 1)
        self.assertIn("HTTP 000", result.stderr)
        self.assertNotIn(FAKE_HOOK, result.stdout + result.stderr)


class FakeBackend:
    """Scripted replies for verify_live_deploy's fetcher."""

    def __init__(self, health: list, carparks=None) -> None:
        self.health = list(health)
        self.carparks = carparks
        self.health_calls = 0
        self.slept: list[float] = []
        self.clock = 0.0

    def fetch(self, url: str):
        if url.endswith("/health"):
            self.health_calls += 1
            index = min(self.health_calls - 1, len(self.health) - 1)
            reply = self.health[index]
            if isinstance(reply, Exception):
                raise reply
            return reply
        if isinstance(self.carparks, Exception):
            raise self.carparks
        return self.carparks

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.clock += seconds

    def now(self) -> float:
        return self.clock


def health_payload(commit) -> dict:
    payload = {"status": "ok", "carparks_loaded": 3000}
    if commit is not None:
        payload["commit"] = commit
    return payload


class WaitForCommitTests(unittest.TestCase):
    def wait(self, backend: FakeBackend, timeout: float = 120.0) -> None:
        verifier.wait_for_commit(
            "https://backend.example",
            COMMIT,
            timeout_seconds=timeout,
            poll_seconds=15.0,
            fetch=backend.fetch,
            sleep=backend.sleep,
            now=backend.now,
            log=lambda message: None,
        )

    def test_matching_commit_passes_on_the_first_check(self) -> None:
        backend = FakeBackend([health_payload(COMMIT)])
        self.wait(backend)
        self.assertEqual(backend.health_calls, 1)
        self.assertEqual(backend.slept, [])

    def test_passes_once_the_new_commit_appears(self) -> None:
        backend = FakeBackend(
            [health_payload(OTHER_COMMIT)] * 3 + [health_payload(COMMIT)]
        )
        self.wait(backend)
        self.assertEqual(backend.health_calls, 4)

    def test_a_backend_stuck_on_the_old_commit_fails(self) -> None:
        backend = FakeBackend([health_payload(OTHER_COMMIT)])
        with self.assertRaises(verifier.VerificationError) as caught:
            self.wait(backend)
        message = str(caught.exception)
        self.assertIn("never reported", message)
        self.assertIn(OTHER_COMMIT, message)

    def test_an_unknown_commit_fails_rather_than_passing(self) -> None:
        backend = FakeBackend([health_payload("")])
        with self.assertRaises(verifier.VerificationError) as caught:
            self.wait(backend)
        message = str(caught.exception)
        self.assertIn("reported no commit", message)
        self.assertIn("RENDER_GIT_COMMIT", message)

    def test_a_health_body_without_a_commit_field_is_also_unknown(self) -> None:
        backend = FakeBackend([health_payload(None)])
        with self.assertRaises(verifier.VerificationError) as caught:
            self.wait(backend)
        self.assertIn("reported no commit", str(caught.exception))

    def test_an_unreachable_backend_fails(self) -> None:
        backend = FakeBackend([verifier.VerificationError("request failed: refused")])
        with self.assertRaises(verifier.VerificationError) as caught:
            self.wait(backend)
        self.assertIn("no successful response", str(caught.exception))

    def test_a_backend_that_recovers_mid_deploy_still_passes(self) -> None:
        backend = FakeBackend(
            [
                verifier.VerificationError("HTTP 502"),
                verifier.VerificationError("HTTP 502"),
                health_payload(COMMIT),
            ]
        )
        self.wait(backend)
        self.assertEqual(backend.health_calls, 3)

    def test_polling_respects_the_timeout(self) -> None:
        backend = FakeBackend([health_payload(OTHER_COMMIT)])
        with self.assertRaises(verifier.VerificationError):
            self.wait(backend, timeout=120.0)
        # 120s of budget, polled every 15s: 8 checks and 7 sleeps in between.
        self.assertEqual(backend.health_calls, 8)
        self.assertEqual(backend.slept, [15.0] * 7)


class DatasetFingerprintTests(unittest.TestCase):
    def check(self, carparks) -> None:
        backend = FakeBackend([], carparks=carparks)
        verifier.assert_dataset_fingerprint(
            "https://backend.example", fetch=backend.fetch, log=lambda message: None
        )

    def test_current_dataset_passes(self) -> None:
        self.check([{"id": "SE5L", "free_parking_info": "NO"}])

    def test_stale_dataset_fails(self) -> None:
        with self.assertRaises(verifier.VerificationError) as caught:
            self.check([{"id": "SE5L", "free_parking_info": "SUN & PH FR 7AM-10.30PM"}])
        self.assertIn("stale enriched dataset", str(caught.exception))

    def test_missing_fingerprint_carpark_fails(self) -> None:
        with self.assertRaises(verifier.VerificationError) as caught:
            self.check([])
        self.assertIn("SE5L", str(caught.exception))

    def test_a_non_list_response_fails(self) -> None:
        with self.assertRaises(verifier.VerificationError):
            self.check({"detail": "internal server error"})

    def test_the_fingerprint_matches_the_committed_dataset(self) -> None:
        # Guards the assertion itself: if the dataset ever stops carrying
        # SE5L free_parking_info=NO, this fails here rather than turning every
        # future deploy red for a reason that looks like a deploy failure.
        import json

        records = json.loads(
            (ROOT / "backend" / "carparks_enriched.json").read_text(encoding="utf-8")
        )
        if isinstance(records, dict):
            records = records.get("carparks", records.get("data", []))
        match = [r for r in records if r.get("id") == verifier.FINGERPRINT_ID]
        self.assertEqual(len(match), 1, "fingerprint carpark SE5L is missing")
        # backend/main.py serves the dataset's "free_parking" as
        # "free_parking_info", which is the name the API response uses.
        self.assertEqual(match[0].get("free_parking"), verifier.FINGERPRINT_VALUE)


class VerifierEntryPointTests(unittest.TestCase):
    def test_an_empty_commit_is_rejected_before_any_request(self) -> None:
        self.assertEqual(verifier.main(["--commit", "  "]), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
