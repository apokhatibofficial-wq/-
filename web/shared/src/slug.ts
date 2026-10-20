/** Same rule as the server (SlugPolicy.cs) and the database CHECK constraint. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Suggests a slug from the English name, as in the prototype. The server still decides. */
export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');

/** Keeps only characters a slug may contain while the user types. */
export const cleanSlugInput = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '');
