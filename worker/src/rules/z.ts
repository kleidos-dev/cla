// SPDX-FileCopyrightText: 2026 José M. Requena Plens
// SPDX-License-Identifier: MIT
/** Planted: a Worker source in a subfolder, in no area. */
export const z = (s: string): boolean => s.startsWith("trusted-") && s.length > 40;
