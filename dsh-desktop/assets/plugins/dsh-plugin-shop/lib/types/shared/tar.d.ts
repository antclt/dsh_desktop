/** A read-only ustar parser: the npm transport's only way into a tarball.
 *
 * Pure — bytes in, a path-to-bytes map out. It handles exactly what `npm
 * pack` emits and refuses everything else loudly, because the alternative to
 * a small strict reader is a fourth runtime dependency (design §4). */
/**
 * Parse an uncompressed tar archive into path → bytes.
 *
 * Directory entries and every non-regular type (symlinks, pax and GNU
 * extension headers) are skipped: npm packs regular files under `package/`,
 * and a catalog tarball that needs anything else is not one we published.
 */
export declare function readTar(buffer: Buffer): Map<string, Buffer>;
