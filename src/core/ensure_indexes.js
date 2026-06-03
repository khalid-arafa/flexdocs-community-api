const Logger = require("../utils/logger");

// In-memory cache for index checks
const indexCache = new Set();

async function ensureIndexes({
  collection,
  query = {},
  sort = {},
  canCreateIndexes = false,
}) {
  if (!canCreateIndexes) return;

  // Create cache key from collection name + query + sort
  const cacheKey = `${collection.namespace}_${JSON.stringify(query)}_${JSON.stringify(sort)}`;

  // If already checked, skip
  if (indexCache.has(cacheKey)) return;

  try {
    // Get existing indexes first
    const existingIndexes = await collection.indexes();

    // Determine needed index
    const queryFields = Object.keys(query).filter((field) => field !== "_id");
    const sortFields = Object.keys(sort);

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
      indexCache.add(cacheKey);
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
    indexCache.add(cacheKey);
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
  const cacheKey = `${collection.namespace}_${JSON.stringify(query)}_${JSON.stringify(sort)}`;
  indexCache.delete(cacheKey);
}

module.exports = ensureIndexes;
module.exports.clearIndexCache = clearIndexCache;
module.exports.removeFromIndexCache = removeFromIndexCache;
