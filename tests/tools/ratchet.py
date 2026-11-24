# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
r"""The ratchet of the test measures: a count of misses only falls.

Each area has its floors (tests/floors/<area>.toml: what is missed of each measure, per kind, and
what there is to miss, per file) and its exclusions (tests/exclusions/<area>.toml: every miss that
stays, with its reason). ``check`` reads the reports the test run wrote and fails on

- a miss that is not listed,
- an entry of the list that is now covered or killed, or whose text is gone,
- a count above its floor, and one below it: the same change lowers the floor,
- a list longer than its floor,
- a file of the area a report does not have, or has with nothing in it, and a number of lines,
  branches, functions, conditions or mutants that is not the one the floors say: a measure that
  looked at less finds less, and would pass.

``base`` fails when a floor is higher than in another revision, or a number of what there is to miss
lower, without a dated line in its table ``raised`` or ``lowered``. ``files`` names the files of an
area, or one of N even shares of them. ``pragmas`` fails on an inline pragma that hides a miss from
a tool. ``selftest`` plants each of these and requires the report. Standard library only.

    python3 tests/tools/ratchet.py check worker-core \
        --istanbul worker/coverage/coverage-final.json --conditions worker/coverage/mcdc.json \
        [--forced worker/coverage/force.json] [--mutants worker/coverage/mutation.json] \
        [--only src/bot.ts,src/keys.ts]
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
import tomllib
from collections import Counter
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
REASONS = ("unreachable", "equivalent", "boundary", "tool")
KINDS = ("line", "branch", "function", "condition", "forced", "mutant")
#: What there is of each kind in each file, as one report counts it.
Counts = Counter[tuple[str, str]]
SOURCES = (".ts", ".mjs", ".js", ".py")
#: Where a pragma may not be, and what one looks like. Spelled in two halves: this file is read too.
PRAGMA_PLACES = ("worker/src", "worker/scripts", "worker/test", "scripts", "tests")
PRAGMA = re.compile(
    "|".join(
        a + b
        for a, b in (
            ("istanbul", r"\s+ignore"),
            ("v8", r"\s+ignore"),
            ("c8", r"\s+ignore"),
            ("node:", r"coverage\s+(?:ignore|disable)"),
            ("Stryker", r"\s+(?:disable|restore)"),
            ("pragma:", r"\s*no\s+(?:cover|branch|mutate)"),
            ("LCOV_", "EXCL"),
            ("NO", "SONAR"),
        )
    )
)


@dataclass(frozen=True)
class Miss:
    """What a tool says is missed: ``text`` is the source itself, never a line number, and ``on``
    the line or the decision around it when it is only part of one."""

    kind: str
    file: str
    function: str
    text: str
    on: str = ""
    operator: str = ""
    replacement: str = ""

    def __str__(self) -> str:
        around = f" on: {self.on}" if self.on else ""
        change = f" [{self.operator}: {self.replacement}]" if self.operator else ""
        return f"{self.kind} in {self.file}, {self.function}: {self.text}{around}{change}"

    def gone(self) -> bool:
        source = squeeze((ROOT / self.file).read_text())
        return self.text not in source or self.on not in source


def squeeze(text: str) -> str:
    """One space for any run of white space, so a change of layout moves no entry."""
    return " ".join(text.split())


def function_at(lines: list[str], line: int) -> str:
    """The name of the function, method or top-level declaration that holds a line (from 1)."""
    name = re.compile(
        r"^(?:export )?(?:default )?(?:async )?(?:function|class|const|let|def) (\w+)"
        r"|^  (?:(?:private|readonly|static|async|get) )*(\w+)(?:<[^>]*>)?\(.*\{$"
    )
    for at in range(line - 1, -1, -1):
        if m := name.match(lines[at]):
            return m[1] or m[2]
    return "(module)"


def relative(path: str) -> str:
    """A report's path as the repository has it: the tools give absolute or worker-relative ones."""
    p = Path(path)
    if p.is_absolute():
        return p.resolve().relative_to(ROOT).as_posix()
    return path if path.startswith(("worker/", "scripts/")) else f"worker/{path}"


def istanbul(report: Path) -> Iterator[Miss]:
    """Uncovered statements (by line), branches and functions of Istanbul's coverage-final.json."""
    for path, coverage in json.loads(report.read_text()).items():
        yield from istanbul_file(relative(path), coverage)


def istanbul_file(file: str, c: dict[str, Any]) -> Iterator[Miss]:
    lines = (ROOT / file).read_text().splitlines()

    def missed(kind: str, line: int, operator: str = "") -> Miss:
        return Miss(kind, file, function_at(lines, line), squeeze(lines[line - 1]), "", operator)

    uncovered = {c["statementMap"][k]["start"]["line"] for k, n in c["s"].items() if n == 0}
    for line in sorted(uncovered):
        yield missed("line", line)
    for k, hits in c["b"].items():
        b = c["branchMap"][k]
        for i, n in enumerate(hits):
            if n == 0:
                yield missed("branch", b["loc"]["start"]["line"], f"{b['type']} {i}")
    for k, n in c["f"].items():
        if n == 0:
            yield missed("function", c["fnMap"][k]["decl"]["start"]["line"])


def listed_misses(report: Path) -> Iterator[Miss]:
    """The misses of a report of our own tools (mcdc.mjs, force.mjs, mcdc.py): already named."""
    for m in json.loads(report.read_text())["misses"]:
        yield Miss(
            m["kind"],
            m["file"],
            m["function"],
            squeeze(m["text"]),
            squeeze(m.get("on", "")),
            m.get("operator", ""),
        )


def stryker(report: Path) -> Iterator[Miss]:
    """The mutants of a StrykerJS report no test killed, the ignored ones among them."""
    for path, f in json.loads(report.read_text())["files"].items():
        lines = f["source"].splitlines()
        for m in f["mutants"]:
            if m["status"] in ("Killed", "Timeout"):
                continue
            start, end = m["location"]["start"], m["location"]["end"]
            span = lines[start["line"] - 1 : end["line"]]
            span[-1] = span[-1][: end["column"] - 1]
            span[0] = span[0][start["column"] - 1 :]
            on = squeeze(lines[start["line"] - 1])
            text = squeeze("\n".join(span))
            yield Miss(
                "mutant",
                relative(path),
                function_at(lines, start["line"]),
                text,
                "" if text == on else on,
                m["mutatorName"],
                squeeze(m.get("replacement", "")),
            )


def istanbul_counts(report: Any) -> Iterator[tuple[str, str, int]]:
    for path, c in report.items():
        file = relative(path)
        yield "line", file, len({s["start"]["line"] for s in c["statementMap"].values()})
        yield "branch", file, sum(len(hits) for hits in c["b"].values())
        yield "function", file, len(c["f"])


def condition_counts(report: Any) -> Iterator[tuple[str, str, int]]:
    for path, t in report["totals"].items():
        yield "condition", relative(path), t["conditions"]


def forced_counts(report: Any) -> Iterator[tuple[str, str, int]]:
    for path, n in report["totals"].items():
        yield "forced", relative(path), n


def stryker_counts(report: Any) -> Iterator[tuple[str, str, int]]:
    for path, f in report["files"].items():
        yield "mutant", relative(path), len(f["mutants"])


def load(path: Path) -> dict[str, Any]:
    return tomllib.loads(path.read_text()) if path.is_file() else {}


def exclusions(path: Path) -> tuple[Counter[Miss], list[str]]:
    """The listed misses and what is wrong with the list itself."""
    entries: Counter[Miss] = Counter()
    problems = []
    for e in load(path).get("entry", []):
        m = Miss(
            e.get("kind", ""),
            e.get("file", ""),
            e.get("function", ""),
            squeeze(e.get("text", "")),
            squeeze(e.get("on", "")),
            e.get("operator", ""),
            squeeze(e.get("replacement", "")),
        )
        if m.kind not in KINDS:
            problems.append(f"{path.name}: not a kind of miss: {m}")
        if e.get("reason") not in REASONS or not str(e.get("why", "")).strip():
            problems.append(f"{path.name}: no reason of {', '.join(REASONS)}, or no why: {m}")
        if e.get("reason") in ("boundary", "tool") and not str(e.get("test", "")).strip():
            problems.append(f"{path.name}: no test that covers it at another level: {m}")
        entries[m] += int(e.get("count", 1))
    return entries, problems


def compare(
    found: Counter[Miss],
    entries: Counter[Miss],
    measured: dict[str, set[str]],
    files: set[str],
    floors: dict[str, int],
) -> list[str]:
    """What the gate says about the misses of the area's files.

    ``measured`` is the files each kind was measured in: a shard's entries are judged by its shard,
    and a count is held to its floor only where every file of the area was measured."""
    problems = []
    for m, n in sorted(found.items(), key=lambda x: str(x[0])):
        if n > entries[m]:
            problems.append(f"missed and not listed ({n - entries[m]}): {m}")
    for m, n in sorted(entries.items(), key=lambda x: str(x[0])):
        if m.file not in files:
            problems.append(f"listed for a file that is not of this area: {m}")
        elif m.gone():
            problems.append(f"listed, and its text is gone: {m}")
        elif m.file in measured.get(m.kind, set()) and n > found[m]:
            problems.append(f"listed and no longer missed ({n - found[m]}): {m}")
    totals = {
        k: sum(n for m, n in found.items() if m.kind == k)
        for k, where in measured.items()
        if where >= files
    }
    totals["exclusions"] = entries.total()
    for k, n in sorted(totals.items()):
        floor = floors.get(k)
        if floor is None:
            problems.append(f"no floor for {k}: it is {n}")
        elif n > floor:
            problems.append(f"{k}: {n} missed, {floor} at most")
        elif n < floor:
            problems.append(f"{k}: {n} missed, below its floor of {floor}: lower the floor")
    return problems


def whole(
    counts: Counts, about: dict[str, set[str]], floors: dict[str, dict[str, int]]
) -> list[str]:
    """Where a report did not measure what there is: nothing missed of nothing is no pass."""
    problems = []
    for kind, files in sorted(about.items()):
        for file in sorted(files):
            n, floor = counts[kind, file], floors.get(file, {}).get(kind)
            if n == 0:
                problems.append(f"{kind}: nothing measured in {file}")
            elif floor is None:
                problems.append(f"{kind}: no number of {file} in [measured]: it is {n}")
            elif n != floor:
                problems.append(f"{kind}: {n} measured in {file}, and [measured] says {floor}")
    return problems


def only(files: set[str], asked: str | None) -> tuple[set[str], list[str]]:
    """The files of the area a run was to measure, all of them when it does not say."""
    if asked is None:
        return files, []
    named = {relative(f) for f in asked.split(",") if f}
    problems = [f"not a file of this area: {f}" for f in sorted(named - files)]
    return named & files, problems or ([] if named else ["--only names no file"])


def check(area: str, args: argparse.Namespace) -> list[str]:
    floors = load(ROOT / "tests" / "floors" / f"{area}.toml")
    files = set(floors["files"])
    run, problems = only(files, args.only)
    found: Counter[Miss] = Counter()
    counts: Counts = Counter()
    measured: dict[str, set[str]] = {}
    for reports, kinds, read, count in (
        (args.istanbul, ("line", "branch", "function"), istanbul, istanbul_counts),
        (args.conditions, ("condition",), listed_misses, condition_counts),
        (args.forced, ("forced",), listed_misses, forced_counts),
        (args.mutants, ("mutant",), stryker, stryker_counts),
    ):
        for report in map(Path, reports or []):
            measured.update(dict.fromkeys(kinds, run))
            found.update(m for m in read(report) if m.file in run)
            for kind, file, n in count(json.loads(report.read_text())):
                counts[kind, file] += n
    if not measured:
        problems.append("no report was given")
    entries, wrong = exclusions(ROOT / "tests" / "exclusions" / f"{area}.toml")
    problems += wrong + whole(counts, measured, floors.get("measured", {}))
    return problems + compare(found, entries, measured, files, floors["misses"])


def shares(floors: dict[str, Any], n: int) -> list[list[str]]:
    """The area's files in n shares of about as many mutants each; every file is in one."""
    out: list[list[str]] = [[] for _ in range(n)]
    sizes = [0] * n
    mutants = {f: floors.get("measured", {}).get(f, {}).get("mutant", 0) for f in floors["files"]}
    for f in sorted(mutants, key=lambda f: (-mutants[f], f)):
        least = sizes.index(min(sizes))
        out[least].append(f)
        sizes[least] += mutants[f] or 1
    return [sorted(s) for s in out]


def said(new: dict[str, str], old: dict[str, str], *names: str) -> bool:
    """Whether one of the names has a line of its own, dated and with a reason, that is new."""
    return any(
        re.fullmatch(rf"{re.escape(name)} \d{{4}}-\d{{2}}-\d{{2}}", k) and str(why).strip()
        for k, why in new.items()
        if k not in old
        for name in names
    )


def raised(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """The floors of one area that went up with no line of their own in ``raised``."""
    lines = new.get("raised", {}), old.get("raised", {})
    return [
        f"{k} went from {n} to {new['misses'].get(k)} with no line in [raised]"
        for k, n in old.get("misses", {}).items()
        if new["misses"].get(k, 0) > n and not said(*lines, k)
    ]


def lowered(old: dict[str, Any], new: dict[str, Any]) -> list[str]:
    """What there was to miss in one area and is no more, with no line in ``lowered``."""
    lines = new.get("lowered", {}), old.get("lowered", {})
    problems = [
        f"{f} left the area with no line in [lowered]"
        for f in old.get("files", [])
        if f not in new["files"] and not said(*lines, f)
    ]
    for f, kinds in old.get("measured", {}).items():
        for k, n in kinds.items():
            now = new.get("measured", {}).get(f, {}).get(k, 0)
            if now < n and not said(*lines, f, f"{k} {f}"):
                problems.append(f"{k} of {f} went from {n} to {now} with no line in [lowered]")
    return problems


def git(*args: str) -> str:
    ran = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True)
    return ran.stdout


def against(base: str) -> list[str]:
    problems = []
    for name in git("ls-tree", "--name-only", base, "tests/floors/").splitlines():
        path = ROOT / name
        if not path.is_file():
            problems.append(f"{name} is gone")
            continue
        old, new = tomllib.loads(git("show", f"{base}:{name}")), load(path)
        problems += [f"{path.name}: {p}" for p in raised(old, new) + lowered(old, new)]
    return problems


def pragmas(places: list[Path]) -> list[str]:
    problems = []
    for place in places:
        for path in sorted(
            p for p in place.rglob("*") if p.suffix in (".ts", ".mjs", ".js", ".py")
        ):
            if "node_modules" in path.parts:
                continue
            for n, line in enumerate(path.read_text().splitlines(), 1):
                if PRAGMA.search(line):
                    problems.append(f"{path}:{n}: {line.strip()}")
    return problems


Case = tuple[str, list[str], list[str]]


def selftest_whole(file: str) -> list[Case]:
    """A measure that looked at less than there is."""
    floors = {file: {"line": 2, "mutant": 3}}
    lines, mutants = {"line": {file}}, {"mutant": {file}}
    area = {"files": [file, "x", "y"], "measured": {file: {"mutant": 9}, "x": {"mutant": 5}}}
    return [
        ("all there is", whole(Counter({("line", file): 2}), lines, floors), []),
        ("a report with nothing in it", whole(Counter(), mutants, floors), ["nothing measured"]),
        (
            "a file that is not in a report",
            whole(Counter({("line", "x"): 2}), lines, floors),
            [f"nothing measured in {file}"],
        ),
        (
            "a floor of nothing to measure",
            whole(Counter(), lines, {file: {"line": 0}}),
            ["nothing measured"],
        ),
        ("a line less", whole(Counter({("line", file): 1}), lines, floors), ["1 measured in"]),
        ("a line more", whole(Counter({("line", file): 3}), lines, floors), ["3 measured in"]),
        (
            "a file with no number",
            whole(Counter({("line", file): 2}), lines, {}),
            ["no number of"],
        ),
        ("a run of the whole area", [*only({file, "x"}, None)[0]], [file, "x"]),
        ("a run of one file", [*only({file, "worker/x"}, "x,")[0]], ["worker/x"]),
        ("a run of one file, all of it", only({file, "worker/x"}, "x")[1], []),
        ("a run of no file", only({file}, "")[1], ["names no file"]),
        ("a run of a file of another area", only({file}, "x")[1], ["not a file of this area"]),
        ("two shares of three files", [f"{shares(area, 2)}"], [f"{[[file], ['x', 'y']]}"]),
    ]


def selftest_lowered(file: str) -> list[Case]:
    """What there was to miss, and is no more."""
    old = {"files": [file], "measured": {file: {"line": 2}}}

    def new(n: int, *lines: str, why: str = "why") -> dict[str, Any]:
        return old | {"measured": {file: {"line": n}}, "lowered": dict.fromkeys(lines, why)}

    gone: dict[str, Any] = {"files": []}
    return [
        ("a line more to miss", lowered(old, new(3)), []),
        ("a line less to miss", lowered(old, new(1)), ["went from 2 to 1"]),
        ("a file that is not measured now", lowered(old, {"files": [file]}), ["from 2 to 0"]),
        ("a line less, and said so", lowered(old, new(1, f"line {file} 2026-01-01")), []),
        ("a line less, and said of the file", lowered(old, new(1, f"{file} 2026-01-01")), []),
        ("a line less, with no date", lowered(old, new(1, f"line {file} x")), ["from 2"]),
        ("of another kind", lowered(old, new(1, f"branch {file} 2026-01-01")), ["from 2"]),
        ("with no reason", lowered(old, new(1, f"{file} 2026-01-01", why=" ")), ["from 2"]),
        (
            "an old line for a new fall",
            lowered(new(2, f"{file} 2026-01-01"), new(1, f"{file} 2026-01-01")),
            ["from 2"],
        ),
        ("a file that left the area", lowered(old, gone), ["left the area"]),
        (
            "a file that left the area, and said so",
            lowered(old, gone | {"lowered": {f"{file} 2026-01-01": "why"}}),
            [],
        ),
    ]


def selftest_reports(tmp: Path) -> list[Case]:
    """The reports of each tool, with nothing in them and with one file of nothing."""
    empty = {
        "istanbul": ({}, {"worker/src/env.ts": {"statementMap": {}, "s": {}, "b": {}, "f": {}}}),
        "conditions": (
            {"totals": {}, "misses": []},
            {"totals": {"src/env.ts": {"conditions": 0, "covered": 0}}, "misses": []},
        ),
        "forced": (
            {"totals": {}, "misses": []},
            {"totals": {"src/env.ts": 0}, "misses": []},
        ),
        "mutants": (
            {"files": {}},
            {"files": {"src/env.ts": {"source": "", "mutants": []}}},
        ),
    }
    cases: list[Case] = []
    for name, reports in empty.items():
        for i, report in enumerate(reports):
            path = tmp / f"{name}-{i}.json"
            path.write_text(json.dumps(report))
            none: dict[str, Any] = dict.fromkeys(empty)
            args = argparse.Namespace(**(none | {name: [str(path)], "only": "src/env.ts"}))
            kinds = {"conditions": ["condition"], "forced": ["forced"], "mutants": ["mutant"]}
            wanted = [
                f"{k}: nothing measured in worker/src/env.ts"
                for k in kinds.get(name, ["line", "branch", "function"])
            ]
            found = [p for p in check("worker-core", args) if "nothing measured" in p]
            cases.append((f"{name} of nothing ({i})", found, wanted))
    args = argparse.Namespace(**(dict.fromkeys(empty) | {"only": None}))
    start = [{"start": {"line": n}} for n in (4, 4, 9)]
    counted = istanbul_counts(
        {
            "src/env.ts": {
                "statementMap": dict(enumerate(start)),
                "b": {"0": [1, 0], "1": [0]},
                "f": {"0": 1, "1": 0, "2": 0, "3": 0},
            }
        }
    )
    cases.append(
        (
            "lines, branches and functions",
            [f"{[n for _, _, n in counted]}"],
            ["[2, 3, 4]"],
        )
    )
    cases.append(("no report at all", check("worker-core", args), ["no report was given"]))
    return cases


def selftest() -> list[str]:
    """Plants each thing the gate must see, and says which one it did not."""
    file = "tests/tools/ratchet.py"
    miss = Miss("condition", file, "selftest", "nowhere" + "-to-be-found")
    here = Miss("mutant", file, "selftest", "def selftest() -> list[str]:", "", "Op", "x")
    none: Counter[Miss] = Counter()
    zero = {"condition": 0, "mutant": 0, "exclusions": 0}
    one = {"condition": 1, "mutant": 1, "exclusions": 1}
    kinds = {"condition": {file}}
    mutants = {"mutant": {file}}
    cases = [
        ("a clean area passes", compare(none, none, kinds, {file}, zero), []),
        ("a planted condition", compare(Counter([miss]), none, kinds, {file}, one), ["not listed"]),
        (
            "a count over its floor",
            compare(Counter([miss]), none, kinds, {file}, zero),
            ["at most"],
        ),
        ("a count under its floor", compare(none, none, kinds, {file}, one), ["lower the floor"]),
        ("a measure with no floor", compare(none, none, kinds, {file}, {}), ["no floor"]),
        (
            "an entry now killed",
            compare(none, Counter([here]), mutants, {file}, one),
            ["no longer missed"],
        ),
        (
            "an entry of a file that was not measured",
            compare(none, Counter([here]), {"mutant": {"x"}}, {file, "x"}, one),
            [],
        ),
        (
            "an entry whose text is gone",
            compare(Counter(), Counter([miss]), mutants, {file}, one),
            ["text is gone"],
        ),
        (
            "an entry of another area",
            compare(none, Counter([here]), kinds, {"x"}, one),
            ["not of this area"],
        ),
        (
            "a mutant twice, listed once",
            compare(Counter([here, here]), Counter([here]), mutants, {file}, one),
            ["not listed (1)"],
        ),
        ("a floor raised", raised({"misses": {"line": 0}}, {"misses": {"line": 1}}), ["went from"]),
        (
            "a floor raised and said so",
            raised(
                {"misses": {"line": 0}}, {"misses": {"line": 1}, "raised": {"line 2026-01-01": "x"}}
            ),
            [],
        ),
        (
            "a floor raised under an old line",
            raised(
                {"misses": {"line": 0}, "raised": {"line 2026-01-01": "x"}},
                {"misses": {"line": 1}, "raised": {"line 2026-01-01": "x"}},
            ),
            ["went from"],
        ),
        (
            "a floor raised under a line with no reason",
            raised(
                {"misses": {"line": 0}}, {"misses": {"line": 1}, "raised": {"line 2026-01-01": ""}}
            ),
            ["went from"],
        ),
        *selftest_whole(file),
        *selftest_lowered(file),
    ]
    with tempfile.TemporaryDirectory() as tmp:
        here_dir = Path(tmp)
        cases += selftest_reports(here_dir)
        planted_pragmas = ("istanbul" + " ignore next", "pragma:" + " no cover", "NO" + "SONAR")
        for i, text in enumerate(planted_pragmas):
            (here_dir / f"{i}.ts").write_text(f"x // {text}\n")
        cases.append(("three pragmas", [str(len(pragmas([here_dir])))], ["3"]))
        (here_dir / "list.toml").write_text(
            '[[entry]]\nkind = "idea"\n[[entry]]\nkind = "line"\nreason = "boundary"\nwhy = "x"\n'
        )
        said = exclusions(here_dir / "list.toml")[1]
        cases.append(("a kind, a reason, a test that are not there", [str(len(said))], ["3"]))
        (here_dir / "mutation.json").write_text(
            json.dumps(
                {
                    "files": {
                        "src/x.ts": {
                            "source": "function f() {\n  return a && b;\n}\n",
                            "mutants": [
                                {
                                    "status": s,
                                    "mutatorName": "Op",
                                    "replacement": "a",
                                    "location": {
                                        "start": {"line": 2, "column": 10},
                                        "end": {"line": 2, "column": 16},
                                    },
                                }
                                for s in ("Killed", "Timeout", "Survived", "NoCoverage", "Ignored")
                            ],
                        }
                    }
                }
            )
        )
        planted = [str(m) for m in stryker(here_dir / "mutation.json")]
        cases.append(("three mutants nobody killed", [str(len(planted))], ["3"]))
        cases.append(
            (
                "named by their source",
                planted[:1],
                ["mutant in worker/src/x.ts, f: a && b on: return a && b; [Op: a]"],
            )
        )
    problems = []
    for name, said, wanted in cases:
        if bool(said) != bool(wanted) or any(not any(w in s for s in said) for w in wanted):
            problems.append(f"{name}: wanted {wanted}, got {said}")
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    c = commands.add_parser("check", help="the area's reports against its floors and its list")
    c.add_argument("area")
    for report in ("istanbul", "conditions", "forced", "mutants"):
        c.add_argument(f"--{report}", nargs="+")
    c.add_argument("--only", help="the files of the run, with a comma between; all of them if not")
    f = commands.add_parser("files", help="the files of an area, with a comma between")
    f.add_argument("area")
    f.add_argument("--share", default="1/1", help="one of N shares of about as many mutants: I/N")
    b = commands.add_parser("base", help="the floors against another revision's")
    b.add_argument("revision")
    commands.add_parser("pragmas", help="no inline pragma in the sources")
    commands.add_parser("selftest", help="plants each problem and requires its report")
    args = parser.parse_args(argv)
    if args.command == "files":
        i, n = map(int, args.share.split("/"))
        area = load(ROOT / "tests" / "floors" / f"{args.area}.toml")
        print(",".join(f.removeprefix("worker/") for f in shares(area, n)[i - 1]))
        return 0
    if args.command == "check":
        problems = check(args.area, args)
    elif args.command == "base":
        problems = against(args.revision)
    elif args.command == "pragmas":
        problems = pragmas([ROOT / p for p in PRAGMA_PLACES])
    else:
        problems = selftest()
    for p in problems:
        print(p, file=sys.stderr)
    print(f"ratchet {args.command}: {'ok' if not problems else f'{len(problems)} problems'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
