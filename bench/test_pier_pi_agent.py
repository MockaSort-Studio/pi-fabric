import json
import tempfile
import unittest
from pathlib import Path

from pier_pi_agent import collect_pi_session_metrics


class PiSessionMetricsTest(unittest.TestCase):
    def test_collects_pareto_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            session = Path(directory) / "session.jsonl"
            records = [
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "usage": {
                            "input": 100,
                            "cacheWrite": 5,
                            "cacheRead": 200,
                            "output": 20,
                            "totalTokens": 325,
                            "cost": {"total": 0.25},
                        },
                        "content": [
                            {
                                "type": "toolCall",
                                "name": "read",
                                "arguments": {"path": "README.md"},
                            }
                        ],
                    },
                },
                {
                    "type": "message",
                    "message": {
                        "role": "toolResult",
                        "toolName": "fabric_exec",
                        "content": [{"type": "text", "text": "x" * 50_001}],
                        "details": {
                            "trace": {
                                "operations": [
                                    {
                                        "ref": "pi.read",
                                        "args": {
                                            "path": "src/a.ts",
                                            "offset": 10,
                                            "limit": 20,
                                        },
                                    },
                                    {
                                        "ref": "pi.edit",
                                        "args": {"path": "src/a.ts"},
                                    },
                                ]
                            }
                        },
                    },
                },
                {"type": "compaction"},
            ]
            session.write_text("".join(json.dumps(row) + "\n" for row in records))

            metrics = collect_pi_session_metrics(Path(directory))

        self.assertEqual(metrics["input_tokens"], 305)
        self.assertEqual(metrics["cache_tokens"], 200)
        self.assertEqual(metrics["output_tokens"], 20)
        self.assertEqual(metrics["combined_total_tokens"], 325)
        self.assertEqual(metrics["peak_context_tokens"], 305)
        self.assertEqual(metrics["outer_tool_calls"], 1)
        self.assertEqual(metrics["nested_tool_calls"], 2)
        self.assertEqual(metrics["nested_calls_by_ref"], {
            "pi.edit": 1,
            "pi.read": 1,
        })
        self.assertEqual(metrics["whole_file_reads"], 1)
        self.assertEqual(metrics["bounded_reads"], 1)
        self.assertEqual(metrics["results_over_50kb"], 1)
        self.assertEqual(metrics["summarization_count"], 1)


if __name__ == "__main__":
    unittest.main()
