// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/**
 * The one literal StrykerJS cannot mutate: its Regex mutator turns `\v` into
 * `\V`, a syntax error under the `u` flag that stops every test file from
 * loading. Only WHITESPACE in src/util.ts has both; test/core/util.test.ts
 * checks that literal character by character over the whole Basic
 * Multilingual Plane, and tests/exclusions/worker-core.toml lists it.
 */
import { PluginKind, declareClassPlugin } from "@stryker-mutator/api/plugin";

class VerticalTab {
  shouldIgnore(path) {
    const unicode = path.isRegExpLiteral() && path.node.flags.includes("u");
    return unicode && path.node.pattern.includes("\\v") ? "the mutator writes \\V, a syntax error under the u flag" : undefined;
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.Ignore, "v-escape", VerticalTab)];
