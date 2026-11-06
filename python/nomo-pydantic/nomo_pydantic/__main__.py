"""One local governed call for a harness, with its request on stdin."""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import sys

from nomo_transport import NomoTransportClient
from pydantic_ai.models import infer_model

from .workflow import run_governed_call


def emit(status: str, **values: object) -> None:
    print(json.dumps({"status": status, **values}, ensure_ascii=False))


async def run() -> int:
    parser = argparse.ArgumentParser(
        description="Run one NOMO-proxied Pydantic workflow"
    )
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--allow", action="append", required=True)
    parser.add_argument("--token-env")
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--include-raw", action="store_true")
    args = parser.parse_args()
    try:
        data = sys.stdin.buffer.read(65537)
        if len(data) > 65536:
            raise ValueError("request too large")
        request = json.loads(data)
        if not isinstance(request, dict):
            raise TypeError("request must be an object")
        tool = request.get("tool")
        arguments = request.get("arguments")
        key = request.get("idempotency_key")
        if (
            not isinstance(tool, str)
            or tool not in args.allow
            or not isinstance(arguments, dict)
            or not isinstance(key, str)
            or re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", key) is None
            or not 1 <= args.port <= 65535
            or not math.isfinite(args.timeout)
            or args.timeout <= 0
        ):
            raise ValueError("invalid request")
        model = infer_model(args.model)
    except Exception:  # noqa: BLE001 - avoid exposing input or provider configuration
        emit("invalid_request")
        return 2

    client = None
    try:
        client = NomoTransportClient(
            "127.0.0.1", args.port, token_env=args.token_env, timeout=args.timeout
        )
        await asyncio.to_thread(client.initialize)
        result = await run_governed_call(
            transport=client,
            tool=tool,
            arguments=arguments,
            idempotency_key=key,
            allowed_tools=set(args.allow),
            model=model,
            timeout=args.timeout,
        )
        values = {"summary": result.summary}
        if args.include_raw:
            values["raw_result"] = result.raw_result
        emit(result.status, **values)
        return {"succeeded": 0, "tool_error": 3, "summary_failed": 4}[result.status]
    except Exception:  # noqa: BLE001 - outcome may be unknown; never repeat dispatch here
        emit("outcome_unknown")
        return 1
    finally:
        if client is not None:
            await asyncio.to_thread(client.close)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
