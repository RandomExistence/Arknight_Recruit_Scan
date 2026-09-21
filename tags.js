/**
 * tags.js
 *
 * The closed vocabulary of Arknights recruitment tags, plus a small
 * fuzzy-matching helper used to find those tags inside noisy OCR text.
 *
 * Exposed as `window.RecruitTags` in the browser, and as `module.exports`
 * under Node (so the matcher can be sanity-checked outside the browser).
 */
(function (global) {
  "use strict";

  // The complete, fixed list of recruitment tags from the game.
  const ALL_TAGS = [
    "Starter", "Senior Operator", "Top Operator",
    "Melee", "Ranged",
    "Caster", "Defender", "Guard", "Medic", "Sniper", "Specialist", "Supporter", "Vanguard",
    "AoE", "Crowd-Control", "DP-Recovery", "DPS", "Debuff", "Defense", "Elemental",
    "Fast-Redeploy", "Healing", "Nuker", "Robot", "Shift", "Slow", "Summon", "Support", "Survival"
  ];

  // How generous the matcher is: the fraction of a tag's own (normalized)
  // length that's allowed as OCR edit-distance noise before it stops
  // counting as a match. Range (0, 1]. Tweakable live from the app's
  // Advanced Settings panel (app.js); this is just the fallback default
  // used whenever no explicit value is passed in.
  const DEFAULT_OCR_GENEROSITY = 0.22;

  /**
   * Normalize a raw string for matching: uppercase, strip anything that
   * isn't a letter/space/hyphen, and collapse repeated whitespace.
   */
  function normalize(str) {
    return String(str || "")
      .toUpperCase()
      .replace(/[^A-Z\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const NORM_TAGS = ALL_TAGS.map((tag) => ({ tag, norm: normalize(tag) }));

  /** Classic Levenshtein edit distance between two strings. */
  function levenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1, // deletion
          curr[j - 1] + 1, // insertion
          prev[j - 1] + cost // substitution
        );
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }
    return prev[n];
  }

  /**
   * How many edits we tolerate for a tag of a given normalized length,
   * at a given generosity (defaults to DEFAULT_OCR_GENEROSITY).
   */
  function allowedEdits(len, generosity) {
    const g =
      typeof generosity === "number" && generosity > 0
        ? generosity
        : DEFAULT_OCR_GENEROSITY;
    return Math.max(1, Math.round(len * g));
  }

  /**
   * Best (smallest) edit distance between `needleNorm` and any contiguous
   * run of words in `haystackWords`. The window sizes tried are based on
   * the needle's own word count (+/- 1), so a tag can still be found if
   * OCR fuses or splits words differently than the source string.
   */
  function bestWindowDistance(needleNorm, haystackWords) {
    const needleWordCount = needleNorm.split(" ").length;
    const spans = new Set([
      Math.max(1, needleWordCount - 1),
      needleWordCount,
      needleWordCount + 1,
    ]);

    let best = Infinity;
    for (const span of spans) {
      for (let i = 0; i + span <= haystackWords.length; i++) {
        const window = haystackWords.slice(i, i + span).join(" ");
        const dist = levenshtein(needleNorm, window);
        if (dist < best) best = dist;
      }
    }
    return best;
  }

  /**
   * Scan raw OCR text for occurrences of known recruitment tags.
   *
   * `options.generosity` (0-1] overrides DEFAULT_OCR_GENEROSITY for this
   * call — pass the live value from the Advanced Settings panel.
   *
   * Returns an array of { tag, distance } sorted best-match-first,
   * limited to tags whose best match is within the allowed edit budget.
   */
  function findMatches(rawText, options) {
    const generosity =
      options && typeof options.generosity === "number"
        ? options.generosity
        : DEFAULT_OCR_GENEROSITY;

    const norm = normalize(rawText);
    if (!norm) return [];
    const words = norm.split(" ").filter(Boolean);
    if (words.length === 0) return [];

    const results = [];
    for (const { tag, norm: tagNorm } of NORM_TAGS) {
      const dist = bestWindowDistance(tagNorm, words);
      if (dist <= allowedEdits(tagNorm.length, generosity)) {
        results.push({ tag, distance: dist });
      }
    }
    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  const RecruitTags = {
    ALL_TAGS,
    DEFAULT_OCR_GENEROSITY,
    normalize,
    levenshtein,
    findMatches,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = RecruitTags;
  }
  if (global) {
    global.RecruitTags = RecruitTags;
  }
})(typeof window !== "undefined" ? window : globalThis);
