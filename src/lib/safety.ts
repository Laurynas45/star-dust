/**
 * Refuses sexual content involving a minor before a job is queued.
 * Ordinary scenes with children, and adult text that is not about minors, are left alone.
 */

const INHERENT = [
  /\blolis?\b/i,
  /\bshotas?\b/i,
  /\bjailbait\b/i,
  /\bcsam\b/i,
  /\blolicon\b/i,
  /\bshotacon\b/i,
  /\bchild[\s._-]*porn/i,
  /\bkiddie[\s._-]*porn/i,
];

const MINOR = [
  /\bminors?\b/i,
  /\bchildren\b/i,
  /\bchild\b/i,
  /\bkids?\b/i,
  /\bkiddies\b/i,
  /\btoddlers?\b/i,
  /\binfants?\b/i,
  /\bbab(?:y|ies)\b/i,
  /\bunderage\b/i,
  /\bpre-?teens?\b/i,
  /\bteen(?:ager)?s?\b/i,
  /\bschoolgirls?\b/i,
  /\bschoolboys?\b/i,
  /\bunder[\s-]?18\b/i,
];

const SEXUAL = [
  /\bnudes?\b/i,
  /\bnaked\b/i,
  /\bnsfw\b/i,
  /\bporn(?:o|ography)?\b/i,
  /\berotic\b/i,
  /\bsexual(?:ly|ized|ised)?\b/i,
  /\bsex\b/i,
  /\bstrip(?:ping|tease)?\b/i,
  /\blingerie\b/i,
  /\bxxx\b/i,
  /\bfetish\b/i,
  /\borgasm\b/i,
  /\bpenetrat(?:e|ion|ing)\b/i,
];

const AGE =
  /\b(\d{1,2})\s*(?:years?\s*old|year[\s-]*old|yo|y\/o)\b/gi;

export const MINOR_SEXUAL_REFUSAL =
  "Star Dust will not generate sexual content involving a minor. Nothing was queued and the image was not stored.";

function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isDisallowedMinorSexualContent(text: string): boolean {
  const value = normalize(text);
  if (!value) return false;
  if (INHERENT.some((pattern) => pattern.test(value))) return true;

  const sexual = SEXUAL.some((pattern) => pattern.test(value));
  if (!sexual) return false;
  if (MINOR.some((pattern) => pattern.test(value))) return true;

  const ages = new RegExp(AGE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = ages.exec(value)) !== null) {
    const age = Number(match[1]);
    if (Number.isFinite(age) && age < 18) return true;
  }
  return false;
}

export function generationIsRefused(prompt: string, filenames: string[]): boolean {
  const combined = [prompt, ...filenames.filter(Boolean)].join("\n");
  return isDisallowedMinorSexualContent(combined);
}
