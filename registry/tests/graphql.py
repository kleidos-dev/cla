# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""As much of a GraphQL server as the register's documents need, and no more.

The fake GitHub answers a document by running it, so a document that does not parse, that asks for a
field GitHub's answer has not, or that is sent with the wrong variables fails the test, and a field
the document leaves out is missing from the answer.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

TOKEN = re.compile(r"\.\.\.|[A-Za-z_][A-Za-z0-9_]*|\d+|[${}():!,]")


class Refused(Exception):
    """What GitHub answers with an error: its type."""


@dataclass
class Selection:
    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    #: The type of an inline fragment, whose fields count only for an object of that type.
    on: str | None = None
    fields: list[Selection] = field(default_factory=list)


class Document:
    """One parsed operation: what it declares and what it asks for."""

    def __init__(self, text: str) -> None:
        left = TOKEN.sub("", text).strip()
        if left:
            raise AssertionError(f"not GraphQL: {left!r}")
        self._tokens: list[str] = [t for t in TOKEN.findall(text) if t != ","]
        self.variables: dict[str, str] = {}
        self._operation()
        if self._tokens:
            raise AssertionError(f"text after the document: {self._tokens}")

    def _next(self, expected: str | None = None) -> str:
        if not self._tokens:
            raise AssertionError("the document ends early")
        token = self._tokens.pop(0)
        if expected is not None and token != expected:
            raise AssertionError(f"{token!r} where {expected!r} belongs")
        return token

    def _peek(self) -> str:
        return self._tokens[0] if self._tokens else ""

    def _operation(self) -> None:
        self.kind = self._next()
        if self.kind not in ("query", "mutation"):
            raise AssertionError(f"not an operation: {self.kind!r}")
        self._next("(")
        while self._peek() != ")":
            self._next("$")
            name = self._next()
            self._next(":")
            kind = self._next()
            if self._peek() == "!":
                kind += self._next()
            self.variables[name] = kind
        self._next(")")
        self.fields = list(self._selections())

    def _selections(self) -> Iterator[Selection]:
        self._next("{")
        while self._peek() != "}":
            name = self._next()
            if name == "...":
                self._next("on")
                kind = self._next()
                yield Selection("", {}, kind, list(self._selections()))
                continue
            chosen = Selection(name)
            if self._peek() == "(":
                self._next()
                while self._peek() != ")":
                    key = self._next()
                    self._next(":")
                    value = self._next()
                    chosen.arguments[key] = f"${self._next()}" if value == "$" else int(value)
                self._next(")")
            if self._peek() == "{":
                chosen.fields = list(self._selections())
            yield chosen
        self._next("}")


def run(text: str, variables: dict[str, Any], root: dict[str, Any]) -> dict[str, Any]:
    """What a server whose fields are ``root`` answers to the document.

    A field that is a function is called with the arguments the document gives it."""
    document = Document(text)
    if set(variables) != set(document.variables):
        raise AssertionError(f"sent {sorted(variables)}, declared {sorted(document.variables)}")
    for name, kind in document.variables.items():
        if kind.endswith("!") and variables[name] is None:
            raise Refused("NOT_A_VALUE")
    return _pick(document.fields, root, variables)


def _pick(
    fields: list[Selection], value: dict[str, Any], variables: dict[str, Any]
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for f in fields:
        if f.on is not None:
            if value.get("__typename") == f.on:
                out |= _pick(f.fields, value, variables)
            continue
        if f.name not in value:
            raise AssertionError(f"no field {f.name!r} here: {sorted(value)}")
        found = value[f.name]
        if callable(found):
            found = _call(found, f.arguments, variables)
        elif f.arguments:
            raise AssertionError(f"{f.name!r} takes no arguments")
        out[f.name] = _shape(f, found, variables)
    return out


def _call(resolver: Callable[..., Any], given: dict[str, Any], variables: dict[str, Any]) -> Any:
    values = {
        k: variables[v[1:]] if isinstance(v, str) else v  # a string is a variable's name
        for k, v in given.items()
    }
    return resolver(**values)


def _shape(f: Selection, found: Any, variables: dict[str, Any]) -> Any:
    if isinstance(found, list):
        return [_shape(f, x, variables) for x in found]
    if isinstance(found, dict):
        if not f.fields:
            raise AssertionError(f"{f.name!r} is an object: the document must say which fields")
        return _pick(f.fields, found, variables)
    if f.fields and found is not None:
        raise AssertionError(f"{f.name!r} has no fields")
    return found
