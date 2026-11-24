# SPDX-FileCopyrightText: 2026 José M. Requena Plens
# SPDX-License-Identifier: MIT
"""Writes tokens.py: answers of a time-stamping authority made for the tests, and thrown away.

The keys are never kept, so the file cannot be made again byte by byte; it is made once, and only
again if a test needs another answer.

    python3 registry/tests/make_tokens.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cla

DATA = b"what the tests' tokens are over\n"
NONCE = 0x1122334455667789
OTHER_POLICY = "1.2.3.4.1"
CONFIG = f"""[tsa]
default_tsa = t
[t]
serial = serial
signer_digest = sha256
default_policy = {cla.QUALIFIED_POLICY}
other_policies = {OTHER_POLICY}
digests = sha256
accuracy = secs:1
clock_precision_digits = 3
ess_cert_id_alg = sha256
"""


def openssl(folder: str, *args: str) -> None:
    subprocess.run(["openssl", *args], cwd=folder, check=True, capture_output=True)


def authority(folder: str, name: str, *extensions: str) -> None:
    added = [x for e in extensions for x in ("-addext", e)]
    openssl(
        folder,
        *("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"),
        *("-days", "2", "-subj", f"/CN=Made up for the tests ({name})"),
        *("-addext", "extendedKeyUsage=critical,timeStamping", *added),
        *("-keyout", f"{name}.key", "-out", f"{name}.pem"),
    )


def reply(folder: str, query: str, signer: str, out: str, *more: str) -> bytes:
    openssl(
        folder,
        *("ts", "-reply", "-config", "tsa.cnf", "-queryfile", query, "-out", out),
        *("-signer", f"{signer}.pem", "-inkey", f"{signer}.key", *more),
    )
    return (Path(folder) / out).read_bytes()


def main() -> None:
    statement = cla.QTST_STATEMENT_DER.hex(":")
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        (root / "tsa.cnf").write_text(CONFIG, "ascii")
        authority(d, "qualified", f"1.3.6.1.5.5.7.1.3=DER:{statement}")
        authority(d, "plain")
        (root / "q.tsq").write_bytes(cla.timestamp_query(cla.sha256(DATA), NONCE))
        openssl(d, "ts", "-query", "-data", "tsa.cnf", "-sha512", "-out", "other.tsq")
        found = {
            "QUALIFIED_ROOT": (root / "qualified.pem").read_bytes(),
            "PLAIN_ROOT": (root / "plain.pem").read_bytes(),
            "QUALIFIED": reply(d, "q.tsq", "qualified", "a.tsr"),
            "NO_STATEMENT": reply(d, "q.tsq", "plain", "b.tsr"),
            "OTHER_POLICY": reply(d, "q.tsq", "qualified", "c.tsr", "-tspolicy", OTHER_POLICY),
            "REJECTED": reply(d, "other.tsq", "qualified", "d.tsr"),
        }
    text = [
        *Path(__file__).read_text("utf-8").splitlines()[:2],
        '"""Made by make_tokens.py: answers of a made-up authority, and its roots."""',
        "",
        f"DATA = {DATA!r}",
        f"NONCE = {NONCE:#x}",
    ]
    for name, data in found.items():
        lines = "\n".join(f'    "{x}"' for x in textwrap.wrap(data.hex(), 88))
        text.append(f"{name} = bytes.fromhex(\n{lines}\n)")
    (Path(__file__).parent / "tokens.py").write_text("\n".join(text) + "\n", "utf-8")


if __name__ == "__main__":
    main()
