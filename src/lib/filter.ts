// Keeps the town kind. Every piece of outside text (notes, adoption fields) and every public
// creature utterance (speech, notice-board posts) passes through checkText before it is stored.
// It rejects rather than rewrites: a blocked note never reaches a creature.
// Extend the list without a redeploy of code by setting BLOCKLIST_EXTRA (comma separated words).

export type Verdict = { ok: true; text: string } | { ok: false; reason: "unkind" | "contact" | "spam" | "injection" | "empty" | "language" };

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t", "8": "b", "(": "c" };

// Characters that are invisible or only change how text is drawn: zero-width, bidi controls (RTL/LTR marks and
// overrides), BOM, tag characters, soft hyphen, variation selectors and private-use. Removed before any check and
// from anything stored, so "ign\u200bore" cannot dodge a phrase and an RTL override cannot reorder a public line.
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\ufe00-\ufe0f]/gu;
const ZALGO = /(\p{M}{3})\p{M}+/gu;
/** Lookalike Latin letters that NFKD leaves alone. */
const LOOKALIKE: Record<string, string> = { "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ŧ": "t", "ß": "ss", "æ": "ae", "œ": "oe", "ƒ": "f", "ɡ": "g" };

/** Remove invisible/format characters and zalgo stacks, keeping ordinary text (including accents and newlines) as is. */
export function stripInvisible(s: string): string {
  return String(s ?? "").replace(INVISIBLE, "").replace(ZALGO, "$1");
}

/** lower-case, strip accents and invisible characters, undo l33t, squash repeats; keeps letters, digits and spaces.
 *  `one` picks what "1" stands for (i or l): callers check both. */
export function normalize(s: string, one: "i" | "l" = "i"): string {
  const base = stripInvisible(s)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[ıłøđħŧßæœƒɡ]/g, (ch) => LOOKALIKE[ch] ?? ch)
    .replace(/[01!|34@5$7+8(]/g, (ch) => (ch === "1" ? one : (LEET[ch] ?? ch)))
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/(.)\1{2,}/g, "$1$1");
  // "f u c k" / "f.u.c.k" -> "fuck": join runs of single letters
  return base.replace(/\b(?:[a-z] ){2,}[a-z]\b/g, (m) => m.replace(/ /g, "")).replace(/\s{2,}/g, " ").trim();
}

const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");

/** Joins of 2 or 3 neighbouring words where at most one piece is longer than 2 letters: "fu ck", "sh it", "f uck", "ign ore". */
function splitJoins(n: string): string[] {
  const t = n.split(" ");
  const out: string[] = [];
  for (let i = 0; i < t.length; i++)
    for (const k of [2, 3]) {
      const piece = t.slice(i, i + k);
      if (piece.length < k || piece.filter((p) => p.length > 2).length > 1) continue;
      out.push(piece.join(""));
    }
  return out;
}

// Stems matched at the START of a word in the normalised text ("fuck" also catches "fucking"). Deliberately a short
// list of unambiguous words. EXACT words must match whole (so "spicy", "sextant", "Dickens" and "pedometer" pass).
// LONG words are also matched inside a single word or inside split-up pieces ("fu ck"), never across the whole text.
const STEMS = [
  "fuck", "shit", "bitch", "cunt", "pussy", "whore", "bastard", "asshole",
  "nigg", "fagg", "faggot", "retard", "tranny", "wetback",
  "porn", "nude", "naked", "boob", "penis", "vagina", "orgasm", "horny", "molest",
  "kill yourself", "suicid", "self harm", "hang yourself", "shoot up", "terroris", "nazi",
  "idiot", "stupid", "loser", "hate you", "shut up",
];
const EXACT = ["slut", "dick", "spic", "chink", "kike", "coon", "sex", "sexy", "rape", "raped", "rapes", "rapist", "pedo", "kys", "heil", "die", "ugly"];
const LONG = ["fuck", "shit", "bitch", "nigg", "faggot", "retard", "porn", "whore", "kill yourself", "molest", "asshole"];
// Same, but compared after collapsing repeated letters ("fuuuck", "shiiit"); only words that survive collapsing safely.
const COLLAPSED = ["fuck", "shit", "bitch", "faggot", "retard", "whore", "killyourself", "molest", "asshole"];

// Prompt-injection phrasing. Checked on the raw lower-case text, the normalised text and the squashed text.
const INJECTION = [
  "ignore previous", "ignore prior", "ignore all", "ignore the above", "ignore your instructions", "ignore your rules", "ignore your prompt", "ignore every",
  "disregard", "system prompt", "you are now", "new instructions", "new rule", "developer mode", "jailbreak", "reveal your", "your instructions",
  "your prompt", "your rules", "your system", "repeat the text", "repeat the above", "repeat everything",
  "as an ai", "language model", "forget everything", "forget your instructions", "forget your rules", "forget all", "forget the rules", "override",
  "from now on you", "pretend you", "you must obey", "obey me", "do anything now", "dan mode", "act as if you", "roleplay as", "role play as",
  "prompt injection", "instruction:", "instructions:", "system:", "assistant:", "user:", "developer:", "api key", "password", "secret key",
  "```", "<system", "[system", "<|", "|>", "[inst", "<<sys", "###",
];
// Distinctive enough to also match with all spaces removed ("ignoreprevious", "i g n o r e  p r e v i o u s").
const INJECTION_SQUASHED = ["ignoreprevious", "ignoreprior", "ignoreall", "ignoretheabove", "ignoreyourinstructions", "ignoreyourrules", "disregardprevious", "disregardall", "disregardyour", "systemprompt", "newinstructions", "developermode", "jailbreak", "forgeteverything", "yourinstructions", "revealyour", "doanythingnow"];

const SPAM = [
  "airdrop", "giveaway", "crypto", "bitcoin", "btc", "usdt", "ethereum", "casino", "betting", "free money", "make money fast", "get rich", "forex",
  "work from home", "viagra", "cheap pills", "click here", "subscribe", "dm me", "telegram", "whatsapp", "discord",
  "onlyfans", "promo code", "follow me", "instagram", "snapchat", "tiktok", "facebook", "linkedin", "youtube", "free gift card", "limited offer", "act now",
];
// Asking to be contacted off-site.
const CONTACT_PHRASES = ["text me", "email me", "e mail me", "mail me", "my number", "my phone", "my email", "my handle", "hit me up", "add me on", "find me on", "contact me", "message me", "reach me at"];

const EMAIL = /[a-z0-9._%+-]+\s*(@|\(at\)|\[at\])\s*[a-z0-9.-]+\s*(\.|\(dot\)|\[dot\])\s*[a-z]{2,}/i;
const SPELLED_EMAIL = /\b[a-z0-9._-]+ (at|@) [a-z0-9-]+ (dot|\.) [a-z]{2,}\b/;
const DOT_TLD = /\bdot (com|net|org|io|xyz|ru|me|co|gg|ly|app|dev|uk|de|info|biz|shop|store|top|tech|club|live|site|online|link|ai|tv|fm)\b/;
const PHONE = /(\+?\d[\d\s().-]{8,}\d)/;
const NUMBER_WORDS = /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten)\b[\s,.-]*){7,}/;
const URLISH = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io|xyz|ru|me|co|gg|ly|app|dev|uk|de|info|biz|tk|link|click|site|online|shop|store|top|tech|club|live|fun|space|pro|website|cloud|page|today|news|world|life|blog|one|vip|ai|sh|ws|tv|fm|cn|in|us|ca|au|fr|it|nl|br|example|test|invalid|local|onion)\b|\b(t\.me|bit\.ly|wa\.me|discord\.gg)\b)/i;
const ADDRESS = /\b\d{1,5}\s+[a-z]+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr|blvd)\b/i;
const HANDLE = /(^|\s)@[a-z0-9_]{3,}/i;

// English only (for now). The word lists above are English, so other languages would sail straight past them.
const STOP = new Set(("the a an and or but is are was were be been i you he she it we they me my your his her our their to of in on at for with this that these those " +
  "hi hello hey thanks thank please not no yes do does did have has had will can so if as by from what how when who there here just like love good nice very too up out " +
  "never always sometimes some all any each every more most other than then them us am about into over under after before again also only own same such both few would could should may might must shall because while where which why now back down off once its into over about through today tonight tomorrow yesterday").split(" "));
// Common words of French, Spanish, Italian, Portuguese, German and Dutch that are not English words.
const FOREIGN = new Set(("bonjour bonsoir merci ami amie amis amigo amiga amigos hola gracias buenos buenas dias noches ciao grazie obrigado obrigada voce tudo muito und ich nicht ist wie geht dir mein meine " +
  "nein danke bitte hallo guten une est vous nous les des pour avec sans oui soy estoy esta como mucho quiero gustaria que por para del los las una pero muy mio mia meu minha nao sim uma ein eine " +
  "mit auch noch sehr jag och att een niet comment tres beaucoup aujourd hui cette tout bien donde cuando porque hoy ahora").split(" "));

export function looksEnglish(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return true; // numbers, emoji, punctuation
  if (letters.some((ch) => !/\p{Script=Latin}/u.test(ch))) return false; // Cyrillic, Arabic, CJK, Greek, ...
  const accented = letters.filter((ch) => ch.charCodeAt(0) > 127).length;
  if (accented / letters.length > 0.1) return false; // heavily accented Latin text is almost never English
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length >= 5 && !words.some((w) => STOP.has(w))) return false; // Latin script, no English function words
  const foreign = words.filter((w) => FOREIGN.has(w)).length;
  if (foreign >= 2 || (foreign >= 1 && words.length >= 2 && !words.some((w) => STOP.has(w)))) return false;
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
  return stems.some((st) => padded.includes(` ${st}`)) || hay.split(" ").some((w) => EXACT.includes(w));
}

export const MAX_CHECK_LENGTH = 4000;

export function checkText(raw: unknown, opts: { allowEmpty?: boolean } = {}): Verdict {
  const text = stripInvisible(typeof raw === "string" || typeof raw === "number" ? String(raw) : "").trim();
  if (!text) return opts.allowEmpty ? { ok: true, text: "" } : { ok: false, reason: "empty" };
  if (text.length > MAX_CHECK_LENGTH) return { ok: false, reason: "spam" }; // callers slice first; this is only a backstop

  if (!looksEnglish(text)) return { ok: false, reason: "language" };

  const extra = extraWords();
  const stems = [...STEMS, ...extra];
  for (const one of ["i", "l"] as const) {
    const n = normalize(text, one);
    const squashed = n.replace(/ /g, "");
    const lowered = text.toLowerCase();
    if (EMAIL.test(text) || PHONE.test(text) || URLISH.test(text) || ADDRESS.test(text) || HANDLE.test(text)) return { ok: false, reason: "contact" };
    if (SPELLED_EMAIL.test(n) || DOT_TLD.test(n) || NUMBER_WORDS.test(n) || CONTACT_PHRASES.some((p) => ` ${n} `.includes(` ${p} `))) return { ok: false, reason: "contact" };

    const joins = splitJoins(n);
    // Words are matched anywhere inside; split-up words ("fu ck") only from their start. Never the whole text squashed ("a bit chilly" is not "bitch").
    const words = n.replace(/shiitake/g, "mushroom").split(" ");
    const pieces = words;
    if (hasStem(n, stems) || joins.some((j) => hasStem(j, stems))) return { ok: false, reason: "unkind" };
    const long = [...LONG, ...extra].map((w) => w.replace(/ /g, ""));
    if (pieces.some((p) => long.some((w) => p.includes(w))) || joins.some((j) => long.some((w) => j.startsWith(w)))) return { ok: false, reason: "unkind" };
    if (pieces.some((p) => COLLAPSED.some((w) => collapse(p).includes(collapse(w)))) || joins.some((j) => COLLAPSED.some((w) => collapse(j).startsWith(collapse(w))))) return { ok: false, reason: "unkind" };

    if (/\bsudo\b/.test(n) || INJECTION.some((p) => lowered.includes(p) || n.includes(p)) || INJECTION_SQUASHED.some((p) => squashed.includes(p))) return { ok: false, reason: "injection" };
    if (SPAM.some((p) => n.includes(p))) return { ok: false, reason: "spam" };
  }

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
