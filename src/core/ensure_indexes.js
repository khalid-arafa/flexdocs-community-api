const Logger = require("../utils/logger");

// In-memory cache for index checks. Bounded so a flood of distinct queries
// (each producing a unique cache key) can't grow it without limit (memory DoS).
const INDEX_CACHE_MAX = 5000;
const indexCache = new Set();

function rememberIndexKey(key) {
  // Simple FIFO eviction: drop the oldest entry once at capacity.
  if (indexCache.size >= INDEX_CACHE_MAX) {
    const oldest = indexCache.values().next().value;
    indexCache.delete(oldest);
  }
  indexCache.add(key);
}

/**
 * Describes the *shape* of a request — which fields are filtered and how the
 * result is sorted — rather than the values being matched.
 *
 * The key used to embed the query values, so `{email: "a@b.c"}` and
 * `{email: "x@y.z"}` were distinct entries. A lookup endpoint therefore issued
 * a `listIndexes` round-trip on essentially every request and evicted its own
 * entries, so the cache never did the job it existed for. Only the field names
 * and sort directions affect which index is needed.
 */
function indexCacheKey(namespace, queryFields, sortFields, sort) {
  const sortPart = sortFields.map((field) => `${field}:${sort[field]}`).join(",");
  return `${namespace}|${queryFields.join(",")}|${sortPart}`;
}

/**
 * Field names of a filter, normalized.
 *
 * Sorted because a filter is a conjunction — key order is an artifact of how
 * the caller happened to build the object, and leaving it unsorted meant the
 * same logical query serialized two ways produced two different indexes.
 * Sort fields are deliberately *not* sorted: their order is semantically
 * significant.
 */
function normalizedQueryFields(query) {
  return Object.keys(query)
    .filter((field) => field !== "_id")
    .sort();
}

async function ensureIndexes({
  collection,
  query = {},
  sort = {},
  canCreateIndexes = false,
}) {
  if (!canCreateIndexes) return;

  const queryFields = normalizedQueryFields(query);
  const sortFields = Object.keys(sort);
  const cacheKey = indexCacheKey(
    collection.namespace,
    queryFields,
    sortFields,
    sort,
  );

  // If already checked, skip
  if (indexCache.has(cacheKey)) return;

  try {
    // Get existing indexes first
    const existingIndexes = await collection.indexes();

    let indexToCreate = null;

    // Create compound index if we have both query and sort
    if (queryFields.length > 0 && sortFields.length > 0) {
      const mainQueryField = queryFields[0];
      const mainSortField = sortFields[0];

      if (mainQueryField !== mainSortField) {
        indexToCreate = {
          [mainQueryField]: 1,
          [mainSortField]: sort[mainSortField],
        };
      } else {
        indexToCreate = { [mainQueryField]: sort[mainSortField] };
      }
    }
    // If only query fields, index on primary query field
    else if (queryFields.length > 0) {
      indexToCreate = { [queryFields[0]]: 1 };
    }
    // If only sort fields, index on sort field with direction
    else if (sortFields.length > 0) {
      indexToCreate = { [sortFields[0]]: sort[sortFields[0]] };
    }

    if (!indexToCreate) {
      rememberIndexKey(cacheKey);
      return;
    }

    const indexFields = Object.keys(indexToCreate);

    // Check if we already have a compatible index
    const hasCompatibleIndex = existingIndexes.some((existingIndex) => {
      const existingIndexKeys = Object.keys(existingIndex.key);

      // Same fields in same order case
      if (JSON.stringify(existingIndexKeys) === JSON.stringify(indexFields)) {
        return true;
      }

      // For single field indexes, direction doesn't matter for equality queries
      if (
        indexFields.length === 1 &&
        existingIndexKeys.includes(indexFields[0]) &&
        existingIndexKeys.length === 1 &&
        !sortFields.includes(indexFields[0])
      ) {
        return true;
      }

      // For compound indexes, check if there's a prefix match
      if (existingIndexKeys.length >= indexFields.length) {
        const isPrefix = indexFields.every(
          (field, i) => field === existingIndexKeys[i],
        );
        return isPrefix;
      }

      return false;
    });

    // Create index only if we don't have a compatible one
    if (!hasCompatibleIndex) {
      await collection.createIndex(indexToCreate);
      Logger.info(`Created index: ${JSON.stringify(indexToCreate)} on ${collection.namespace}`);
    }

    // Add to cache after checking/creating
    rememberIndexKey(cacheKey);
  } catch (error) {
    if (error.codeName === "NamespaceNotFound") return;
    Logger.error(error.message, { stack: error.stack });
  }
}

// Optional: Function to clear cache (useful for testing or if indexes are dropped manually)
function clearIndexCache() {
  indexCache.clear();
}

// Optional: Function to remove specific cache entry
function removeFromIndexCache(collection, query = {}, sort = {}) {
  indexCache.delete(
    indexCacheKey(
      collection.namespace,
      normalizedQueryFields(query),
      Object.keys(sort),
      sort,
    ),
  );
}

module.exports = ensureIndexes;
module.exports.clearIndexCache = clearIndexCache;
module.exports.removeFromIndexCache = removeFromIndexCache;
