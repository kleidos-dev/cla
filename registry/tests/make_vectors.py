# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Writes tests/vectors/records.json from registry/schema/: records with one thing changed.

Every field of the two record schemas is dropped, duplicated by an unknown one, given a value of
another type and a value at each edge of its form. ``shape`` is what the schema says of the result
(and whether it is the record its path names), which the Worker's isSignatureRecord must say too;
``problem`` is what cla.check_record says of it, null for a valid record.

    python3 registry/tests/make_vectors.py          # writes the file
"""

from __future__ import annotations

import copy
import json
import re
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla
from support import CONFIG, REPO, VECTORS, comment_record, coverage_record
from support import signin_record as signin

SCHEMAS = cla.ROOT / "registry" / "schema"
INDIVIDUAL = json.loads((SCHEMAS / "individual.schema.json").read_text("utf-8"))["oneOf"]
COVERAGE = json.loads((SCHEMAS / "coverage.schema.json").read_text("utf-8"))
#: What each base is, its path and the schema of its kind.
BASES: dict[str, tuple[dict[str, Any], str, dict[str, Any]]] = {
    "comment": (comment_record(), "signatures/individual/1.json", INDIVIDUAL[0]),
    "signin": (signin(), "signatures/individual/1.json", INDIVIDUAL[1]),
    "coverage": (coverage_record(), f"coverage/{REPO}/7.json", COVERAGE),
}
Path_ = list[str | int]


def is_shape(schema: dict[str, Any], value: Any) -> bool:
    """Whether a value is what a schema says, for the keywords registry/schema/ uses."""
    known = {"$schema", "$id", "title", "description", "type", "const", "enum", "pattern"}
    known |= {"minimum", "required", "properties", "additionalProperties", "patternProperties"}
    known |= {"items", "uniqueItems"}
    if set(schema) - known:
        raise AssertionError(f"a keyword this does not check: {set(schema) - known}")
    if "const" in schema:
        return type(value) is type(schema["const"]) and value == schema["const"]
    if "enum" in schema:
        return value in schema["enum"]
    kind = schema["type"]
    if kind == "integer":
        return type(value) is int and value >= schema["minimum"]
    if kind == "string":
        # As in JavaScript: $ is the end, and \d the ten digits.
        return isinstance(value, str) and bool(re.fullmatch(schema["pattern"], value, re.ASCII))
    if kind == "array":
        return (
            isinstance(value, list)
            and all(is_shape(schema["items"], v) for v in value)
            and len({json.dumps(v) for v in value}) == len(value)
        )
    if not isinstance(value, dict) or set(schema.get("required", [])) - set(value):
        return False
    for key, v in value.items():
        found = [schema["properties"][key]] if key in schema.get("properties", {}) else []
        found += [s for p, s in schema.get("patternProperties", {}).items() if re.search(p, key)]
        if not found or not all(is_shape(s, v) for s in found):
            return False
    return True


def wrong(schema: dict[str, Any], value: Any) -> Iterator[Any]:
    """Values to put where ``value`` is: of other types, and at the edges of its form."""
    yield from (None, True, 0, "", [], {})
    if "enum" in schema:
        yield from (v for v in schema["enum"] if v != value)
        yield f"{value}\n"
        return
    if isinstance(value, bool) or not isinstance(value, int | str):
        return
    if isinstance(value, int):
        yield from (-1, value + 1, value + 0.5, str(value))
        return
    yield from (f"{value}\n", f"\n{value}", f" {value}", f"{value}-", f"-{value}", value[:-1])
    yield value.upper() if value != value.upper() else value.lower()
    # A digit of another script, which Python's \d takes.
    if m := re.search("[0-9]", value):
        yield f"{value[: m.start()]}{chr(0x660 + int(m[0]))}{value[m.end() :]}"
    yield from EDGES.get(schema.get("pattern", ""), ())


TIME = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"
LOGIN = "^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$"
CLIENT = "^[A-Za-z0-9.]{16,40}$"
#: More values at the edges of some forms.
EDGES: dict[str, tuple[str, ...]] = {
    TIME: (
        "2026-12-01 10:22:58Z",
        "2026-12-01T10:22:58z",
        "2026-12-01T10:22:58+00:00",
        "2026-12-01T10:22:58.5Z",
        "2026-02-29T10:22:58Z",
        "9999-99-99T99:99:99Z",
        "0000-01-01T00:00:00Z",
        "2026-12-01T24:00:00Z",
        "2026-12-01T10:22:60Z",
        "2026-12-01T23:59:59Z",
        "2020-01-01T00:00:00Z",
    ),
    LOGIN: (
        "a",
        "a" * 39,
        "a" * 40,
        "a-b",
        "a--b",
        "-a",
        "a-",
        "a_b",
        "alice[bot]",
        "\u017falice",
        "\u212a",
    ),
    CLIENT: ("a" * 15, "a" * 16, "a" * 40, "a" * 41, "Iv1." + "a" * 12, "a-" + "a" * 16),
}


def walk(schema: dict[str, Any], value: Any, at: Path_) -> Iterator[tuple[Path_, str, Any]]:
    """Every change of one thing: where, whether it is dropped or set, and to what."""
    for other in wrong(schema, value):
        if at:
            yield at, "set", other
    if isinstance(value, dict):
        yield [*at, "unknown"], "set", "203.0.113.7"
        for key, v in value.items():
            yield [*at, key], "drop", None
            inner = schema.get("properties", {}).get(key)
            inner = inner or next(iter(schema.get("patternProperties", {}).values()))
            yield from walk(inner, v, [*at, key])
        for key in ("0", "01", "1x", "\u0661", ""):
            if "patternProperties" in schema:
                yield [*at, key], "set", 1
    if isinstance(value, list):
        yield [*at, len(value)], "set", value[0]
        yield [*at, len(value)], "set", value[0] + 1
        for i, v in enumerate(value):
            yield from walk(schema["items"], v, [*at, i])


def others(of: str) -> Iterator[tuple[Path_, str, Any]]:
    """In each field, what a record of another kind may hold in it."""
    for other, (_, _, schema) in BASES.items():
        for key, form in schema["properties"].items():
            if other != of and key in BASES[of][0] and {"const", "enum"} & set(form):
                yield from (([key], "set", v) for v in form.get("enum", [form.get("const")]))


def apply(base: dict[str, Any], at: Path_, how: str, value: Any) -> dict[str, Any]:
    """The base with that one change."""
    out = copy.deepcopy(base)
    target: Any = out
    for key in at[:-1]:
        target = target[key]
    if how == "drop":
        del target[at[-1]]
    elif isinstance(target, list) and at[-1] == len(target):
        target.append(value)
    else:
        target[at[-1]] = value
    return out


def vectors() -> Iterator[dict[str, Any]]:
    for of, (base, path, schema) in BASES.items():
        yield verdict({"name": f"{of}: as written", "of": of}, base, path, schema)
        seen = set()
        for at, how, value in (*walk(schema, base, []), *others(of)):
            record = apply(base, at, how, value)
            text = json.dumps(record)
            if record == base and text == json.dumps(base) or text in seen:
                continue
            seen.add(text)
            where = ".".join(map(str, at))
            name = f"{of}: {where} " + ("missing" if how == "drop" else f"= {json.dumps(value)}")
            vector: dict[str, Any] = {"name": name, "of": of, "at": at}
            if how == "set":
                vector["value"] = value
            yield verdict(vector, record, path, schema)


def verdict(
    vector: dict[str, Any], record: dict[str, Any], path: str, schema: dict[str, Any]
) -> dict[str, Any]:
    key, number = ("pr", 7) if path.startswith("coverage/") else ("github_id", 1)
    named = record.get(key) == number and type(record[key]) is int
    named = named and (key != "pr" or record.get("repo") == REPO)
    shape = bool(named) and is_shape(schema, record)
    if shape and "comment_id" in record.get("evidence", {}):
        # What no schema can say: the two addresses of a comment are of the same comment.
        evidence = record["evidence"]
        url = f"{evidence['pr_url']}#issuecomment-{evidence['comment_id']}"
        shape = evidence["comment_url"] == url
    return {
        **vector,
        "shape": shape,
        "problem": cla.check_record(CONFIG, path, json.dumps(record).encode()),
    }


def document() -> str:
    """The whole file. One vector a line, so that a change of one is a change of one line."""
    head = {
        "comment": "Made by make_vectors.py. Each vector is its base with the value at `at` set to "
        "`value`, or dropped when there is none; an index one past the end of a list adds to it. "
        "`shape`: what registry/schema/ says, and worker/src/registry.ts isSignatureRecord must. "
        "`problem`: what registry/cla.py check_record says, null for a valid record.",
        "bases": {of: {"path": path, "record": base} for of, (base, path, _) in BASES.items()},
    }
    lines = ",\n".join(f"    {json.dumps(v)}" for v in vectors())
    return f'{json.dumps(head, indent=2)[:-2]},\n  "vectors": [\n{lines}\n  ]\n}}\n'


if __name__ == "__main__":
    (VECTORS / "records.json").write_text(document(), "utf-8")
