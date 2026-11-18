// Keeps the town kind. Every piece of outside text (notes, adoption fields) and every public
// creature utterance (speech, notice-board posts) passes through checkText before it is stored.
// It rejects rather than rewrites: a blocked note never reaches a creature.
// Extend the list without a redeploy of code by setting BLOCKLIST_EXTRA (comma separated words).

export type Verdict = { ok: true; text: string } | { ok: false; reason: "unkind" | "contact" | "spam" | "injection" | "empty" | "language" };

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t", "8": "b", "(": "c" };

/** lower-case, strip accents, undo l33t, squash repeats; keeps letters, digits and spaces. */
export function normalize(s: string): string {
  const base = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[01!|34@5$7+8(]/g, (ch) => LEET[ch] ?? ch)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/(.)\1{2,}/g, "$1$1");
  // "f u c k" / "f.u.c.k" -> "fuck": join runs of single letters
  return base.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (m) => m.replace(/ /g, "")).replace(/\s{2,}/g, " ").trim();
}

// Stems matched inside the normalised text. Deliberately a short list of unambiguous words;
// the "squashed" check (spaces removed) is only used for the long, distinctive ones in LONG.
const STEMS = [
  "fuck", "shit", "bitch", "cunt", "dick", "pussy", "whore", "slut", "bastard", "asshole",
  "nigg", "fagg", "faggot", "retard", "tranny", "kike", "chink", "spic", "wetback", "coon",
  "porn", "nude", "naked", "sex", "boob", "penis", "vagina", "orgasm", "horny", "rape", "molest", "pedo",
  "kill yourself", "kys", "suicide", "self harm", "hang yourself", "shoot up", "terroris", "nazi", "heil",
  "retarded", "idiot", "stupid", "loser", "ugly", "hate you", "shut up", "die ",
];
const LONG = ["fuck", "shit", "bitch", "nigg", "faggot", "retard", "porn", "whore", "kill yourself", "molest", "asshole"];

const INJECTION = [
  "ignore previous", "ignore all", "ignore the above", "disregard", "system prompt", "you are now", "new instructions",
  "developer mode", "jailbreak", "reveal your", "your instructions", "as an ai", "language model",
  "forget everything", "override", "sudo", "```", "<system", "[system",
];

const SPAM = [
  "airdrop", "giveaway", "crypto", "bitcoin", "ethereum", "casino", "betting", "free money",
  "click here", "subscribe", "dm me", "telegram", "whatsapp", "discord", "onlyfans", "promo code", "follow me",
];

const EMAIL = /[a-z0-9._%+-]+\s*(@|\(at\)|\[at\])\s*[a-z0-9.-]+\s*(\.|\(dot\)|\[dot\])\s*[a-z]{2,}/i;
const PHONE = /(\+?\d[\d\s().-]{8,}\d)/;
const URLISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|me|co|gg|ly|app|dev)\b)/i;
const ADDRESS = /\b\d{1,5}\s+[a-z]+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|blvd)\b/i;
const HANDLE = /(^|\s)@[a-z0-9_]{3,}/i;

// English only (for now). The word lists above are English, so other languages would sail straight past them.
const STOP = new Set(("the a an and or but is are was were be been i you he she it we they me my your his her our their to of in on at for with this that these those " +
  "hi hello hey thanks thank please not no yes do does did have has had will can so if as by from what how when who there here just like love good nice very too up out").split(" "));

export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return true; // numbers, emoji, punctuation
  if (letters.some((ch) => !/\p{Script=Latin}/u.test(ch))) return false; // Cyrillic, Arabic, CJK, Greek, ...
  const accented = letters.filter((ch) => ch.charCodeAt(0) > 127).length;
  if (accented / letters.length > 0.1) return false; // heavily accented Latin text is almost never English
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length >= 5 && !words.some((w) => STOP.has(w))) return false; // Latin script, no English function words
  return true;
}

function extraWords(): string[] {
  return (process.env.BLOCKLIST_EXTRA ?? "")
    .split(",")
    .map((w) => normalize(w))
    .filter((w) => w.length >= 3);
}

function hasStem(hay: string, stems: string[]): boolean {
  const padded = ` ${hay} `;
  return stems.some((st) => padded.includes(st.endsWith(" ") ? ` ${st}` : st.length <= 4 ? ` ${st}` : st));
}

export function checkText(raw: unknown, opts: { max?: number; allowEmpty?: boolean } = {}): Verdict {
  const text = String(raw ?? "").trim();
  if (!text) return opts.allowEmpty ? { ok: true, text: "" } : { ok: false, reason: "empty" };
  if (opts.max && text.length > opts.max) return { ok: true, text: text.slice(0, opts.max) }; // callers also slice; never reject on length

  if (!looksEnglish(text)) return { ok: false, reason: "language" };

  if (EMAIL.test(text) || PHONE.test(text) || URLISH.test(text) || ADDRESS.test(text) || HANDLE.test(text)) return { ok: false, reason: "contact" };

  const n = normalize(text);
  const squashed = n.replace(/ /g, "");
  const stems = [...STEMS, ...extraWords()];
  if (hasStem(n, stems)) return { ok: false, reason: "unkind" };
  if ([...LONG, ...extraWords()].some((w) => squashed.includes(w.replace(/ /g, "")))) return { ok: false, reason: "unkind" };

  const lowered = text.toLowerCase();
  if (INJECTION.some((p) => lowered.includes(p) || n.includes(p))) return { ok: false, reason: "injection" };
  if (SPAM.some((p) => n.includes(p))) return { ok: false, reason: "spam" };

  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length > 12 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.7) return { ok: false, reason: "spam" }; // SHOUTING
  if (/(.{2,6})\1{4,}/.test(text)) return { ok: false, reason: "spam" }; // repeated chunks

  return { ok: true, text };
}

/** Message shown to a visitor. Never reveals which rule fired. */
export function visitorMessage(reason: string): string {
  if (reason === "contact") return "Please leave out links, emails, phone numbers and addresses. The town keeps those private.";
  if (reason === "spam") return "That reads like an advert or shouting. A few quiet, friendly words work best.";
  if (reason === "language") return "The town only speaks English for now. Try a few words in English.";
  if (reason === "empty") return "Write a few words first.";
  return "The town only takes kind, simple words. Try something warmer.";
}

/** Convenience for lists of short adoption fields; returns the first problem, or null. */
export function checkAll(fields: string[]): Extract<Verdict, { ok: false }> | null {
  for (const f of fields) {
    const v = checkText(f, { allowEmpty: true });
    if (!v.ok) return v;
  }
  return null;
}
