from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist


class PiCodingAgent(BaseInstalledAgent):
    """Pier adapter for paired Pi core and local pi-fabric DeepSWE trials."""

    SUPPORTS_ATIF = False

    def __init__(
        self,
        *args: Any,
        pi_agent_dir: str,
        fabric_package_path: str | None = None,
        thinking_level: str = "low",
        pi_version: str = "0.83.0",
        **kwargs: Any,
    ) -> None:
        self._pi_agent_dir = Path(pi_agent_dir).resolve()
        self._fabric_package_path = (
            Path(fabric_package_path).resolve() if fabric_package_path else None
        )
        self._thinking_level = thinking_level
        self._pi_version = pi_version
        self._session_logs_dir: Path | None = None
        if not (self._pi_agent_dir / "auth.json").is_file():
            raise ValueError(f"Pi auth.json not found under {self._pi_agent_dir}")
        if self._fabric_package_path and not self._fabric_package_path.is_file():
            raise ValueError(
                f"pi-fabric package not found: {self._fabric_package_path}"
            )
        super().__init__(*args, version=pi_version, **kwargs)

    @staticmethod
    def name() -> str:
        return "pi"

    def get_version_command(self) -> str | None:
        return "pi --version"

    def network_allowlist(self) -> NetworkAllowlist:
        return NetworkAllowlist(
            domains=[
                "api.openai.com",
                "auth.openai.com",
                "chatgpt.com",
            ]
        )

    def install_spec(self) -> AgentInstallSpec:
        package = f"@earendil-works/pi-coding-agent@{self._pi_version}"
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._pi_version,
            steps=[
                InstallStep(
                    user="root",
                    run=(
                        "set -euo pipefail; "
                        "if ! command -v npm >/dev/null; then "
                        "  echo 'Pi requires Node.js and npm' >&2; exit 1; "
                        "fi; "
                        "if ! command -v rg >/dev/null; then "
                        "  if command -v apt-get >/dev/null; then "
                        "    apt-get update && apt-get install -y ripgrep; "
                        "  elif command -v apk >/dev/null; then apk add --no-cache ripgrep; "
                        "  elif command -v yum >/dev/null; then yum install -y ripgrep; "
                        "  else echo 'Pi requires ripgrep' >&2; exit 1; fi; "
                        "fi; "
                        f"npm install -g --ignore-scripts {shlex.quote(package)}; "
                        "pi --version"
                    ),
                )
            ],
            verification_command="pi --version",
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        await environment.upload_dir(self._pi_agent_dir, "/tmp/pi-agent")
        ownership = ""
        if environment.default_user is not None:
            user = shlex.quote(str(environment.default_user))
            ownership = f"chown -R {user} /tmp/pi-agent; "
        await self.exec_as_root(
            environment,
            command=(
                ownership
                + "chmod 700 /tmp/pi-agent; "
                + "find /tmp/pi-agent -type f -exec chmod 600 {} +"
            ),
        )
        await self.exec_as_agent(
            environment,
            command=(
                "git -C /app config user.name 'Pi Agent'; "
                "git -C /app config user.email 'pi-agent@localhost'"
            ),
        )
        if self._fabric_package_path:
            await environment.upload_file(
                self._fabric_package_path, "/tmp/pi-fabric.tgz"
            )
            await self.exec_as_root(
                environment,
                command="npm install -g --ignore-scripts /tmp/pi-fabric.tgz",
            )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("Pi agent requires model_name")
        remote_session_dir = "/tmp/pi-session"
        local_session_dir = self.logs_dir / "pi-session"
        self._session_logs_dir = local_session_dir
        extension_flags = ""
        if self._fabric_package_path:
            extension_flags = '-e "$(npm root -g)/pi-fabric"'
        else:
            extension_flags = "--no-skills --no-extensions"
        command = " ".join(
            [
                "mkdir -p /tmp/pi-session /logs/agent;",
                "PI_CODING_AGENT_DIR=/tmp/pi-agent",
                "pi --print",
                f"--thinking {shlex.quote(self._thinking_level)}",
                f"--model {shlex.quote(self.model_name)}",
                f"--session-dir {remote_session_dir}",
                "--no-prompt-templates --no-context-files --no-themes",
                extension_flags,
                shlex.quote(instruction),
                "2>&1 </dev/null | tee /logs/agent/pi.txt",
            ]
        )
        try:
            await self.exec_as_agent(
                environment,
                command=command,
                env=self.build_process_env(
                    {"PI_CODING_AGENT_DIR": "/tmp/pi-agent"}
                ),
                cwd="/app",
            )
        finally:
            try:
                await environment.download_dir(
                    remote_session_dir, local_session_dir
                )
            except Exception as exc:
                self.logger.warning("Failed to download Pi session: %s", exc)

    def populate_context_post_run(self, context: AgentContext) -> None:
        if not self._session_logs_dir or not self._session_logs_dir.exists():
            return
        metrics = collect_pi_session_metrics(self._session_logs_dir)
        context.n_input_tokens = metrics["input_tokens"]
        context.n_cache_tokens = metrics["cache_tokens"]
        context.n_output_tokens = metrics["output_tokens"]
        context.cost_usd = metrics["cost_usd"]
        context.peak_context_tokens = metrics["peak_context_tokens"]
        context.summarization_count = metrics["summarization_count"]
        context.n_agent_steps = metrics["assistant_turns"]
        context.metadata = {
            "combined_total_tokens": metrics["combined_total_tokens"],
            "outer_tool_calls": metrics["outer_tool_calls"],
            "nested_tool_calls": metrics["nested_tool_calls"],
            "nested_calls_by_ref": metrics["nested_calls_by_ref"],
            "whole_file_reads": metrics["whole_file_reads"],
            "bounded_reads": metrics["bounded_reads"],
            "results_over_50kb": metrics["results_over_50kb"],
            "fabric_enabled": self._fabric_package_path is not None,
        }


def collect_pi_session_metrics(session_dir: Path) -> dict[str, Any]:
    input_tokens = 0
    cache_tokens = 0
    output_tokens = 0
    combined_total_tokens = 0
    cost_usd = 0.0
    peak_context_tokens = 0
    assistant_turns = 0
    outer_tool_calls = 0
    nested_tool_calls = 0
    summarization_count = 0
    whole_file_reads = 0
    bounded_reads = 0
    results_over_50kb = 0
    nested_calls_by_ref: dict[str, int] = {}

    for session_path in sorted(session_dir.rglob("*.jsonl")):
        for raw_line in session_path.read_text(errors="replace").splitlines():
            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if record.get("type") == "compaction":
                summarization_count += 1
            message = record.get("message")
            if not isinstance(message, dict):
                continue
            role = message.get("role")
            if role == "assistant":
                assistant_turns += 1
                usage = message.get("usage") or {}
                fresh = int(usage.get("input") or 0) + int(
                    usage.get("cacheWrite") or 0
                )
                cached = int(usage.get("cacheRead") or 0)
                output = int(usage.get("output") or 0)
                input_tokens += fresh + cached
                cache_tokens += cached
                output_tokens += output
                combined_total_tokens += int(usage.get("totalTokens") or 0)
                cost_usd += float((usage.get("cost") or {}).get("total") or 0)
                peak_context_tokens = max(
                    peak_context_tokens, fresh + cached
                )
                for item in message.get("content") or []:
                    if not isinstance(item, dict) or item.get("type") != "toolCall":
                        continue
                    outer_tool_calls += 1
                    if item.get("name") == "read":
                        args = item.get("arguments") or {}
                        if "offset" in args or "limit" in args:
                            bounded_reads += 1
                        else:
                            whole_file_reads += 1
            elif role == "toolResult":
                text = "".join(
                    item.get("text", "")
                    for item in message.get("content") or []
                    if isinstance(item, dict)
                )
                if len(text) > 50_000:
                    results_over_50kb += 1
                details = message.get("details") or {}
                trace = details.get("trace") or {}
                for operation in trace.get("operations") or []:
                    if not isinstance(operation, dict):
                        continue
                    nested_tool_calls += 1
                    ref = str(operation.get("ref") or "unknown")
                    nested_calls_by_ref[ref] = nested_calls_by_ref.get(ref, 0) + 1
                    if ref == "pi.read":
                        args = operation.get("args") or {}
                        if "offset" in args or "limit" in args:
                            bounded_reads += 1
                        else:
                            whole_file_reads += 1

    return {
        "input_tokens": input_tokens,
        "cache_tokens": cache_tokens,
        "output_tokens": output_tokens,
        "combined_total_tokens": combined_total_tokens,
        "cost_usd": round(cost_usd, 6),
        "peak_context_tokens": peak_context_tokens,
        "assistant_turns": assistant_turns,
        "outer_tool_calls": outer_tool_calls,
        "nested_tool_calls": nested_tool_calls,
        "nested_calls_by_ref": dict(sorted(nested_calls_by_ref.items())),
        "summarization_count": summarization_count,
        "whole_file_reads": whole_file_reads,
        "bounded_reads": bounded_reads,
        "results_over_50kb": results_over_50kb,
    }
