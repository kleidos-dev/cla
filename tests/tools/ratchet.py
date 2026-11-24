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
area, or one of N even shares of them. ``areas`` fails on a source file that is in no area, or in
two: a file no area names is measured by nothing. ``listed`` fails on a mutant of a run of some
lines (a pull request's) that no test killed and the area's list does not excuse, which no floor
can hold. ``pragmas`` fails on an inline pragma that hides a miss from a tool. ``selftest`` plants
each of these and requires the report. Standard library only.

    python3 tests/tools/ratchet.py check worker-core \
        --istanbul worker/coverage/coverage-final.json --conditions worker/coverage/mcdc.json \
        [--forced worker/coverage/force.json] [--mutants worker/coverage/mutation.json] \
        [--only src/bot.ts,src/keys.ts]
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from collections import Counter
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
REASONS = ("unreachable", "equivalent", "boundary", "tool")
KINDS = ("line", "branch", "function", "condition", "forced", "mutant")
#: What there is of each kind in each file, as one report counts it.
Counts = Counter[tuple[str, str]]
#: What a source file is: any of these, a declaration file aside.
SOURCES = (".ts", ".mts", ".cts", ".mjs", ".cjs", ".js", ".py")
DECLARATION = re.compile(r"\.d\.[cm]?ts$")
#: Where a pragma may not be, and what one looks like. Spelled in two halves: this file is read too.
PRAGMA_PLACES = ("registry", "worker/src", "worker/scripts", "worker/test", "scripts", "tests")
#: The code the measures are for: every source file under these, at any depth, out of their test
#: folders, is in the files of exactly one area.
CODE = ("registry", "worker/src", "worker/scripts", "scripts")
NOT_CODE = ("registry/tests/", "scripts/test/")
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


def from_root(path: str) -> str:
    """A path of a test report from the root of the repository (the runners give absolute ones)."""
    p = Path(path)
    return p.resolve().relative_to(ROOT).as_posix() if p.is_absolute() else p.as_posix()


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


def exclusions(path: Path, kinds: tuple[str, ...] = KINDS) -> tuple[Counter[Miss], list[str]]:
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
        if m.kind not in kinds:
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
    problems = unlisted(found, entries)
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


#: What a test of each status of vitest's JSON reporter counts as.
VITEST = {
    "passed": "tests",
    "failed": "failed",
    "skipped": "skipped",
    "pending": "skipped",
    "disabled": "skipped",
    "todo": "todo",
}


def test_counts(report: Path) -> dict[str, Counter[str]]:
    """How many tests of each file ran, were skipped, left to do or failed: vitest's JSON report,
    or the report of tests/tools/node/count-reporter.mjs or tests/tools/py/count.py."""
    data = json.loads(report.read_text())
    out: dict[str, Counter[str]] = {}
    if "testResults" in data:
        for f in data["testResults"]:
            c = out.setdefault(from_root(f["name"]), Counter(tests=0))
            for t in f["assertionResults"]:
                kind = VITEST.get(t["status"], "failed")
                c[kind] += 1
                c["tests"] += kind == "failed"
            if f.get("status") == "failed" and not f["assertionResults"]:
                c["failed"] += 1  # a file that did not load runs none
        return out
    for file, counts in data["files"].items():
        out[from_root(file)] = Counter(counts)
    return out


def held_tests(floors: dict[str, Any], counts: dict[str, Counter[str]]) -> list[str]:
    """Every file of the suite ran the tests [tests] says, no more and no fewer, and none was
    skipped or left to do: a test that does not run checks nothing, and passes."""
    held: dict[str, int] = floors.get("tests", {})
    problems = [] if counts else ["no test ran: the report holds no test file"]
    for file, c in sorted(counts.items()):
        problems += [
            f"{c[kind]} {kind} in {file}: a test runs, or it is deleted"
            for kind in ("skipped", "todo")
            if c[kind]
        ]
        if c["failed"]:
            problems.append(f"{c['failed']} failed in {file}")
        if file not in held:
            problems.append(f"{c['tests']} tests ran in {file}, which [tests] does not name")
        elif c["tests"] != held[file]:
            problems.append(f"{c['tests']} tests ran in {file}, and [tests] says {held[file]}")
    problems += [
        f"no test ran in {f}, and [tests] says {n}" for f, n in held.items() if f not in counts
    ]
    return problems


def suite(name: str, reports: list[str]) -> list[str]:
    """The tests of a suite against its floors; and, for a suite that has a list and no files (its
    misses are its own, not the ratchet's), the list against its floor."""
    floors = load(ROOT / "tests" / "floors" / f"{name}.toml")
    if not floors:
        return [f"tests/floors/{name}.toml is missing"]
    counts: dict[str, Counter[str]] = {}
    for report in map(Path, reports):
        for file, c in test_counts(report).items():
            counts[file] = counts.get(file, Counter()) + c
    problems = held_tests(floors, counts)
    floor = floors.get("misses", {}).get("exclusions")
    if not floors.get("files") and floor is not None:
        kinds = tuple(floors.get("kinds", KINDS))
        entries, wrong = exclusions(ROOT / "tests" / "exclusions" / f"{name}.toml", kinds)
        problems += wrong
        if entries.total() > floor:
            problems.append(f"exclusions: {entries.total()} listed, {floor} at most")
        elif entries.total() < floor:
            problems.append(f"exclusions: {entries.total()} listed, below its floor of {floor}")
    return problems


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
        if f not in new.get("files", []) and not said(*lines, f)
    ]
    for f, kinds in old.get("measured", {}).items():
        for k, n in kinds.items():
            now = new.get("measured", {}).get(f, {}).get(k, 0)
            if now < n and not said(*lines, f, f"{k} {f}"):
                problems.append(f"{k} of {f} went from {n} to {now} with no line in [lowered]")
    for f, n in old.get("tests", {}).items():
        now = new.get("tests", {}).get(f, 0)
        if now < n and not said(*lines, f"tests {f}"):
            problems.append(f"the tests of {f} went from {n} to {now} with no line in [lowered]")
    return problems


def code_files(root: Path) -> set[str]:
    """Every source file under the roots of CODE, at any depth, out of the test folders."""
    found = set()
    for base in CODE:
        for p in (root / base).rglob("*"):
            name = p.relative_to(root).as_posix()
            skipped = {"node_modules", "__pycache__"} & set(p.parts) or name.startswith(NOT_CODE)
            if p.is_file() and p.suffix in SOURCES and not DECLARATION.search(name) and not skipped:
                found.add(name)
    return found


def area_files(root: Path) -> dict[str, list[str]]:
    """The files each floors file names, by its name (a suite of tests alone names none)."""
    return {
        path.stem: load(path).get("files", [])
        for path in sorted((root / "tests" / "floors").glob("*.toml"))
    }


def areas(root: Path) -> list[str]:
    """A source file in no area is measured by nothing, one in two is counted twice, and one that a
    tool of its area cannot reach is measured by the others alone."""
    return placed(root) + out_of_reach(root, area_files(root))


def placed(root: Path) -> list[str]:
    """Every source file in exactly one area, and every file of an area a source file."""
    code = code_files(root)
    held: dict[str, list[str]] = {}
    for area, files in area_files(root).items():
        for file in files:
            held.setdefault(file, []).append(area)
    problems = []
    for file in sorted(code | set(held)):
        where = ", ".join(held.get(file, []))
        if file not in code:
            problems.append(f"{file} is in {where} and is no source file")
        elif not where:
            problems.append(f"{file} is in no area: name it in tests/floors/<area>.toml")
        elif len(held[file]) > 1:
            problems.append(f"{file} is in {len(held[file])} areas: {where}")
    return problems


def glob_match(pattern: str, path: str) -> bool:
    """A glob as coverage.py, Node and StrykerJS read one: ``**`` crosses folders, ``*`` and ``?``
    stay inside one."""
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        else:
            out += {"*": "[^/]*", "?": "[^/]"}.get(pattern[i], re.escape(pattern[i]))
            i += 1
    return re.fullmatch(out, path) is not None


#: What one tool measures of a list of files.
Reach = Callable[[list[str]], set[str]]


def by_globs(includes: list[str], excludes: list[str] | None = None, base: str = "") -> Reach:
    """The files under ``base`` that an include matches and no exclude does, from ``base``."""

    def reach(files: list[str]) -> set[str]:
        def matched(f: str, globs: list[str]) -> bool:
            return any(glob_match(g, f.removeprefix(base)) for g in globs)

        under = [f for f in files if f.startswith(base)]
        return {f for f in under if matched(f, includes) and not matched(f, excludes or [])}

    return reach


def named(names: set[str]) -> Reach:
    return lambda files: set(files) & names


def under(roots: list[str]) -> Reach:
    return lambda files: {f for f in files for r in roots if f == r or f.startswith(f"{r}/")}


def strings(text: str) -> list[str]:
    return re.findall(r'"([^"]+)"', text)


def found(pattern: str, text: str) -> str:
    """The first group of a pattern of a tool's configuration, or nothing: a tool configured in a
    way this file cannot read reaches no file, and says so."""
    m = re.search(pattern, text, re.DOTALL)
    return m[1] if m else ""


def worker_sources(root: Path) -> Reach:
    """worker/test/tools/sources.mjs's own isSource, which mcdc.mjs and changed.mjs use."""
    url = (root / "worker" / "test" / "tools" / "sources.mjs").as_uri()
    code = (
        f"const {{ isSource }} = await import({json.dumps(url)});"
        "console.log(JSON.stringify(process.argv.slice(1).filter((f) => isSource(f))));"
    )

    def reach(files: list[str]) -> set[str]:
        rel = [f.removeprefix("worker/") for f in files if f.startswith("worker/")]
        ran = subprocess.run(
            ["node", "--input-type=module", "-e", code, *rel],
            capture_output=True,
            text=True,
            check=False,
        )
        return {f"worker/{f}" for f in json.loads(ran.stdout)} if ran.returncode == 0 else set()

    return reach


def tools(root: Path) -> dict[str, list[tuple[str, Reach]]]:
    """Each tool of each kind of area, with what it is configured to reach (relative paths)."""

    def text(name: str) -> str:
        return (root / name).read_text() if (root / name).is_file() else ""

    ci, weekly = text(".github/workflows/ci.yml"), text(".github/workflows/mutation.yml")
    sonar = under(
        found(r"(?m)^sonar\.sources=([^\n]*)$", text("sonar-project.properties")).split(",")
    )
    pyproject = tomllib.loads(text("pyproject.toml") or "")
    stryker = json.loads(text("worker/stryker.config.json") or "{}").get("mutate", [])
    vitest = found(r"coverage:\s*\{.*?include:\s*\[([^\]]*)\]", text("worker/vitest.config.ts"))
    scripts = json.loads(text("worker/package.json") or "{}").get("scripts", {})

    def node_coverage(command: str) -> Reach:
        return by_globs(
            re.findall(r"--test-coverage-include='([^']+)'", command),
            re.findall(r"--test-coverage-exclude='([^']+)'", command),
        )

    def mutated(workflow: str) -> Reach:
        return named(set(re.findall(r"mutate\.py\s+(\S+)\s+registry/tests", workflow)))

    test_tools = text("registry/tests/test_tools.py")
    return {
        "register": [
            (
                "coverage.py (pyproject.toml)",
                by_globs(
                    pyproject.get("tool", {}).get("coverage", {}).get("run", {}).get("include", [])
                ),
            ),
            (
                "mcdc.py (test_tools.Measured)",
                named(set(re.findall(r'"mcdc\.py"\),\s*"([^"]+)"', test_tools))),
            ),
            ("mutate.py (ci.yml)", mutated(ci)),
            ("mutate.py (mutation.yml)", mutated(weekly)),
            ("SonarCloud (sonar.sources)", sonar),
        ],
        "worker": [
            ("Istanbul (vitest.config.ts)", by_globs(strings(vitest), base="worker/")),
            (
                "StrykerJS (stryker.config.json)",
                by_globs(
                    [g for g in stryker if not g.startswith("!")],
                    [g[1:] for g in stryker if g.startswith("!")],
                    base="worker/",
                ),
            ),
            ("mcdc.mjs and changed.mjs (sources.mjs)", worker_sources(root)),
            ("SonarCloud (sonar.sources)", sonar),
        ],
        "scripts": [
            ("node --test (ci.yml)", node_coverage(ci)),
            ("node --test (npm run test:scripts)", node_coverage(scripts.get("test:scripts", ""))),
            (
                "scripts-mcdc.mjs (MEASURED of mcdc-hook.mjs)",
                named(
                    set(
                        strings(
                            found(
                                r"MEASURED = \[([^\]]*)\]", text("tests/tools/node/mcdc-hook.mjs")
                            )
                        )
                    )
                ),
            ),
            (
                "scripts-mut.mjs (TESTS)",
                named(
                    set(
                        re.findall(
                            r'"([^"]+)":\s*\[',
                            found(
                                r"TESTS = \{(.*?)\n\};", text("tests/tools/node/scripts-mut.mjs")
                            ),
                        )
                    )
                ),
            ),
            ("SonarCloud (sonar.sources)", sonar),
        ],
    }


def out_of_reach(root: Path, files_of: dict[str, list[str]]) -> list[str]:
    """The files of an area that one of its tools does not reach, which that tool never measures."""
    known = tools(root)
    problems = []
    for area, files in sorted(files_of.items()):
        if not files:
            continue
        kind = "worker" if area.startswith("worker-") else area
        if kind not in known:
            problems.append(f"{area}: no tool is known to measure this area")
            continue
        for name, reach in known[kind]:
            took = reach(files)
            problems += [
                f"{f} ({area}) is out of the reach of {name}" for f in files if f not in took
            ]
    return problems


def unlisted(found: Counter[Miss], entries: Counter[Miss]) -> list[str]:
    """The misses of a run of some lines that the list does not excuse."""
    return [
        f"missed and not listed ({n - entries[m]}): {m}"
        for m, n in sorted(found.items(), key=lambda x: str(x[0]))
        if n > entries[m]
    ]


def listed(area: str, reports: list[str]) -> list[str]:
    files = set(load(ROOT / "tests" / "floors" / f"{area}.toml")["files"])
    found = Counter(m for report in reports for m in stryker(Path(report)) if m.file in files)
    entries, wrong = exclusions(ROOT / "tests" / "exclusions" / f"{area}.toml")
    return wrong + unlisted(found, entries)


def git(*args: str) -> str:
    ran = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True)
    return ran.stdout


#: The numeric thresholds that hold a measure at 100, in the files that set them: a pull request may
#: not lower one, with or without a line, since it is the pull request's own text.
THRESHOLDS = (
    ("worker/vitest.config.ts", r"thresholds:\s*\{([^}]*)\}", r"(\w+):\s*(\d+)"),
    (
        "pyproject.toml",
        r"(?m)^(\[tool\.coverage\.report\][^\[]*)",
        r"(?m)^(fail_under)\s*=\s*(\d+)",
    ),
    (".github/workflows/ci.yml", r"(.*)", r"--test-coverage-(\w+)=(\d+)"),
    ("worker/package.json", r"(.*)", r"--test-coverage-(\w+)=(\d+)"),
)


def thresholds(read: Callable[[str], str]) -> dict[str, int]:
    """Every threshold, by file and name (``ci.yml lines``), at the lowest value the file gives it:
    a second flag that says less is what a run would use."""
    out: dict[str, int] = {}
    for file, block, pair in THRESHOLDS:
        for m in re.finditer(pair, found(block, read(file))):
            key = f"{file} {m[1]}"
            out[key] = min(out.get(key, int(m[2])), int(m[2]))
    return out


def thresholds_lowered(old: dict[str, int], new: dict[str, int]) -> list[str]:
    return [
        f"the threshold {k} went from {n} to {new[k]}" if k in new else f"the threshold {k} is gone"
        for k, n in sorted(old.items())
        if new.get(k, -1) < n
    ]


def at(base: str) -> Callable[[str], str]:
    """A file as a revision has it, empty when it has none."""

    def read(name: str) -> str:
        ran = subprocess.run(
            ["git", "show", f"{base}:{name}"], cwd=ROOT, capture_output=True, text=True, check=False
        )
        return ran.stdout if ran.returncode == 0 else ""

    return read


def in_tree(root: Path) -> Callable[[str], str]:
    """A file as a working tree has it, empty when it has none."""
    return lambda name: (root / name).read_text() if (root / name).is_file() else ""


here = in_tree(ROOT)


def against(base: str) -> list[str]:
    problems = []
    for name in git("ls-tree", "--name-only", base, "tests/floors/").splitlines():
        path = ROOT / name
        if not path.is_file():
            problems.append(f"{name} is gone")
            continue
        old, new = tomllib.loads(git("show", f"{base}:{name}")), load(path)
        problems += [f"{path.name}: {p}" for p in raised(old, new) + lowered(old, new)]
    if not thresholds(here):
        problems.append("no threshold found: THRESHOLDS no longer reads the files that set them")
    return problems + thresholds_lowered(thresholds(at(base)), thresholds(here))


def bare(floors: dict[str, Any]) -> dict[str, Any]:
    """A floors file without its lines: what moved, whatever a line says of it."""
    return {k: v for k, v in floors.items() if k not in ("raised", "lowered")}


def moved(read: Callable[[str], str], root: Path = ROOT) -> list[str]:
    """Everything that moved the wrong way since a revision, with its line or without: a floor
    raised, a number of what there is to measure or of tests lowered, a file out of an area, an
    entry added to a list, a threshold lowered. ``base`` fails on what has no line; this names
    what does, so that an accepted fall is a check a maintainer clears on purpose, never a quiet
    green."""
    out = []
    for path in sorted((root / "tests" / "floors").glob("*.toml")):
        name = path.relative_to(root).as_posix()
        old, new = tomllib.loads(read(name) or ""), load(path)
        out += [
            f"{path.name}: {p}"
            for p in raised(bare(old), bare(new)) + lowered(bare(old), bare(new))
        ]
        for table in ("raised", "lowered"):
            for k, why in new.get(table, {}).items():
                if k not in old.get(table, {}):
                    out.append(f"{path.name}: a new line in [{table}]: {k} = {why!r}")
    for path in sorted((root / "tests" / "exclusions").glob("*.toml")):
        name = path.relative_to(root).as_posix()
        was = tomllib.loads(read(name) or "").get("entry", [])
        out += [
            f"{path.name}: a new entry: {e.get('kind')} in {e.get('file')}, {e.get('function')}: "
            f"{e.get('text')} ({e.get('reason')}: {squeeze(str(e.get('why', '')))})"
            for e in load(path).get("entry", [])
            if e not in was
        ]
    return out + thresholds_lowered(thresholds(read), thresholds(in_tree(root)))


#: Where a test may not be skipped, left to do or expected to fail, and what that looks like in each
#: language. Spelled in parts: this file is read too.
SKIP_PLACES = ("registry/tests", "scripts/test", "worker/test", "tests/workflows", "tests/pages")
SKIPS = {
    ".py": re.compile(
        r"\bunittest\.skip|\bskip(?:If|Unless)?\s*\(|\bSkip" + r"Test\b|\bexpected" + r"Failure\b"
        r"|\.skip" + r"Test\s*\("
    ),
    ".js": re.compile(
        r"\b(?:describe|it|test|suite|bench)\s*\.\s*(?:sk"
        + r"ip|to"
        + r"do|skipIf|runIf|only|fails)\b"
        r"|\.\s*(?:sk" + r"ip|to" + r"do)\s*\(|[{,]\s*(?:sk" + r"ip|to" + r"do)\s*:"
    ),
}
#: The one skip there is, and how many times: the tool tests of the register stand aside inside a
#: mutation campaign, which runs the whole suite once more on each mutant and sets REGISTER_MEASURED
#: (tests/tools/py/mutate.py); every other run has them, and a skipped test fails ``tests``.
SKIP_ALLOWED = {
    (
        "registry/tests/test_tools.py",
        "@unittest.skip" + 'If(MEASURED, "this is the measure itself")',
    ): 4,
}


def skips(root: Path, allowed: dict[tuple[str, str], int]) -> list[str]:
    """Every test that is skipped, left to do or expected to fail in the test trees, but the allowed
    ones: such a test checks nothing, and its suite still passes."""
    problems = []
    seen: Counter[tuple[str, str]] = Counter()
    for place in SKIP_PLACES:
        for path in sorted((root / place).rglob("*")):
            pattern = SKIPS[".py"] if path.suffix == ".py" else SKIPS[".js"]
            if path.suffix not in SOURCES or "node_modules" in path.parts:
                continue
            name = path.relative_to(root).as_posix()
            for n, line in enumerate(path.read_text().splitlines(), 1):
                if not pattern.search(line):
                    continue
                if (name, line.strip()) in allowed:
                    seen[name, line.strip()] += 1
                else:
                    problems.append(f"{name}:{n}: a test that does not run: {line.strip()}")
    for (name, line), n in sorted(allowed.items()):
        if seen[name, line] != n:
            problems.append(f"{name}: the allowed skip is there {seen[name, line]} times, not {n}")
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


def selftest_areas(root: Path) -> list[Case]:
    """Source files in no area, in two, at any depth, and an area that names a file that is no
    source; then the files of an area that one of its tools, as configured here, cannot reach."""
    planted = [
        "registry/rules.py",
        "registry/extra/more.py",
        "scripts/new-tool.mjs",
        "scripts/lib/x.ts",
        "worker/scripts/sub/y.mjs",
        "worker/src/rules/z.ts",
    ]
    not_code = ["registry/tests/t.py", "scripts/test/t.ts", "worker/src/m.d.ts", "worker/src/a.css"]
    every = ["registry/cla.py", "worker/src/a.ts", "worker/src/b.ts"]
    for name in [*every, *planted, *not_code, "worker/src/node_modules/m/i.js"]:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("x\n")
    (root / "tests" / "floors").mkdir(parents=True)

    def floors(**area: list[str]) -> list[str]:
        for old in (root / "tests" / "floors").glob("*.toml"):
            old.unlink()
        for name, files in area.items():
            floor = root / "tests" / "floors" / f"{name}.toml"
            floor.write_text(f"files = {json.dumps(files)}\n")
        return placed(root)

    def reach(area: str, *files: str) -> list[str]:
        return out_of_reach(ROOT, {area: list(files)})

    def tools_of(kind: str) -> list[str]:
        return [name for name, _ in tools(ROOT)[kind]]

    return [
        ("every source in one area", floors(one=[*every[:1], *planted], two=every[1:]), []),
        ("a source in no area", floors(one=[*every[:2], *planted]), ["worker/src/b.ts is in no"]),
        *(
            (
                f"a source at {f} in no area",
                floors(one=[p for p in [*every, *planted] if p != f]),
                [f"{f} is in no area"],
            )
            for f in planted
        ),
        ("a source in two", floors(one=[*every, *planted], two=every[1:2]), ["a.ts is in 2 areas"]),
        (
            "an area of a file that is no source",
            floors(one=[*every, *planted, "worker/src/m.d.ts"]),
            ["m.d.ts is in one and is no source file"],
        ),
        ("every file of every area here in reach", areas(ROOT), []),
        ("a Worker file in a folder of src/", reach("worker-core", "worker/src/rules/z.ts"), []),
        (
            "a second module of the register",
            reach("register", "registry/cla.py", "registry/rules.py"),
            [
                f"registry/rules.py (register) is out of the reach of {t}"
                for t in tools_of("register")
            ],
        ),
        (
            "a script in a folder of scripts/",
            reach("scripts", "scripts/lib/x.ts"),
            [f"scripts/lib/x.ts (scripts) is out of the reach of {t}" for t in tools_of("scripts")],
        ),
        (
            "a script that is no TypeScript",
            reach("scripts", "scripts/new-tool.mjs"),
            ["scripts/new-tool.mjs (scripts) is out of the reach of node --test (ci.yml)"],
        ),
        (
            "a Worker file that is no TypeScript",
            reach("worker-edge", "worker/src/x.mjs"),
            [
                f"worker/src/x.mjs (worker-edge) is out of the reach of {t}"
                for t in tools_of("worker")[:3]
            ],
        ),
        ("an area no tool measures", reach("other", "x.ts"), ["other: no tool is known"]),
        (
            "globs as the tools read them",
            [
                str(
                    [
                        glob_match(g, f)
                        for g, f in (
                            ("src/**/*.ts", "src/a.ts"),
                            ("src/**/*.ts", "src/r/s/a.ts"),
                            ("src/*.ts", "src/r/a.ts"),
                            ("scripts/*.ts", "scripts/a.ts"),
                            ("a?.py", "ab.py"),
                            ("a?.py", "a/.py"),
                        )
                    ]
                )
            ],
            [str([True, True, False, True, True, False])],
        ),
    ]


def selftest_tests(tmp: Path) -> list[Case]:
    """The tests a suite ran: fewer, more, skipped, left to do, a file gone, each runner's
    report."""
    a, b = "worker/test/a.test.ts", "worker/test/b.test.ts"
    floors = {"tests": {a: 2, b: 1}}

    def ran(**counts: Counter[str]) -> list[str]:
        return held_tests(floors, {f"worker/test/{k}.test.ts": c for k, c in counts.items()})

    vitest = tmp / "vitest.json"
    vitest.write_text(
        json.dumps(
            {
                "testResults": [
                    {
                        "name": str(ROOT / a),
                        "status": "passed",
                        "assertionResults": [
                            {"status": s}
                            for s in ("passed", "passed", "skipped", "todo", "pending")
                        ],
                    },
                    {"name": str(ROOT / b), "status": "failed", "assertionResults": []},
                ]
            }
        )
    )
    node = tmp / "node.json"
    node.write_text(json.dumps({"files": {a: {"tests": 2, "skipped": 0, "todo": 0, "failed": 0}}}))
    old = {"tests": {a: 2}}

    def fewer(n: int, *lines: str) -> list[str]:
        return lowered(old, {"tests": {a: n}, "lowered": dict.fromkeys(lines, "why")})

    return [
        ("every test ran", ran(a=Counter(tests=2), b=Counter(tests=1)), []),
        ("a test fewer", ran(a=Counter(tests=1), b=Counter(tests=1)), ["1 tests ran in", "says 2"]),
        ("a test more", ran(a=Counter(tests=3), b=Counter(tests=1)), ["3 tests ran in"]),
        ("a file gone", ran(a=Counter(tests=2)), [f"no test ran in {b}"]),
        (
            "a file no floor names",
            ran(a=Counter(tests=2), b=Counter(tests=1), c=Counter(tests=1)),
            ["which [tests] does not name"],
        ),
        (
            "a test skipped",
            ran(a=Counter(tests=2, skipped=1), b=Counter(tests=1)),
            ["1 skipped in"],
        ),
        ("a test left to do", ran(a=Counter(tests=2), b=Counter(tests=1, todo=1)), ["1 todo in"]),
        ("a test failed", ran(a=Counter(tests=2, failed=1), b=Counter(tests=1)), ["1 failed in"]),
        ("no test at all", held_tests({}, {}), ["no test ran"]),
        (
            "vitest's report",
            [str(sorted((f, sorted(c.items())) for f, c in test_counts(vitest).items()))],
            [
                str(
                    [
                        (a, [("skipped", 2), ("tests", 2), ("todo", 1)]),
                        (b, [("failed", 1), ("tests", 0)]),
                    ]
                )
            ],
        ),
        ("the report of our runners", [str(test_counts(node)[a]["tests"])], ["2"]),
        ("tests lowered", fewer(1), [f"the tests of {a} went from 2 to 1"]),
        ("tests lowered and said so", fewer(1, f"tests {a} 2026-01-01"), []),
        ("tests lowered, said of another kind", fewer(1, f"line {a} 2026-01-01"), ["went from"]),
        ("a test file that left", lowered(old, {}), ["went from 2 to 0"]),
        ("tests raised", fewer(3), []),
    ]


def selftest_skips(tmp: Path) -> list[Case]:
    """Every way to keep a test from running that the hook knows, in both languages."""
    (tmp / "registry" / "tests").mkdir(parents=True)
    (tmp / "worker" / "test" / "node_modules").mkdir(parents=True)
    allowed = ("registry/tests/test_a.py", "@unittest.skip" + "If(X, 'why')")
    py = [
        "@unittest.skip" + "('x')",
        "@skip" + "If(True, 'x')",
        "@unittest.skip" + "Unless(False, 'x')",
        "raise unittest.Skip" + "Test('x')",
        "@unittest.expected" + "Failure",
        "self.skip" + "Test('x')",
    ]
    js = [
        "describe.sk" + "ip('x', () => {});",
        "it.to" + "do('x');",
        "it.skip" + "If(true)('x', () => {});",
        "test.run" + "If(false)('x', () => {});",
        "it.on" + "ly('x', () => {});",
        "it.fa" + "ils('x', () => {});",
        "it('x', (t) => { t.sk" + "ip(); });",
        "it('x', { sk" + "ip: true }, () => {});",
        "it('x', { timeout: 1, to" + "do: 'later' }, () => {});",
    ]
    fine = ["self.fails('x')", "const skipped = 0;", "it('skips nothing', () => {});"]
    (tmp / allowed[0]).write_text("\n".join([allowed[1], *py, *fine]) + "\n")
    (tmp / "worker" / "test" / "a.test.ts").write_text("\n".join([*js, *fine]) + "\n")
    (tmp / "worker" / "test" / "node_modules" / "x.js").write_text(js[0] + "\n")
    found = skips(tmp, {allowed: 1})
    return [
        ("every planted skip", [str(len(found))], [str(len(py) + len(js))]),
        *((f"planted: {line}", found, [line]) for line in [*py, *js]),
        ("an allowed skip that is gone", skips(tmp, {allowed: 2}), ["there 1 times, not 2"]),
        ("the skips here", skips(ROOT, SKIP_ALLOWED), []),
    ]


def selftest_moved(tmp: Path) -> list[Case]:
    """What moved the wrong way: each kind, with its line and without, and what did not move."""
    floors = "tests/floors/x.toml"
    listed = "tests/exclusions/x.toml"
    entry = '[[entry]]\nkind = "line"\nfile = "f"\nfunction = "g"\ntext = "t"\nreason = "tool"\n'
    old = {
        floors: 'files = ["f"]\n[misses]\nline = 1\n[measured]\nf = { line = 5 }\n'
        '[tests]\n"t" = 4\n',
        listed: entry,
        "pyproject.toml": "[tool.coverage.report]\nfail_under = 100\n",
    }

    def tree(name: str = "", text: str = "") -> list[str]:
        for n, t in (old | ({name: text} if name else {})).items():
            (tmp / n).parent.mkdir(parents=True, exist_ok=True)
            (tmp / n).write_text(t)
        return moved(lambda n: old.get(n, ""), tmp)

    def floor(a: str, b: str, more: str = "") -> list[str]:
        return tree(floors, old[floors].replace(a, b) + more)

    said = '[raised]\n"line 2026-01-01" = "why"\n'
    lower = "[tool.coverage.report]\nfail_under = 99\n"
    return [
        ("nothing moved", tree(), []),
        ("a floor raised, no line", floor("line = 1", "line = 2"), ["line went from 1 to 2"]),
        ("a floor raised, its line", floor("line = 1", "line = 2", said), ["1 to 2", "new line"]),
        ("less to measure", floor("line = 5", "line = 4"), ["line of f went from 5 to 4"]),
        ("fewer tests", floor('"t" = 4', '"t" = 3'), ["the tests of t went from 4 to 3"]),
        ("more tests", floor('"t" = 4', '"t" = 5'), []),
        ("a floor lowered", floor("line = 1", "line = 0"), []),
        (
            "a new entry",
            tree(listed, entry + entry.replace('"t"', '"u"')),
            ["entry: line in f, g: u"],
        ),
        ("an entry gone", tree(listed, ""), []),
        ("a threshold lowered", tree("pyproject.toml", lower), ["fail_under went from 100 to 99"]),
        ("a threshold gone", tree("pyproject.toml", "[tool.coverage.report]\n"), ["is gone"]),
        (
            "a second, lower flag",
            [
                str(
                    thresholds(
                        lambda n: (
                            "--test-coverage-lines=100 --test-coverage-lines=90"
                            if n.endswith("ci.yml")
                            else ""
                        )
                    )
                )
            ],
            [str({".github/workflows/ci.yml lines": 90})],
        ),
        ("the thresholds here", [str(len(thresholds(here)))], ["11"]),
    ]


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
        survivors = Counter(stryker(here_dir / "mutation.json"))
        first = next(iter(survivors))
        cases += [
            ("a run of some lines, none listed", unlisted(survivors, none), ["not listed (3)"]),
            ("a run of some lines, all listed", unlisted(survivors, survivors), []),
            ("one more than listed", unlisted(survivors, Counter([first] * 2)), ["listed (1)"]),
        ]
        cases += selftest_areas(here_dir / "tree")
        cases += selftest_tests(here_dir)
        cases += selftest_skips(here_dir / "skips")
        cases += selftest_moved(here_dir / "moved")
        page = here_dir / "summary.md"
        summarize(page, "check x", "ratchet check: ok", [])
        summarize(page, "check y", "ratchet check: 1 problems", ["a ``` b"])
        summarize(page, "areas", "ratchet areas: 1 problems", ["a.ts is in no area"])
        cases.append(
            (
                "a job's summary says the verdict, and the problems in a block",
                [page.read_text()],
                [
                    "**check x**: ok\n\n**check y**: 1 problems\n\n````text\na ``` b\n````\n\n"
                    "**areas**: 1 problems\n\n```text\na.ts is in no area\n```\n\n"
                ],
            )
        )
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
    mv = commands.add_parser(
        "moved", help="what moved the wrong way since a revision, lines or not"
    )
    mv.add_argument("revision")
    commands.add_parser("areas", help="every source file in exactly one area")
    li = commands.add_parser("listed", help="every survivor of a run of some lines is listed")
    li.add_argument("area")
    li.add_argument("--mutants", nargs="+", required=True)
    t = commands.add_parser("tests", help="the tests a suite ran against its floors")
    t.add_argument("suite")
    t.add_argument("--report", nargs="+", required=True)
    commands.add_parser("pragmas", help="no inline pragma in the sources")
    commands.add_parser("skips", help="no test skipped, left to do or expected to fail")
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
    elif args.command == "moved":
        problems = moved(at(args.revision))
        for p in problems:
            # A warning on the run's page as well, where the summary below repeats them.
            print(f"::warning title=Moved against {args.revision}::{p}")
    elif args.command == "areas":
        problems = areas(ROOT)
    elif args.command == "listed":
        problems = listed(args.area, args.mutants)
    elif args.command == "tests":
        problems = suite(args.suite, args.report)
    elif args.command == "pragmas":
        problems = pragmas([ROOT / p for p in PRAGMA_PLACES])
    elif args.command == "skips":
        problems = skips(ROOT, SKIP_ALLOWED)
    else:
        problems = selftest()
    for p in problems:
        print(p, file=sys.stderr)
    verdict = f"ratchet {args.command}: {'ok' if not problems else f'{len(problems)} problems'}"
    print(verdict)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        summarize(Path(summary), " ".join(argv[:2]), verdict, problems)
    return 1 if problems else 0


def summarize(path: Path, asked: str, verdict: str, problems: list[str]) -> None:
    """The verdict, and what failed, on the page of a CI run (GitHub's job summary)."""
    lines = [f"**{asked}**: {verdict.split(': ', 1)[1]}", ""]
    if problems:
        # A fence longer than any run of backticks it holds (a template literal of the source).
        fence = "`" * max([3, *(len(run) + 1 for p in problems for run in re.findall("`+", p))])
        lines += [f"{fence}text", *problems, fence, ""]
    with path.open("a", encoding="utf-8") as out:
        out.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
