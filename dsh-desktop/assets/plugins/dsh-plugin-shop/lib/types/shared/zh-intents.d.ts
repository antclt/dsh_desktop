/**
 * The Chinese → English query dictionary whose expansion the shelf search
 * applies (design `2026-10-08-search-query-expansion.md` §2–§4, borrowing C2
 * from `2026-09-26-market-borrowings.md`; reference: 2BingLing/dsh-market's
 * `plugin/core/src/zh-intent.ts`).
 *
 * The dictionary is a curated DATA table, not code. It lives here, in
 * `src/shared/` (mirroring `src/shared/identity.ts`), because the seam is
 * one shared filter module and a later consumer in `host/` should not have
 * to change paths to use it; today the only caller is `client/present.ts`.
 *
 * One intent is `{ key, words, terms }`:
 * - `words` are the Chinese trigger phrases. A query containing any of them,
 *   as a lowercase substring, fires the intent. They are always ≥ 2 Han
 *   characters so a stray Han in an English query never fires one.
 * - `terms` are the recall vocabulary scanned against each entry's name,
 *   `summary.en`, `summary.zh` and category key. A term prefixed with `#`
 *   is matched on a WORD BOUNDARY, not as a substring: `#ai` refuses to
 *   fire on `email`, `main`, `pipeline` and fires on `ai-chat`, `AI聊天`.
 *   The marker exists because, without it, 2BingLing measured 713 false
 *   `ai` hits in 9,145 entries; on our own 2026-10-08 catalog (14,167
 *   entries), `#ai` holds `AI大模型` to 2,760 hits instead of the many
 *   thousand the bare token would match.
 *
 * Credit: the trigger-to-recall structure, the `#` boundary marker, and
 * the "curated, defensive, every-term-measured" discipline are all from
 * 2BingLing/dsh-market's `zh-intent.ts`, read live 2026-10-08. The
 * dictionary's rows are our own, trimmed from theirs against the live
 * catalog (`2026-10-08-search-query-expansion.md` §3): the four intents
 * their data also shows to be dead in our ecosystem (`农历节日`, `Twitter`,
 * `微博`, `Notion`) were dropped because their marginal recall was 3 to 7.
 */
/** One curated intent. UI surfaces name `key` when they cite the expansion. */
export interface ZhIntent {
    /** The intent's label, always a short Chinese phrase. */
    key: string;
    /** Trigger words: any substring match on the lowercased query fires it. */
    words: readonly string[];
    /**
     * Recall terms: any substring match (or word-boundary match, for a term
     * prefixed with `#`) on the lowercased entry fields recalls that entry.
     */
    terms: readonly string[];
}
/**
 * The recall side of an intent that fired for a query.
 *
 * The result is always deduplicated and ordered by the dictionary's rows;
 * the query itself, lowercased, is always the FIRST element of `terms`, so
 * the 18 author-written `summary.zh` entries today are always reachable
 * through the raw query and never depend on a dictionary expansion.
 */
export interface ZhExpansion {
    /** The user's query, trimmed and lowercased. */
    query: string;
    /** The intent keys that fired, in dictionary order. */
    intents: readonly string[];
    /** The fired intents with their surviving recall terms, deduplicated. */
    expansions: readonly {
        intent: string;
        terms: readonly string[];
    }[];
    /** Every recall term, deduplicated, query first. */
    terms: readonly string[];
}
export declare function tokenInText(term: string, text: string): boolean;
/**
 * The curated dictionary. Ordered by design §3's measured marginal recall
 * (largest first). Rows trimmed from 2BingLing's eighty-four to eighty by
 * dropping the four whose marginal recall on the 2026-10-08 catalog was
 * single-digit: `农历节日`, `Twitter`, `微博`, `Notion`.
 *
 * To add a row: write the intent's key in Chinese, its triggers (≥ 2 Han
 * characters each, as a defensive rule, so an isolated Han inside someone
 * else's name never fires the intent), its recall terms with `#` where a
 * bare short Latin term would otherwise act like a substring, and one
 * comment line pointing at this document's measured table.
 */
export declare const ZH_INTENTS: readonly ZhIntent[];
/**
 * Fire every intent whose trigger appears in the query (lowercase, substring),
 * deduplicate the recall vocabulary, and return the query itself first.
 *
 * The call site never has to know whether expansion happened: `terms` is
 * always at least `[query]`. The caller joins these with OR against each
 * entry's searchable fields, in the same `includes`/`tokenInText` grammar
 * as the raw query.
 */
export declare function expandZhQuery(rawQuery: string): ZhExpansion;
