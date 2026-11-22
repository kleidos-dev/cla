// SPDX-License-Identifier: MIT
// Files bundled as text by the "Text" rule of wrangler.jsonc.
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*/SHA256SUMS" {
  const text: string;
  export default text;
}
declare module "*.css" {
  const text: string;
  export default text;
}
