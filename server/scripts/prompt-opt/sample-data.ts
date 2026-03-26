/**
 * 从数据库采样测试数据，输出固定测试集 JSON
 *
 * Usage:
 *   npx ts-node --project scripts/prompt-opt/tsconfig.json scripts/prompt-opt/sample-data.ts \
 *     --type classification --count 30 --days 7
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

// 加载项目根目录的 .env
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

const prisma = new PrismaClient();

function parseArgs() {
  const args: Record<string, string> = {};
  for (const part of process.argv.slice(2)) {
    if (!part.startsWith('--')) continue;
    const eq = part.indexOf('=');
    if (eq > 0) {
      args[part.slice(2, eq)] = part.slice(eq + 1);
    } else {
      const key = part.slice(2);
      const next = process.argv[process.argv.indexOf(part) + 1];
      args[key] = next && !next.startsWith('--') ? next : 'true';
    }
  }
  return args;
}

async function sampleClassification(count: number, days: number, excludeFile?: string) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // 加载排除列表（用于泛化验证时排除训练集）
  let excludeIds = new Set<string>();
  if (excludeFile) {
    const excludePath = path.resolve(__dirname, excludeFile);
    if (fs.existsSync(excludePath)) {
      const excludeData = JSON.parse(fs.readFileSync(excludePath, 'utf-8'));
      excludeIds = new Set(excludeData.map((t: any) => t.tweetId));
      console.log(`  Excluding ${excludeIds.size} tweets from ${excludeFile}`);
    }
  }

  // 目标分布：偏重判断难度高的区间（importance 3-4），减少显而易见的噪音
  const targetPerLevel: Record<number, number> = { 1: 5, 2: 10, 3: 20, 4: 15, 5: 10 };
  // 泛化验证时按比例放大到 count
  const scale = count / 60;
  const scaledTarget: Record<number, number> = {};
  for (const [k, v] of Object.entries(targetPerLevel)) {
    scaledTarget[Number(k)] = Math.round(v * scale);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selected: any[] = [];

  // 分组查询，每个 importance 等级独立取样
  for (const [level, target] of Object.entries(scaledTarget)) {
    const imp = Number(level);
    const tweets = await prisma.tweet.findMany({
      where: {
        processedAt: { not: null },
        abandonedAt: null,
        insights: { importance: imp },
        tweetedAt: { gte: since },
        ...(excludeIds.size > 0 ? { tweetId: { notIn: [...excludeIds] } } : {}),
      },
      include: { insights: true },
      orderBy: { tweetedAt: 'desc' },
      take: target * 10, // 多取一些随机选
    });
    // 随机打乱后取目标数量
    const shuffled = tweets
      .filter((t) => t.insights !== null)
      .sort(() => Math.random() - 0.5);
    selected.push(...shuffled.slice(0, target));
    console.log(`  importance=${imp}: found ${tweets.length}, selected ${Math.min(shuffled.length, target)}`);
  }

  // 输出格式：只保留脚本需要的字段
  const output = selected.slice(0, count).map((t) => ({
    tweetId: t.tweetId,
    authorName: t.authorName,
    authorScreen: t.authorScreen,
    text: t.text,
    lang: t.lang,
    tweetUrl: t.tweetUrl,
    tweetedAt: t.tweetedAt.toISOString(),
    // 当前 baseline insight（用于对比）
    currentInsight: t.insights
      ? {
          verdict: t.insights.verdict,
          importance: t.insights.importance,
          summary: t.insights.summary,
          domain: t.insights.domain,
          tags: t.insights.tags,
        }
      : null,
  }));

  return output;
}

async function main() {
  const args = parseArgs();
  const type = args.type ?? 'classification';
  const count = Number(args.count) || 30;
  const days = Number(args.days) || 7;

  const exclude = args.exclude; // e.g. --exclude data/sample-classification.json
  console.log(`Sampling ${count} items for ${type}, last ${days} days...`);

  let data: unknown;
  if (type === 'classification') {
    data = await sampleClassification(count, days, exclude);
  } else {
    console.error(`Unknown type: ${type}. Supported: classification`);
    process.exit(1);
  }

  const outDir = path.resolve(__dirname, 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outName = args.output ?? `sample-${type}.json`;
  const outPath = path.resolve(outDir, outName);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

  const items = Array.isArray(data) ? data.length : 0;
  console.log(`Saved ${items} items to ${outPath}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
