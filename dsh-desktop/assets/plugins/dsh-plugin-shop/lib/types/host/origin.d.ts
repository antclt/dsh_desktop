/** The transport seam under `loadCatalog` (design §3).
 *
 * An origin answers a cheap probe, then serves the pointer and the files the
 * pointer names. HTTP and npm are interchangeable behind it, so every line of
 * cache and validation logic in `catalog.ts` stays transport-blind. */
/** A failure of the link, not of the content: the wire threw, or answered
 * non-2xx. This is the ONLY class `loadCatalog` retries on another origin.
 * A bad schema, a sha mismatch, or a refused url is an interpretation
 * failure and throws — masking a corrupt origin behind a healthy one is
 * exactly the silent-wrongness this project refuses. */
export declare class TransportError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export interface OriginHandle {
    readonly id: string;
    /** The pointer JSON text. Cheap: the probe has already paid for it. */
    pointer: () => Promise<string>;
    /** One file named by the pointer, by the pointer's own raw url string.
     * Callers pass that string verbatim — never a basename, which would strip
     * a hostile absolute url into a fetchable relative one. */
    file: (url: string, signal?: AbortSignal) => Promise<string>;
}
export interface CatalogOrigin {
    readonly id: string;
    /** Cheap reachability + identity request. Resolving means this origin can
     * serve; the expensive work happens on the returned handle. */
    probe: (signal: AbortSignal) => Promise<OriginHandle>;
}
/** Resolve the pointer's data URL against the catalog base. An absolute URL —
 * any scheme, or a protocol-relative `//host/...` — would hand the pointer a
 * fetch primitive to arbitrary hosts, so it is refused loudly before any
 * fetch (§9.2). The guard is the resolved origin, not the raw string: WHATWG
 * normalization strips leading whitespace and accepts backslash spellings
 * before the string could be inspected, so only comparing the resolved URL's
 * origin to the base's closes every spelling class. */
export declare function resolveDataUrl(baseUrl: string, url: string): string;
/** The largest catalog body this host reads into memory. */
export declare const MAX_BODY_BYTES: number;
/** Read a response body through a byte cap, converting transport failures. */
export declare function readCappedBytes(response: Response, label: string, maxBytes?: number): Promise<Buffer>;
/** Read a capped response body as UTF-8 text. */
export declare function readCappedText(response: Response, label: string, maxBytes?: number): Promise<string>;
/** The transport this project has always used: a static `v1/` tree. */
export declare function httpOrigin(baseUrl: string, fetchImpl: typeof fetch): CatalogOrigin;
