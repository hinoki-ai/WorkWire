const SEARCH_RESULT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function normalizeSearch(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function createSearchIndex(entries = []) {
  const source = Array.isArray(entries) ? entries : [];
  const directoryCache = new Map();
  const records = source.map((entry, ordinal) => createSearchRecord(entry, ordinal, directoryCache));
  return {
    source,
    records,
    byPath: new Map(records.map((record) => [record.entry?.path, record.entry])),
  };
}

function createSearchRecord(entry, ordinal, directoryCache) {
  const normalizedName = normalizeSearch(entry?.name);
  const rawPath = String(entry?.path || "");
  const separator = Math.max(rawPath.lastIndexOf("/"), rawPath.lastIndexOf("\\"));
  const directoryPath = separator >= 0 ? rawPath.slice(0, separator) : "";
  let normalizedPath = directoryCache.get(directoryPath);
  if (normalizedPath === undefined) {
    normalizedPath = normalizeSearch(directoryPath);
    directoryCache.set(directoryPath, normalizedPath);
  }
  return {
    entry,
    ordinal,
    normalizedName,
    normalizedPath,
    nameWords: normalizedName.split(" ").filter(Boolean),
  };
}

export async function createSearchIndexAsync(entries = [], {
  batchSize = 1_000,
  shouldContinue = () => true,
  yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0)),
} = {}) {
  const source = Array.isArray(entries) ? entries : [];
  const records = new Array(source.length);
  const byPath = new Map();
  const directoryCache = new Map();
  const normalizedBatchSize = Math.max(100, Math.floor(Number(batchSize) || 1_000));
  for (let start = 0; start < source.length; start += normalizedBatchSize) {
    if (!shouldContinue()) return null;
    const end = Math.min(source.length, start + normalizedBatchSize);
    for (let ordinal = start; ordinal < end; ordinal += 1) {
      const record = createSearchRecord(source[ordinal], ordinal, directoryCache);
      records[ordinal] = record;
      byPath.set(record.entry?.path, record.entry);
    }
    await yieldTask();
  }
  return shouldContinue() ? { source, records, byPath } : null;
}

function boundedDistance(left, right, maximum = 2) {
  if (left === right) return 0;
  if (!left || !right) return Math.max(left.length, right.length) <= maximum
    ? Math.max(left.length, right.length)
    : maximum + 1;
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array(right.length + 1);
  for (let row = 1; row <= left.length; row += 1) {
    current.fill(maximum + 1);
    current[0] = row;
    const firstColumn = Math.max(1, row - maximum);
    const lastColumn = Math.min(right.length, row + maximum);
    let bestInRow = maximum + 1;
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      const insertion = current[column - 1] + 1;
      const deletion = previous[column] + 1;
      const distance = Math.min(substitution, insertion, deletion);
      current[column] = distance;
      bestInRow = Math.min(bestInRow, distance);
    }
    if (bestInRow > maximum) return maximum + 1;
    [previous, current] = [current, previous];
  }
  return previous[right.length] <= maximum ? previous[right.length] : maximum + 1;
}

function compileFuzzyToken(value) {
  if (value.length < 3 || value.length > 31) return { value, masks: null };
  const masks = new Map();
  for (let index = 0; index < value.length; index += 1) {
    masks.set(value[index], (masks.get(value[index]) || 0) | (1 << index));
  }
  return {
    value,
    masks,
    topBit: 1 << (value.length - 1),
  };
}

function bitParallelDistance(compiledToken, word) {
  let positive = -1;
  let negative = 0;
  let score = compiledToken.value.length;
  for (let index = 0; index < word.length; index += 1) {
    const equal = compiledToken.masks.get(word[index]) || 0;
    const combined = equal | negative;
    const horizontal = (((equal & positive) + positive) ^ positive) | equal;
    let positiveHorizontal = negative | ~(horizontal | positive);
    let negativeHorizontal = positive & horizontal;
    if (positiveHorizontal & compiledToken.topBit) score += 1;
    else if (negativeHorizontal & compiledToken.topBit) score -= 1;
    positiveHorizontal = (positiveHorizontal << 1) | 1;
    negativeHorizontal <<= 1;
    positive = negativeHorizontal | ~(combined | positiveHorizontal);
    negative = positiveHorizontal & combined;
  }
  return score;
}

function fuzzyWordDistance(compiledToken, words) {
  const token = compiledToken.value;
  if (token.length < 3) return 3;
  let best = 3;
  for (const word of words) {
    if (Math.abs(word.length - token.length) > 2) continue;
    const distance = compiledToken.masks
      ? bitParallelDistance(compiledToken, word)
      : boundedDistance(token, word, 2);
    if (distance < best) best = distance;
    if (best === 1) break;
  }
  return best;
}

function scoreRecord(record, compiledQuery) {
  const { normalized, tokens, fuzzyTokens } = compiledQuery;
  const { normalizedName: name, normalizedPath: path, nameWords } = record;
  const tokenMatches = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    const nameSubstring = name.includes(token);
    const pathSubstring = !nameSubstring && path.includes(token);
    const wordExact = nameWords.includes(token);
    const wordPrefix = !wordExact && nameWords.some((word) => word.startsWith(token));
    let fuzzy = 0;
    if (!nameSubstring && !pathSubstring) {
      fuzzy = fuzzyWordDistance(fuzzyTokens[tokenIndex], nameWords);
      if (fuzzy > 2) return null;
    }
    tokenMatches.push({
      nameSubstring,
      pathSubstring,
      wordExact,
      wordPrefix,
      fuzzy,
    });
  }

  const rank = name === normalized ? 0
    : name.startsWith(normalized) ? 1
      : tokenMatches.every((match) => match.wordExact || match.wordPrefix) ? 2
        : tokenMatches.every((match) => match.nameSubstring) ? 3
          : tokenMatches.every((match) => match.nameSubstring || match.pathSubstring) ? 4
            : 5;
  const matchScore = tokenMatches.reduce((total, match) => {
    if (match.wordExact) return total;
    if (match.wordPrefix) return total + 1;
    if (match.nameSubstring) return total + 2;
    if (match.pathSubstring) return total + 3;
    return total + 4 + match.fuzzy;
  }, 0);
  const score = matchScore + (rank === 5 ? Math.max(0, nameWords.length - 1) : 0);
  return {
    entry: record.entry,
    ordinal: record.ordinal,
    rank,
    score,
    tokens,
  };
}

export function compareSearchResults(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.score !== right.score) return left.score - right.score;
  const leftDirectory = left.entry?.kind === "directory";
  const rightDirectory = right.entry?.kind === "directory";
  if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
  const nameOrder = SEARCH_RESULT_COLLATOR.compare(
    String(left.entry?.name || ""),
    String(right.entry?.name || ""),
  );
  return nameOrder || left.ordinal - right.ordinal;
}

function insertLimited(results, candidate, limit) {
  let low = 0;
  let high = results.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareSearchResults(candidate, results[middle]) < 0) high = middle;
    else low = middle + 1;
  }
  if (low >= limit && results.length >= limit) return;
  results.splice(low, 0, candidate);
  if (results.length > limit) results.pop();
}

function compileQuery(query) {
  const normalized = normalizeSearch(query);
  if (!normalized) return null;
  const tokens = normalized.split(" ").filter(Boolean);
  return tokens.length
    ? { normalized, tokens, fuzzyTokens: tokens.map(compileFuzzyToken) }
    : null;
}

export function rankSearchIndex(index, query, limit = Infinity) {
  const compiledQuery = compileQuery(query);
  if (!compiledQuery) return [];
  const records = Array.isArray(index?.records) ? index.records : [];
  const limited = Number.isFinite(limit);
  const normalizedLimit = limited ? Math.max(0, Math.floor(limit)) : Infinity;
  if (normalizedLimit === 0) return [];
  const results = [];
  for (const record of records) {
    const scored = scoreRecord(record, compiledQuery);
    if (!scored) continue;
    if (limited) insertLimited(results, scored, normalizedLimit);
    else results.push(scored);
  }
  if (!limited) results.sort(compareSearchResults);
  return results;
}

function defaultYieldTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function cooperativeSortResults(results, {
  shouldContinue,
  yieldTask,
  runSize,
}) {
  if (results.length < runSize) {
    results.sort(compareSearchResults);
    return results;
  }
  for (let start = 0; start < results.length; start += runSize) {
    if (!shouldContinue()) return null;
    const end = Math.min(results.length, start + runSize);
    const run = results.slice(start, end).sort(compareSearchResults);
    for (let index = 0; index < run.length; index += 1) results[start + index] = run[index];
    await yieldTask();
  }

  let source = results;
  let destination = new Array(results.length);
  for (let width = runSize; width < results.length; width *= 2) {
    for (let start = 0; start < results.length; start += width * 2) {
      if (!shouldContinue()) return null;
      const middle = Math.min(start + width, results.length);
      const end = Math.min(start + (width * 2), results.length);
      let left = start;
      let right = middle;
      let output = start;
      while (left < middle && right < end) {
        if (compareSearchResults(source[left], source[right]) <= 0) {
          destination[output++] = source[left++];
        } else {
          destination[output++] = source[right++];
        }
      }
      while (left < middle) destination[output++] = source[left++];
      while (right < end) destination[output++] = source[right++];
      await yieldTask();
    }
    [source, destination] = [destination, source];
  }
  if (source !== results) {
    for (let index = 0; index < results.length; index += 1) results[index] = source[index];
  }
  return results;
}

export async function rankSearchIndexAsync(index, query, {
  batchSize = 1_000,
  runSize = 2_048,
  shouldContinue = () => true,
  yieldTask = defaultYieldTask,
} = {}) {
  const compiledQuery = compileQuery(query);
  if (!compiledQuery) return [];
  const records = Array.isArray(index?.records) ? index.records : [];
  const results = [];
  const normalizedBatchSize = Math.max(100, Math.floor(Number(batchSize) || 1_000));
  for (let start = 0; start < records.length; start += normalizedBatchSize) {
    if (!shouldContinue()) return null;
    const end = Math.min(records.length, start + normalizedBatchSize);
    for (let indexPosition = start; indexPosition < end; indexPosition += 1) {
      const scored = scoreRecord(records[indexPosition], compiledQuery);
      if (scored) results.push(scored);
    }
    await yieldTask();
  }
  if (!shouldContinue()) return null;
  return cooperativeSortResults(results, {
    shouldContinue,
    yieldTask,
    runSize: Math.max(256, Math.floor(Number(runSize) || 2_048)),
  });
}
