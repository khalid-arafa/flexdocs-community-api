/**
 * Shared TTL cache for project documents.
 *
 * Two callers need the same thing and each used to carry its own copy of the
 * logic: projectApiAuth (once per REST request) and the change-stream driver
 * (once per oplog event). Both key by project code, both back a lookup that
 * only changes when an admin edits the project, and both were invalidated by
 * the same write sites — but only one of them had the TOCTOU guard and the
 * bound, so the other quietly drifted into being the weaker implementation.
 *
 * Invalidation is primarily EXPLICIT, not time-based: every write site in
 * system/projects.routes.js calls invalidateProjectCache(code) right after the
 * write, so an admin's change is visible on their very next request. The TTL
 * is only a backstop for a write path we missed (or one added later that
 * nobody wired up) — deliberately short, so a forgotten invalidation degrades
 * into "stale for at most one TTL", not "stale forever". A stale project
 * document means stale rules and stale credentials, so that distinction is
 * security-relevant, not just a freshness nicety.
 *
 * What is deliberately NOT here: single-flight/request-coalescing. Two
 * concurrent misses for the same key each run their own fetch. Coalescing them
 * would mean a second request joining a fetch that started BEFORE an
 * invalidation and inheriting its pre-write answer — exactly the staleness the
 * generation guard below exists to prevent.
 */

const DEFAULT_TTL_MS = 30 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

class ProjectDocCache {
  /**
   * @param {object}   [options]
   * @param {number}   [options.ttlMs]       backstop lifetime of an entry.
   * @param {number}   [options.maxEntries]  hard bound; oldest entries evicted first.
   * @param {boolean}  [options.cacheMisses] also memoise "no such project" as null.
   *                     The change-stream driver needs this — it sees every
   *                     database on the cluster, including ones that are not
   *                     FlexDocs projects, and without it every write to one
   *                     would re-query the projects collection. The request
   *                     path deliberately does NOT: a project created moments
   *                     ago must be usable immediately rather than waiting out
   *                     a negative-cache TTL.
   * @param {Function} [options.clone]       applied to every value handed out, so a
   *                     caller mutating what it got can never corrupt the entry
   *                     the next caller reads back. Callers that only forward
   *                     the document (the change-stream driver) omit it and
   *                     share the instance.
   */
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    cacheMisses = false,
    clone = null,
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.cacheMisses = cacheMisses;
    this.cloneValue = clone;

    this.entries = new Map(); // key -> { doc, expiresAt }

    // Closes a narrow TOCTOU window: a caller that reads the project doc from
    // Mongo just before a credential rotation commits, then tries to populate
    // the cache just AFTER invalidate() already ran for that write, would
    // otherwise overwrite the fresh (empty) slot with what it fetched —
    // serving stale credentials for up to a full TTL. Stamped on every
    // invalidation, checked before every populate: if the stamp moved while a
    // fetch was in flight, that fetch's result is used for this caller only
    // and never cached, so the next lookup re-fetches instead of trusting it.
    //
    // The stamp is a monotonic counter rather than a per-key count, so a stamp
    // can never be re-issued and mistaken for an older one.
    //
    // That alone is not enough, because this map is bounded too and a prune
    // DESTROYS a stamp: a key whose stamp was pruned reads back as 0 — which is
    // exactly what a never-invalidated key reads as, so an in-flight fetch that
    // recorded 0 before the invalidation would see 0 again afterwards and
    // happily cache its pre-write document. pruneEpoch closes that: it counts
    // stamps discarded, and any fetch that spans a prune is treated as
    // unverifiable and simply not cached. Prunes only happen once the stamp map
    // is at capacity, so the cost is a rare extra read, and the failure mode is
    // a needless re-fetch rather than a stale document.
    this.generations = new Map(); // key -> tick at last invalidation
    this.tick = 0;
    this.pruneEpoch = 0;
  }

  /**
   * Reads through the cache, fetching on a miss.
   * @param {string} key
   * @param {Function} fetch async () => doc|null
   */
  async getOrFetch(key, fetch) {
    const cached = this.entries.get(key);
    if (cached) {
      if (cached.expiresAt > Date.now()) return this.#handOut(cached.doc);
      this.entries.delete(key); // expired backstop entry
    }

    const generationAtFetchStart = this.generations.get(key) || 0;
    const pruneEpochAtFetchStart = this.pruneEpoch;
    const doc = (await fetch()) || null;

    if (doc !== null || this.cacheMisses) {
      const generationNow = this.generations.get(key) || 0;
      const stampStillTrustworthy = this.pruneEpoch === pruneEpochAtFetchStart;
      if (stampStillTrustworthy && generationNow === generationAtFetchStart) {
        this.#store(key, doc);
      }
    }

    // Handed out through the same clone step as a cache hit, so the caller can
    // never hold the exact object that was just stored above.
    return this.#handOut(doc);
  }

  /**
   * Called synchronously right after every successful write to the project
   * document (see system/projects.routes.js). Deleting the entry — rather than
   * updating it in place — means the next lookup always re-fetches from Mongo
   * instead of risking a second stale copy being cached from a racing caller.
   */
  invalidate(key) {
    this.entries.delete(key);
    // delete-then-set keeps Map insertion order equal to stamp order, which is
    // what makes the prune below drop the least recently invalidated key.
    this.generations.delete(key);
    this.generations.set(key, ++this.tick);
    if (this.generations.size > this.maxEntries) {
      this.generations.delete(this.generations.keys().next().value);
      this.pruneEpoch += 1;
    }
  }

  /**
   * Drops every entry. Neither counter is reset: clear() destroys stamps just
   * as a prune does, so it bumps pruneEpoch for the same reason.
   */
  clear() {
    this.entries.clear();
    if (this.generations.size > 0) {
      this.generations.clear();
      this.pruneEpoch += 1;
    }
  }

  get size() {
    return this.entries.size;
  }

  #handOut(doc) {
    if (doc === null || !this.cloneValue) return doc;
    return this.cloneValue(doc);
  }

  #store(key, doc) {
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      this.#evict();
    }
    this.entries.set(key, { doc, expiresAt: Date.now() + this.ttlMs });
  }

  // Expired entries first — they are free to drop and are the common case for
  // a cache that filled up with one-off keys. Only if none are expired does a
  // live entry get evicted, oldest-inserted first.
  #evict() {
    const now = Date.now();
    let dropped = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        dropped = true;
      }
    }
    if (dropped) return;
    this.entries.delete(this.entries.keys().next().value);
  }
}

module.exports = { ProjectDocCache, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES };
