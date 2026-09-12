from __future__ import annotations

import json
import runpy
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from deepseek_harness import RunResult


ROOT = Path(__file__).resolve().parents[3]
SMOKE = runpy.run_path(ROOT / "scripts" / "smoke-python-runtime.py")


def live_result(**overrides: object) -> RunResult:
    values = {
        "session_id": "installed-wheel-live-api",
        "final_response": SMOKE["LIVE_API_SENTINEL"],
        "finish_reason": "completed",
        "events": [{"type": "tool/call", "data": {"name": "unrelated_tool"}}],
        "notifications": [],
    }
    values.update(overrides)
    return RunResult(**values)


@pytest.fixture
def live_smoke(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    import deepseek_harness

    state = SimpleNamespace(
        prompts=[], session_ids=[], challenges=[], checked_logs=[], closed=False,
        create_bytes=SMOKE["LIVE_API_SENTINEL"].encode("utf-8"),
        create_result=live_result(), verify_result=live_result(), receipt_mode="copy",
    )
    globals_ = SMOKE["smoke_sdk_live"].__globals__
    token_hex = globals_["secrets"].token_hex

    def fresh_challenge(size: int) -> str:
        assert len(state.prompts) == 1
        value = token_hex(size)
        state.challenges.append(value)
        return value

    class ScriptedHarness:
        def __init__(self, **kwargs: object) -> None:
            state.root = Path(kwargs["cwd"])
            assert "toolChoice" not in kwargs

        def __enter__(self) -> ScriptedHarness:
            return self

        def __exit__(self, *args: object) -> None:
            state.closed = True

        def run(self, prompt: str, *, session_id: str) -> RunResult:
            state.prompts.append(prompt)
            state.session_ids.append(session_id)
            if len(state.prompts) == 1:
                state.marker = Path(prompt.splitlines()[-1])
                assert state.marker.parent == state.root
                if state.create_bytes is not None:
                    state.marker.write_bytes(state.create_bytes)
                return state.create_result

            assert len(state.prompts) == 2
            assert len(state.challenges) == 1
            challenge = state.challenges[0]
            assert all(challenge not in sent for sent in state.prompts)
            assert str(state.marker) not in prompt
            assert "previous turn" in prompt and "changed externally" in prompt
            assert state.marker.read_bytes() == challenge.encode("ascii")
            receipt = Path(prompt.splitlines()[-1])
            assert receipt != state.marker and not receipt.exists()
            if state.receipt_mode == "copy":
                receipt.write_bytes(state.marker.read_bytes())
            elif state.receipt_mode == "stale":
                receipt.write_bytes(state.create_bytes)
            elif state.receipt_mode == "wrong":
                receipt.write_bytes(b"wrong")
            elif state.receipt_mode == "newline":
                receipt.write_bytes(state.marker.read_bytes() + b"\n")
            elif state.receipt_mode == "changed-source":
                receipt.write_bytes(state.marker.read_bytes())
                state.marker.write_bytes(b"changed")
            elif state.receipt_mode != "missing":
                raise AssertionError(state.receipt_mode)
            return state.verify_result

    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-key")
    monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.invalid")
    monkeypatch.setattr(deepseek_harness, "DeepSeekHarness", ScriptedHarness)
    monkeypatch.setattr(globals_["secrets"], "token_hex", fresh_challenge)
    monkeypatch.setitem(globals_, "assert_zstd_session_log", state.checked_logs.append)
    return state


def test_live_smoke_requires_fresh_external_content(live_smoke: SimpleNamespace) -> None:
    SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == 2
    assert live_smoke.session_ids == ["installed-wheel-live-api"] * 2
    assert len(live_smoke.checked_logs) == 1
    assert live_smoke.closed and not live_smoke.root.exists()


@pytest.mark.parametrize("label", ["create", "verify"])
@pytest.mark.parametrize(("overrides", "message"), [
    ({"finish_reason": "error"}, "turn ended with 'error'"),
    ({"finish_reason": "error", "events": [{
        "type": "turn/end", "data": {"turn": 1, "reason": {
            "kind": "error", "error": {"code": "AUTH", "status": 401},
        }},
    }]}, "turn ended with.*AUTH.*401"),
    ({"events": []}, "turn made no model-requested tool call"),
    ({"final_response": "PYTHON_SDK_LIVE_OK extra"}, "turn returned"),
])
def test_live_smoke_rejects_invalid_turn_before_continuing(
    live_smoke: SimpleNamespace, label: str, overrides: dict[str, object], message: str,
) -> None:
    setattr(live_smoke, f"{label}_result", live_result(**overrides))
    with pytest.raises(AssertionError, match=f"{label} {message}"):
        SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == (1 if label == "create" else 2)
    assert not live_smoke.checked_logs
    assert live_smoke.closed
    if label == "create":
        assert not live_smoke.challenges


@pytest.mark.parametrize("content", [None, b"wrong", b"PYTHON_SDK_LIVE_OK\n"])
def test_live_smoke_rejects_bad_create_before_host_overwrite(
    live_smoke: SimpleNamespace, content: bytes | None,
) -> None:
    live_smoke.create_bytes = content
    with pytest.raises(AssertionError, match="create turn (did not create|wrote unexpected bytes)"):
        SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == 1
    assert not live_smoke.challenges and not live_smoke.checked_logs
    assert live_smoke.closed


@pytest.mark.parametrize(("mode", "message"), [
    ("missing", "did not create receipt"),
    ("stale", "wrote unexpected bytes to receipt"),
    ("wrong", "wrote unexpected bytes to receipt"),
    ("newline", "wrote unexpected bytes to receipt"),
    ("changed-source", "changed source file"),
])
def test_live_smoke_rejects_unrelated_tool_without_exact_receipt(
    live_smoke: SimpleNamespace, mode: str, message: str,
) -> None:
    live_smoke.receipt_mode = mode
    with pytest.raises(AssertionError, match=f"verify turn {message}"):
        SMOKE["smoke_sdk_live"]()
    assert len(live_smoke.prompts) == 2
    assert not live_smoke.checked_logs
    assert live_smoke.closed


@pytest.mark.parametrize(
    ("prompt_name", "expected"),
    [
        ("SNAPSHOT_DIRECT_CHILD_PROMPT", "DIRECT_CHILD_OK"),
        ("SNAPSHOT_WORKFLOW_CHILD_PROMPT", "WORKFLOW_CHILD_OK"),
    ],
)
def test_child_prompt_precedes_runtime_context(prompt_name: str, expected: str) -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [
            {"role": "user", "content": SMOKE[prompt_name]},
            {"role": "user", "content": "Current runtime context"},
        ],
    })

    assert any(
        choice.get("delta", {}).get("content") == expected
        for chunk in chunks
        for choice in chunk.get("choices", [])
    )


def test_mcp_smoke_requests_the_discovered_tool() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [{"role": "user", "content": SMOKE["MCP_PROMPT"]}],
        "tools": [{"type": "function", "function": {"name": "mcp__fixture__add"}}],
    })

    calls = [
        call
        for chunk in chunks
        for choice in chunk.get("choices", [])
        for call in choice.get("delta", {}).get("tool_calls", [])
    ]
    assert calls[0]["function"] == {
        "name": "mcp__fixture__add",
        "arguments": '{"a": 19, "b": 23}',
    }


def test_mcp_smoke_accepts_the_external_server_result() -> None:
    chunks = SMOKE["completion_chunks"]({
        "messages": [
            {"role": "user", "content": SMOKE["MCP_PROMPT"]},
            {
                "role": "assistant",
                "tool_calls": [{
                    "id": "mcp-add",
                    "type": "function",
                    "function": {"name": "mcp__fixture__add", "arguments": '{}'},
                }],
            },
            {"role": "tool", "tool_call_id": "mcp-add", "content": "42"},
        ],
    })

    assert any(
        choice.get("delta", {}).get("content") == SMOKE["MCP_TEXT"]
        for chunk in chunks
        for choice in chunk.get("choices", [])
    )


def test_snapshot_comparison_preserves_opaque_generation_provenance() -> None:
    normalize = SMOKE["normalize_session_format_comparison"]
    expected = {
        "header": {"type": "session", "version": 0, "otherVersion": 7},
        "accepted": {
            "type": "session-log-deepseek/delivery-accepted",
            "data": {"sessionId": "s", "throughSeq": 4},
        },
        "source": {
            "kind": "session-reference",
            "references": [{"sessionId": "other", "capturedThroughSeq": 8}],
        },
    }
    actual = {
        "header": {"type": "session", "version": 1, "otherVersion": 7},
        "accepted": {
            "type": "session-log-deepseek/delivery-accepted",
            "data": {"sessionId": "s", "sessionFormatVersion": 1, "throughSeq": 4},
        },
        "source": {
            "kind": "session-reference",
            "references": [{
                "sessionId": "other",
                "capturedFormatVersion": 1,
                "capturedThroughSeq": 8,
            }],
        },
    }

    assert normalize(expected) != normalize(actual)
    assert normalize(expected)["header"] == normalize(actual)["header"]
    assert normalize(expected)["header"]["otherVersion"] == 7
    assert normalize(actual)["accepted"] == actual["accepted"]
    assert normalize(actual)["source"] == actual["source"]


def test_snapshot_value_scrubs_system_nodes_without_erasing_header_fields() -> None:
    normalize = SMOKE["normalize_snapshot_value"]
    system = {
        "type": "system/message",
        "data": {"message": {"role": "system", "content": [{"type": "text", "text": "prompt"}]}},
    }
    header = {"type": "request/header", "data": {"header": {"system": "unexpected"}}}
    assert normalize(system, [])["data"]["message"]["content"] == [{"type": "text", "text": "{{system}}"}]
    assert normalize(header, []) == header
    empty = {"type": "system/message", "data": {"message": {"role": "system", "content": []}}}
    assert normalize(empty, []) == empty


def test_snapshot_value_normalizes_embedded_assistant_stream_timing() -> None:
    normalize = SMOKE["normalize_snapshot_value"]
    event = {
        "type": "assistant/message",
        "seq": 4,
        "time": 100,
        "data": {
            "stream": [
                {"type": "chunk", "time": 101, "chunk": {"type": "finish"}},
                {"type": "text-chunks", "time0": 102, "dt": [1, 2], "texts": ["a", "b", "c"]},
            ],
        },
    }

    normalized = normalize(event, [])

    assert normalized["time"] == 0
    assert normalized["data"]["stream"] == [
        {"type": "chunk", "time": 0, "chunk": {"type": "finish"}},
        {"type": "text-chunks", "time0": 0, "dt": [0, 0], "texts": ["a", "b", "c"]},
    ]


def test_snapshot_comparison_expands_embedded_assistant_streams() -> None:
    normalize = SMOKE["normalize_session_format_comparison"]
    expected = [
        {
            "type": "assistant/chunk",
            "seq": 4,
            "time": 0,
            "data": {"turn": 1, "step": 1, "chunk": {
                "type": "text-delta", "index": 0, "text": "done",
            }},
        },
        {
            "type": "assistant/message",
            "seq": 5,
            "time": 0,
            "data": {"turn": 1, "step": 1, "message": {"role": "assistant"}},
            "sourceEventSeqs": [4],
            "surfaceOp": "append",
        },
    ]
    actual = [{
        "type": "assistant/message",
        "seq": 4,
        "time": 0,
        "data": {
            "turn": 1,
            "step": 1,
            "message": {"role": "assistant"},
            "stream": [{
                "type": "text-chunks", "time0": 0, "index": 0, "dt": [], "texts": ["done"],
            }],
        },
        "surfaceOp": "append",
    }]

    assert normalize(actual, 2) == normalize(expected, 1)

    tool_result = {
        "type": "tool/result",
        "data": {"turn": 1, "step": 1},
        "sourceEventSeqs": [4],
    }
    assert normalize(tool_result, 1)["sourceEventSeqs"] == [4]
    assert normalize(tool_result, 2)["sourceEventSeqs"] == [4]


def test_snapshot_stream_expands_reasoning_and_tool_call_records() -> None:
    expand = SMOKE["expand_snapshot_stream_member"]

    assert expand({
        "type": "reasoning-chunks", "time0": 0, "index": 1,
        "dt": [], "texts": ["think"],
    }) == [{"type": "reasoning-delta", "index": 1, "text": "think"}]
    assert expand({
        "type": "tool-call-chunks", "time0": 0, "index": 2,
        "id": "call-1", "name": "read", "dt": [1], "args": ["{", "}"],
    }) == [
        {"type": "tool-call-delta", "index": 2, "id": "call-1", "name": "read", "argumentsDelta": "{"},
        {"type": "tool-call-delta", "index": 2, "id": "call-1", "name": "read", "argumentsDelta": "}"},
    ]


def test_snapshot_file_builder_order_is_checked_outside_update_mode(tmp_path: Path) -> None:
    compare = SMOKE["compare_snapshot_files"]

    with pytest.raises(AssertionError, match="snapshot builder produced"):
        compare({}, False, tmp_path, ("result.json",))


def writer_oracle_fixture(tmp_path: Path) -> tuple[dict[str, str], tuple[str, ...], dict[Path, bytes]]:
    files = {"result.json": "{}\n"}
    for ordinal in ("", ".1"):
        historical = tmp_path / f"session{ordinal}.v2.jsonl"
        historical.write_text('{"type":"session","version":2,"id":"old"}\n', encoding="utf-8")
        content = ('{"type":"session","version":3,"id":"current"}\n'
                   '{"type":"tool-workflow/phase","data":{"title":"Delegate","ordinal":1}}\n')
        files[f"session{ordinal}.v3.jsonl"] = content
        (tmp_path / f"writer{ordinal}.expected.jsonl").write_text(content, encoding="utf-8")
    (tmp_path / "result.json").write_text(files["result.json"], encoding="utf-8")
    historical_bytes = {path: path.read_bytes() for path in tmp_path.glob("session*.jsonl")}
    return files, tuple(files), historical_bytes


def test_explicit_writer_oracles_compare_complete_current_output(tmp_path: Path) -> None:
    files, filenames, historical = writer_oracle_fixture(tmp_path)
    SMOKE["compare_snapshot_files"](files, False, tmp_path, filenames, writer_oracles=True)
    assert all(path.read_bytes() == content for path, content in historical.items())
    with pytest.raises(AssertionError, match="snapshot files differ"):
        SMOKE["compare_snapshot_files"](files, False, tmp_path, filenames)


@pytest.mark.parametrize("name", ["session.v3.jsonl", "session.1.v3.jsonl"])
def test_writer_oracles_reject_changed_event_payload(tmp_path: Path, name: str) -> None:
    files, filenames, _ = writer_oracle_fixture(tmp_path)
    files[name] = files[name].replace('"Delegate"', '"Unexpected"')
    with pytest.raises(AssertionError, match="executable snapshot mismatch in session"):
        SMOKE["compare_snapshot_files"](files, False, tmp_path, filenames, writer_oracles=True)


@pytest.mark.parametrize("update", [False, True])
@pytest.mark.parametrize("extra", [False, True])
def test_writer_oracles_require_exact_role_inventory(tmp_path: Path, update: bool, extra: bool) -> None:
    files, filenames, historical = writer_oracle_fixture(tmp_path)
    if extra:
        (tmp_path / "writer.2.expected.jsonl").write_text(files["session.v3.jsonl"], encoding="utf-8")
    else:
        (tmp_path / "writer.1.expected.jsonl").unlink()
    with pytest.raises(AssertionError, match="writer oracle roles differ"):
        SMOKE["compare_snapshot_files"](files, update, tmp_path, filenames, writer_oracles=True)
    assert all(path.read_bytes() == content for path, content in historical.items())


@pytest.mark.parametrize("update", [False, True])
def test_writer_oracles_validate_actual_filename_and_header(tmp_path: Path, update: bool) -> None:
    files, _, historical = writer_oracle_fixture(tmp_path)
    files["session.v2.jsonl"] = files.pop("session.v3.jsonl")
    with pytest.raises(AssertionError, match="filename declares Session format v2"):
        SMOKE["compare_snapshot_files"](files, update, tmp_path, tuple(files), writer_oracles=True)
    assert all(path.read_bytes() == content for path, content in historical.items())


@pytest.mark.parametrize("update", [False, True])
def test_writer_oracles_validate_expected_current_header(tmp_path: Path, update: bool) -> None:
    files, filenames, _ = writer_oracle_fixture(tmp_path)
    (tmp_path / "writer.expected.jsonl").write_text('{"type":"session","version":2}\n', encoding="utf-8")
    with pytest.raises(AssertionError, match="expected current Session format v3"):
        SMOKE["compare_snapshot_files"](files, update, tmp_path, filenames, writer_oracles=True)


@pytest.mark.parametrize("invalid", ["header", "role", "missing-role"])
def test_writer_oracles_still_validate_historical_inventory(tmp_path: Path, invalid: str) -> None:
    files, filenames, _ = writer_oracle_fixture(tmp_path)
    if invalid == "header":
        (tmp_path / "session.v2.jsonl").write_text('{"type":"session","version":1}\n', encoding="utf-8")
        message = "filename declares Session format v2"
    else:
        if invalid == "missing-role":
            (tmp_path / "session.1.v2.jsonl").unlink()
        else:
            (tmp_path / "session.2.v2.jsonl").write_text('{"type":"session","version":2}\n', encoding="utf-8")
        message = "snapshot Session roles differ"
    before = {path: path.read_bytes() for path in tmp_path.iterdir()}
    with pytest.raises(AssertionError, match=message):
        SMOKE["compare_snapshot_files"](files, True, tmp_path, filenames, writer_oracles=True)
    assert {path: path.read_bytes() for path in tmp_path.iterdir()} == before


def test_writer_oracle_update_preserves_all_canonical_generations(tmp_path: Path) -> None:
    files, filenames, historical = writer_oracle_fixture(tmp_path)
    current_path = tmp_path / "session.v3.jsonl"
    current_path.write_text(files["session.v3.jsonl"], encoding="utf-8")
    historical[current_path] = current_path.read_bytes()
    files = {name: text.replace('"Delegate"', '"Changed"') for name, text in files.items()}
    files["result.json"] = '{"updated":true}\n'
    SMOKE["compare_snapshot_files"](files, True, tmp_path, filenames, writer_oracles=True)
    assert all(path.read_bytes() == content for path, content in historical.items())
    assert {path for path in tmp_path.glob("session*.jsonl")} == set(historical)
    assert (tmp_path / "writer.expected.jsonl").read_text(encoding="utf-8") == files["session.v3.jsonl"]
    assert (tmp_path / "writer.1.expected.jsonl").read_text(encoding="utf-8") == files["session.1.v3.jsonl"]
    assert (tmp_path / "result.json").read_text(encoding="utf-8") == files["result.json"]


def test_snapshot_comparison_expands_sdk_wrapped_attempts() -> None:
    normalize = SMOKE["normalize_session_format_comparison"]
    actual = [{
        "method": "session.event",
        "payload": {
            "sessionId": "s",
            "event": {
                "type": "assistant/attempt",
                "seq": 7,
                "time": 0,
                "data": {
                    "turn": 1,
                    "step": 1,
                    "stream": [{"type": "chunk", "time": 0, "chunk": {"type": "finish"}}],
                },
            },
        },
    }]

    assert normalize(actual) == [{
        "method": "session.event",
        "payload": {
            "sessionId": "s",
            "event": {
                "type": "assistant/chunk",
                "data": {"turn": 1, "step": 1, "chunk": {"type": "finish"}},
            },
        },
    }]


def test_snapshot_generation_names_select_highest_role_without_double_counting(
    tmp_path: Path,
) -> None:
    render = SMOKE["snapshot_session_filename"]
    select = SMOKE["selected_snapshot_session_files"]
    assert render(0, 0) == "session.jsonl"
    assert render(0, 2) == "session.v2.jsonl"
    assert render(3, 0) == "session.3.jsonl"
    assert render(3, 2) == "session.3.v2.jsonl"

    (tmp_path / "session.jsonl").write_text(
        '{"type":"session","version":0}\n', encoding="utf-8",
    )
    (tmp_path / "session.v1.jsonl").write_text(
        '{"type":"session","version":1}\n', encoding="utf-8",
    )
    (tmp_path / "session.1.jsonl").write_text(
        '{"type":"session","version":0}\n', encoding="utf-8",
    )

    assert {index: path.name for index, path in select(tmp_path).items()} == {
        0: "session.v1.jsonl",
        1: "session.1.jsonl",
    }


def test_snapshot_comparison_accepts_v3_output_against_v2_without_rewriting(tmp_path: Path) -> None:
    predecessor = '{"type":"session","version":2}\n'
    successor = '{"type":"session","version":3}\n'
    old_path = tmp_path / "session.v2.jsonl"
    old_path.write_text(predecessor, encoding="utf-8")
    files = {"session.v3.jsonl": successor}

    SMOKE["compare_snapshot_files"](files, False, tmp_path, ("session.v2.jsonl",))
    assert old_path.read_text(encoding="utf-8") == predecessor
    assert not (tmp_path / "session.v3.jsonl").exists()

    SMOKE["compare_snapshot_files"](files, True, tmp_path, ("session.v2.jsonl",))
    assert old_path.read_text(encoding="utf-8") == predecessor
    assert (tmp_path / "session.v3.jsonl").read_text(encoding="utf-8") == successor
    assert SMOKE["selected_snapshot_session_files"](tmp_path) == {0: tmp_path / "session.v3.jsonl"}


@pytest.mark.parametrize("filenames", [
    ("session.1.v2.jsonl", "session.v2.jsonl"),
    ("session.v2.jsonl",),
    ("session.v2.jsonl", "session.2.v2.jsonl"),
])
def test_snapshot_builder_checks_role_order_and_count_across_generations(
    tmp_path: Path, filenames: tuple[str, ...],
) -> None:
    files = {"session.v3.jsonl": "", "session.1.v3.jsonl": ""}
    with pytest.raises(AssertionError, match="snapshot builder produced"):
        SMOKE["compare_snapshot_files"](files, False, tmp_path, filenames)


def test_snapshot_generation_comparison_rejects_changed_payload(tmp_path: Path) -> None:
    (tmp_path / "session.v2.jsonl").write_text(
        '{"type":"session","version":2,"id":"expected"}\n', encoding="utf-8",
    )
    with pytest.raises(AssertionError, match="executable snapshot mismatch"):
        SMOKE["compare_snapshot_files"](
            {"session.v3.jsonl": '{"type":"session","version":3,"id":"changed"}\n'},
            False, tmp_path, ("session.v2.jsonl",),
        )


@pytest.mark.parametrize("version", [2, 4])
@pytest.mark.parametrize("update", [False, True])
@pytest.mark.parametrize("writer_oracles", [False, True])
def test_snapshot_comparison_rejects_noncurrent_writer(
    tmp_path: Path, version: int, update: bool, writer_oracles: bool,
) -> None:
    golden = '{"type":"session","version":2}\n'
    (tmp_path / "session.v2.jsonl").write_text(golden, encoding="utf-8")
    content = json.dumps({"type": "session", "version": version}) + "\n"
    with pytest.raises(AssertionError, match="expected current Session format v3"):
        SMOKE["compare_snapshot_files"](
            {f"session.v{version}.jsonl": content}, update, tmp_path, ("session.v2.jsonl",),
            writer_oracles=writer_oracles,
        )
    assert (tmp_path / "session.v2.jsonl").read_text(encoding="utf-8") == golden
    assert not (tmp_path / "session.v4.jsonl").exists()


@pytest.mark.parametrize("version", [2, 3, 4])
def test_persisted_session_requires_current_writer(version: int) -> None:
    content = json.dumps({"type": "session", "version": version}) + "\n"
    path = Path(f"session.v{version}.jsonl")
    if version == 3:
        assert SMOKE["assert_persisted_session_version"](path, content) == version
    else:
        with pytest.raises(AssertionError, match="expected current Session format v3"):
            SMOKE["assert_persisted_session_version"](path, content)


def test_snapshot_generation_filename_must_match_header(tmp_path: Path) -> None:
    (tmp_path / "session.v1.jsonl").write_text(
        '{"type":"session","version":0}\n', encoding="utf-8",
    )

    with pytest.raises(AssertionError, match="filename declares Session format v1"):
        SMOKE["selected_snapshot_session_files"](tmp_path)


@pytest.mark.parametrize("returncode", [1, -1073741819, 3221225477])
def test_profile_plugin_failure_reports_native_exit_status(monkeypatch: pytest.MonkeyPatch, returncode: int) -> None:
    def failed_install(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args=[], returncode=returncode, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", failed_install)
    with pytest.raises(AssertionError) as error:
        SMOKE["smoke_sdk_profile_plugin"]("http://127.0.0.1:1")
    message = str(error.value)
    assert f"returncode={returncode}" in message
    assert f"0x{returncode & 0xffffffff:08x}" in message
    assert "stdout='' stderr=''" in message
