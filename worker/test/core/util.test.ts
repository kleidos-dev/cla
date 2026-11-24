// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode, b64urlEncode, byCodeUnits, clientIp, fromUtf8, hex, isLogin, must, normalizeSentence, nowSeconds, randomB64url, readCapped, safeEqual, sha256Hex, stripEnd, utf8 } from "../../src/util";
import vectors from "../../../registry/tests/normalize-vectors.json";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const bytes = fc.uint8Array({ maxLength: 200 });

describe("text and bytes", () => {
  it("a byte string that is not UTF-8 is refused, not replaced", () => {
    expect(() => fromUtf8(new Uint8Array([0x61, 0xff]))).toThrow(TypeError);
    expect(() => fromUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow(TypeError);
  });

  it("a byte-order mark is kept: it is content, not a marker", () => {
    expect(fromUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("\ufeffa");
  });

  it("any well-formed text survives the round trip", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }).map((s) => s.toWellFormed()), (s) => {
        expect(fromUtf8(utf8(s))).toBe(s);
      }),
      { seed: 1 },
    );
  });

  it("hex writes two digits per byte, from a buffer or a view", () => {
    const b = new Uint8Array([0, 9, 15, 16, 255]);
    expect(hex(b)).toBe("00090f10ff");
    expect(hex(b.buffer)).toBe("00090f10ff");
    expect(hex(b.subarray(1, 3))).toBe("090f");
  });

  it("SHA-256 of a string is that of its UTF-8 bytes", async () => {
    // FIPS 180-2, "abc".
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(utf8("é"))).toBe(await sha256Hex("é"));
  });

  it("code units order strings the same in every locale", () => {
    expect(byCodeUnits("B", "a")).toBe(-1);
    expect(byCodeUnits("a", "B")).toBe(1);
    expect(byCodeUnits("a", "a")).toBe(0);
    expect(["ä", "a", "Z", "z"].sort(byCodeUnits)).toEqual(["Z", "a", "z", "ä"]);
  });
});

describe("stripEnd", () => {
  it.each([
    ["abc==", "=", "abc"],
    ["==", "=", ""],
    ["", "=", ""],
    ["a=b=", "=", "a=b"],
    ["a \t ", " \t", "a"],
    ["abc", "=", "abc"],
    ["abc", "", "abc"],
  ])("%j without the run of %j at its end is %j", (s, chars, out) => {
    expect(stripEnd(s, chars)).toBe(out);
  });
});

describe("base64url", () => {
  it.each([
    [[], ""],
    [[0], "AA"],
    [[0, 0], "AAA"],
    [[0, 0, 0], "AAAA"],
    [[0xfb, 0xff, 0xbf], "-_-_"],
    [[0xff, 0xff, 0xff, 0xff], "_____w"],
  ])("the bytes %j are %j, with no padding", (raw, text) => {
    expect(b64urlEncode(new Uint8Array(raw))).toBe(text);
    expect([...must(b64urlDecode(text))]).toEqual(raw);
  });

  it.each(["A", "AAAAA", "AA==", "AA+A", "AA/A", "AA A", "AA\n", "\nAA", "é", "AAAA.AAAA"])("%j is not base64url", (s) => {
    expect(b64urlDecode(s)).toBeNull();
  });

  it("whatever is encoded decodes to itself, in the alphabet only", () => {
    fc.assert(
      fc.property(bytes, (b) => {
        const s = b64urlEncode(b);
        expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(hex(must(b64urlDecode(s)))).toBe(hex(b));
      }),
      { seed: 2 },
    );
  });

  it("any text decodes to bytes or to null, never throwing", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: fc.constantFrom(...Array.from("AZaz09-_=+/ \n")) })), (s) => {
        const out = b64urlDecode(s);
        expect(out === null).toBe(!/^[A-Za-z0-9_-]*$/.test(s) || /\n/.test(s) || s.length % 4 === 1);
      }),
      { seed: 3, numRuns: 500 },
    );
  });

  it("a random value has the asked number of bytes and is not repeated", () => {
    expect(must(b64urlDecode(randomB64url(32)))).toHaveLength(32);
    expect(must(b64urlDecode(randomB64url(16)))).toHaveLength(16);
    expect(randomB64url(32)).not.toBe(randomB64url(32));
  });

  it("a random value comes from the platform's generator", () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((a) => {
      (a as Uint8Array).set([0xfb, 0xff, 0xbf]);
      return a;
    });
    expect(randomB64url(3)).toBe("-_-_");
  });
});

describe("safeEqual", () => {
  it.each([
    ["", "", true],
    ["abc", "abc", true],
    ["abc", "abx", false],
    ["abc", "ab", false],
    ["ab", "abc", false],
    ["é", "e\u0301", false],
    ["é", "ab", false],
  ])("%j and %j: %j", (a, b, equal) => {
    expect(safeEqual(a, b)).toBe(equal);
  });

  it("compares in constant time once the lengths match, and not at all when they differ", () => {
    const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");
    safeEqual("abc", "abx");
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0]?.map((x) => fromUtf8(x as Uint8Array))).toEqual(["abc", "abx"]);
    safeEqual("abc", "abcd");
    expect(compare).toHaveBeenCalledTimes(1);
  });
});

describe("isLogin", () => {
  it.each(["a", "A", "0", "alice", "al-ice", "a-b-c", "a".repeat(39), "dependabot[bot]", `${"a".repeat(39)}[bot]`])("%j is a login GitHub can have", (s) => {
    expect(isLogin(s)).toBe(true);
  });

  it.each(["", "-a", "a-", "a--b", "a_b", "a.b", "a b", "a".repeat(40), "a[bot", "a[BOT]", "[bot]", "a[bot][bot]", "xa[bot]x", "alice\n", " alice", "\u017fam", "Kelvin\u212a", "álice", "a-[bot]"])("%j is not", (s) => {
    expect(isLogin(s)).toBe(false);
  });

  it.each([undefined, null, 1, true, {}, ["alice"]])("a value that is no string (%j) is not", (v) => {
    expect(isLogin(v)).toBe(false);
  });
});

describe("the clock", () => {
  it("counts whole seconds, rounded down", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_700_000_000_999 });
    expect(nowSeconds()).toBe(1_700_000_000);
  });
});

describe("normalizeSentence", () => {
  it.each(vectors.vectors)("the vector shared with the recorder: $in", (v) => {
    expect(normalizeSentence(v.in)).toBe(v.out);
  });

  /** Every character either JavaScript's or Python's `\s` takes: one by one, because a mutation tool cannot change the literal that lists them. */
  const SPACES = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff];

  it("exactly these characters are white space, of the whole Basic Multilingual Plane", () => {
    const taken: number[] = [];
    for (let c = 0; c <= 0xffff; c++) if (normalizeSentence(`a${String.fromCharCode(c)}b`) === "a b") taken.push(c);
    expect(taken).toEqual(SPACES);
  });

  it("a run of mixed white space is one space, and none is left at the ends", () => {
    expect(normalizeSentence(`${SPACES.map((c) => String.fromCharCode(c)).join("")}a\u0085\u3000 \tb\r\n`)).toBe("a b");
    expect(normalizeSentence(" \n ")).toBe("");
  });

  it("is idempotent, and equal for canonically equivalent texts", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        const once = normalizeSentence(s);
        expect(normalizeSentence(once)).toBe(once);
        expect(normalizeSentence(s.normalize("NFD"))).toBe(once);
      }),
      { seed: 4 },
    );
  });

  it("changes no character that is not white space", () => {
    expect(normalizeSentence("A.b,C-\u200b(89c1)")).toBe("A.b,C-\u200b(89c1)");
  });
});

describe("clientIp", () => {
  it("is the address Cloudflare saw, or the word unknown: no other header is believed", () => {
    expect(clientIp(new Request("https://x.example/", { headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" } }))).toBe("203.0.113.7");
    expect(clientIp(new Request("https://x.example/", { headers: { "x-forwarded-for": "198.51.100.1" } }))).toBe("unknown");
  });
});

describe("readCapped", () => {
  /** A body in chunks that counts how many were asked for and whether it was cancelled. */
  function chunked(sizes: number[], headers: Record<string, string> = {}) {
    const state = { pulled: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          const size = sizes[state.pulled++];
          if (size === undefined) c.close();
          else c.enqueue(new Uint8Array(size).fill(state.pulled));
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const req = { headers: new Headers(headers), body } as unknown as Request;
    return { req, state };
  }

  it("a body of exactly the cap is read whole, its chunks in order", async () => {
    const { req, state } = chunked([2, 3]);
    expect([...must(await readCapped(req, 5))]).toEqual([1, 1, 2, 2, 2]);
    expect(state.cancelled).toBe(false);
  });

  it("one byte past the cap is refused, and the rest is neither read nor left waiting", async () => {
    const { req, state } = chunked([2, 4, 9, 9]);
    expect(await readCapped(req, 5)).toBeNull();
    expect(state).toEqual({ pulled: 2, cancelled: true });
  });

  it("a declared length past the cap is refused before a byte is read", async () => {
    const { req, state } = chunked([1], { "content-length": "6" });
    expect(await readCapped(req, 5)).toBeNull();
    expect(state).toEqual({ pulled: 0, cancelled: true });
  });

  it.each(["5", "0", "-1", "", "a lot", "Infinity"])("a declared length of %j decides nothing: what is read does", async (length) => {
    const ok = chunked([5], { "content-length": length });
    expect(must(await readCapped(ok.req, 5))).toHaveLength(5);
    const over = chunked([6], { "content-length": length });
    expect(await readCapped(over.req, 5)).toBeNull();
  });

  it("no body is no bytes, also when a length was declared", async () => {
    expect(must(await readCapped({ headers: new Headers(), body: null } as unknown as Request, 5))).toHaveLength(0);
    expect(await readCapped({ headers: new Headers({ "content-length": "6" }), body: null } as unknown as Request, 5)).toBeNull();
  });

  it("a real request is read as the runtime gives it", async () => {
    const req = new Request("https://x.example/", { method: "POST", body: "añb" });
    expect(fromUtf8(must(await readCapped(req, 10)))).toBe("añb");
  });
});

describe("must", () => {
  it("passes a value on, the falsy ones too", () => {
    for (const v of [0, "", false, NaN]) expect(must(v)).toBe(v);
  });

  it("stops on a value that is not there, and says so", () => {
    for (const v of [null, undefined])
      expect(() => {
        must(v);
      }).toThrow("a value the code relies on is missing");
  });
});
