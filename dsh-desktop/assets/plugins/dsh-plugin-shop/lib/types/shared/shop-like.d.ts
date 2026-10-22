/**
 * Whether a package name reads as a competing plugin marketplace.
 *
 * Shared on purpose. The registry needs it to pick which newly harvested names
 * to send for a market verdict, and the client needs it to hide the ones no
 * verdict has reached yet. When each had a copy they drifted — that is exactly
 * how the shelf came to disagree with its own count — so there is one.
 *
 * It lives under the published package rather than beside the registry because
 * the dependency can only point this way: the package's tsconfig pins
 * `rootDir: "src"`, so nothing outside it can be imported, while the registry
 * scripts are internal and may reach in.
 *
 * This is a NAME heuristic and nothing more. It cannot tell a plugin that
 * stores tea from one that sells plugins — on the live catalog it caught 73
 * names of which 20 were innocent — so `registry/markets.yml` carries the
 * verdict per name and overrides it either way.
 *
 * @module shared/shop-like
 */
/**
 * Whether a package name reads as a plugin shop (a marketplace for dsh
 * plugins, e.g. `dsh-plugin-shop`, `dsh-store`, `pluginstore`). The shop
 * tab hides these so the market does not list competing markets.
 *
 * Precision over recall: a name merely CONTAINING a keyword segment without
 * a plugin qualifier or a keyword ending (`market-data-provider`,
 * `marketplace-hub`) is NOT a shop plugin, and `dsh-restore` must never
 * match on the substring "store". The keyword list keeps "store" on purpose:
 * it matches other people's package names, not ours.
 */
export declare function isShopLike(name: string): boolean;
