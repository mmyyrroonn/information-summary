/* eslint-disable no-console */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = new Map();
  for (const part of argv.slice(2)) {
    if (!part.startsWith('--')) continue;
    const [key, rawValue] = part.slice(2).split('=');
    args.set(key, rawValue ?? true);
  }
  return args;
}

function resolveInputPath(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') {
    throw new Error('missing --input=path/to/report.json');
  }
  return path.isAbsolute(rawInput) ? rawInput : path.resolve(process.cwd(), rawInput);
}

function extractTextSummaryPairs(report) {
  const cases = Array.isArray(report?.cases) ? report.cases : [];
  const rows = [];

  for (const c of cases) {
    const inputTweets = Array.isArray(c?.input?.tweets) ? c.input.tweets : [];
    const parsedItems = Array.isArray(c?.output?.parsed?.items) ? c.output.parsed.items : [];
    if (inputTweets.length === 0 || parsedItems.length === 0) continue;

    const tweetById = new Map();
    for (const t of inputTweets) {
      if (t && typeof t.tweetId === 'string' && t.tweetId) {
        tweetById.set(t.tweetId, t);
      }
    }

    for (const item of parsedItems) {
      const tweetId = item?.tweetId;
      if (typeof tweetId !== 'string' || !tweetId) continue;
      const source = tweetById.get(tweetId);
      if (!source) continue;

      rows.push({
        tag: c.tag,
        batchSize: c.batchSize,
        chunkIndex: c.chunkIndex,
        totalChunks: c.totalChunks,
        tweetId,
        author: source.author || '',
        handle: source.handle || '',
        text: source.text || '',
        summary: typeof item.summary === 'string' ? item.summary : '',
        verdict: typeof item.verdict === 'string' ? item.verdict : '',
        importance: typeof item.importance === 'number' ? item.importance : null,
        tags: Array.isArray(item.tags) ? item.tags.filter((x) => typeof x === 'string') : []
      });
    }
  }

  return rows;
}

function defaultOutputPath(inputPath) {
  const dir = path.dirname(inputPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `text-summary-pairs-${stamp}.json`);
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolveInputPath(args.get('input'));
  const outputArg = args.get('output');
  const outputPath =
    typeof outputArg === 'string' && outputArg
      ? (path.isAbsolute(outputArg) ? outputArg : path.resolve(process.cwd(), outputArg))
      : defaultOutputPath(inputPath);

  const raw = fs.readFileSync(inputPath, 'utf8');
  const report = JSON.parse(raw);
  const pairs = extractTextSummaryPairs(report);

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceReport: inputPath,
    totalPairs: pairs.length,
    pairs
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');

  console.log(`Saved ${pairs.length} pairs to:`);
  console.log(outputPath);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Failed:', error?.message || error);
    process.exit(1);
  }
}

module.exports = {
  extractTextSummaryPairs
};
