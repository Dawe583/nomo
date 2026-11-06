"""Fixture-driven evaluations for governed workflow outcomes."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator, EvaluatorContext

from .workflow import RunResult


@dataclass
class ExpectedStatus(Evaluator[Any, RunResult]):
    def evaluate(self, ctx: EvaluatorContext[Any, RunResult]) -> bool:
        return ctx.output.status == ctx.expected_output


async def evaluate_statuses(
    cases: list[Case], task: Callable[[Any], Awaitable[RunResult]]
):
    """Evaluate supplied cases; callers must use fixtures for side-effecting tasks."""
    dataset = Dataset(
        name="nomo-governed-outcomes", cases=cases, evaluators=[ExpectedStatus()]
    )
    return await dataset.evaluate(task, max_concurrency=1, progress=False)
