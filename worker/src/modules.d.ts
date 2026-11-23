// SPDX-License-Identifier: MIT
// Files bundled by the "Text" and "Data" rules of wrangler.jsonc.
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
declare module "*.svg" {
  const text: string;
  export default text;
}
declare module "*.woff2" {
  const bytes: ArrayBuffer;
  export default bytes;
}
