# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Generated input for the property tests, hostile on purpose, the same in every run.

REGISTER_SEED in the environment gives another: the weekly run prints the one it used, and what it
finds becomes a named example."""

from __future__ import annotations

import os
import random
import string
from typing import Any

SEED = int(os.environ.get("REGISTER_SEED", "20261124"))
#: White space, line ends, brackets, digits and letters of other scripts, controls, and the edges
#: of what a string can hold.
ODD = (
    "\t\n\v\f\r\x00\x1b\x1c\x1f \x85\xa0\u1680\u2000\u200b\u2028\u2029\u202e\u3000\ufeff"
    "<>@+-._[]{}\"'\\/:%$^|*?#&=~`!,;()"
    "\u0661\u0967\u017f\u212a\u0130\u00e9\u0430\u03a3\ud800\udfff\U0001f600"
)


class Generate(random.Random):
    """Random values of the kinds the register reads."""

    def text(self, longest: int = 40) -> str:
        letters = string.ascii_letters + string.digits
        return "".join(
            self.choice(ODD if self.random() < 0.3 else letters)
            for _ in range(self.randrange(longest))
        )

    def line(self) -> str:
        """Part of a commit message, often of a trailer."""
        return self.choice(
            (
                "\n",
                "\r",
                "\u2028",
                "Co-authored-by: ",
                "CO-AUTHORED-BY:",
                "<a@x.y>",
                "<",
                ">",
                "<1+a@users.noreply.github.com>",
                self.text(8),
            )
        )

    def message(self) -> str:
        return "".join(self.line() for _ in range(self.randrange(12)))

    def login(self) -> str:
        """A login GitHub can have."""
        parts = [
            "".join(
                self.choice(string.ascii_letters + string.digits)
                for _ in range(self.randrange(1, 10))
            )
            for _ in range(self.randrange(1, 4))
        ]
        return "-".join(parts)

    def json(self, deep: int = 2) -> Any:
        """Any JSON value, also the ones that look right."""
        scalars = (
            None,
            True,
            False,
            0,
            1,
            -1,
            2**53,
            1.0,
            1e400,
            "",
            "alice",
            "2026-12-01T10:22:58Z",
            "f" * 40,
            "f" * 64,
        )
        kind = self.randrange(4 if deep else 2)
        if kind == 0:
            return self.choice(scalars)
        if kind == 1:
            return self.text()
        if kind == 2:
            return [self.json(deep - 1) for _ in range(self.randrange(3))]
        return {self.text(6): self.json(deep - 1) for _ in range(self.randrange(3))}

    def bytes(self, longest: int = 60) -> bytes:
        return self.randbytes(self.randrange(longest))
