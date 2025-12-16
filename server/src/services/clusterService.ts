export interface ClusterCandidate {
  tweetId: string;
  summary: string;
  importance: number;
  verdict: string;
  tags: string[];
  tweetedAt: number;
  tweetUrl: string;
  suggestions?: string | null;
  vector: number[];
}

export interface ClusterResult {
  id: string;
  size: number;
  peakImportance: number;
  tags: string[];
  memberTweetIds: string[];
  representative: ClusterCandidate;
  centroid: number[];
}

function dot(a: number[], b: number[]) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function normalize(v: number[]) {
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) {
    const value = v[i] ?? 0;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) {
    return v.map(() => 0);
  }
  return v.map((value) => (value ?? 0) / norm);
}

function sumInto(acc: number[], v: number[]) {
  const n = Math.max(acc.length, v.length);
  for (let i = 0; i < n; i += 1) {
    acc[i] = (acc[i] ?? 0) + (v[i] ?? 0);
  }
  return acc;
}

function primaryTag(tags: string[]) {
  return tags.find((tag) => Boolean(tag?.trim()))?.trim().toLowerCase() ?? 'others';
}

function intersectTags(a: string[], b: string[]) {
  if (!a.length || !b.length) return false;
  const set = new Set(a.map((tag) => tag.trim().toLowerCase()).filter(Boolean));
  return b.some((tag) => set.has(tag.trim().toLowerCase()));
}

function mergeTags(candidates: ClusterCandidate[]) {
  const counts = new Map<string, number>();
  candidates.forEach((candidate) => {
    candidate.tags.forEach((tag) => {
      const key = tag.trim().toLowerCase();
      if (!key) return;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
}

export function clusterByEmbedding(
  candidates: ClusterCandidate[],
  options: { threshold: number; crossTagThresholdBump?: number }
): ClusterResult[] {
  const threshold = options.threshold;
  const crossTagThreshold = Math.min(0.98, threshold + (options.crossTagThresholdBump ?? 0.05));
  const ordered = [...candidates].sort((a, b) => {
    const imp = b.importance - a.importance;
    if (imp !== 0) return imp;
    return b.tweetedAt - a.tweetedAt;
  });

  const clusters: Array<{
    id: string;
    members: ClusterCandidate[];
    memberTweetIds: string[];
    peakImportance: number;
    representative: ClusterCandidate;
    centroidSum: number[];
    centroid: number[];
    primaryTag: string;
    tags: string[];
  }> = [];

  ordered.forEach((candidate, idx) => {
    const vector = normalize(candidate.vector);
    const candidatePrimary = primaryTag(candidate.tags);
    let bestIndex = -1;
    let bestScore = -1;

    for (let i = 0; i < clusters.length; i += 1) {
      const cluster = clusters[i];
      if (!cluster) continue;

      const hasTagOverlap = candidatePrimary === cluster.primaryTag || intersectTags(candidate.tags, cluster.tags);
      const required = hasTagOverlap ? threshold : crossTagThreshold;
      const score = dot(vector, cluster.centroid);
      if (score < required) continue;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex < 0) {
      const id = `c${idx + 1}`;
      clusters.push({
        id,
        members: [{ ...candidate, vector }],
        memberTweetIds: [candidate.tweetId],
        peakImportance: candidate.importance,
        representative: { ...candidate, vector },
        centroidSum: [...vector],
        centroid: [...vector],
        primaryTag: candidatePrimary,
        tags: [...candidate.tags]
      });
      return;
    }

    const target = clusters[bestIndex];
    if (!target) return;
    target.members.push({ ...candidate, vector });
    target.memberTweetIds.push(candidate.tweetId);
    target.peakImportance = Math.max(target.peakImportance, candidate.importance);
    if (
      candidate.importance > target.representative.importance ||
      (candidate.importance === target.representative.importance && candidate.tweetedAt > target.representative.tweetedAt)
    ) {
      target.representative = { ...candidate, vector };
    }
    sumInto(target.centroidSum, vector);
    target.centroid = normalize(target.centroidSum);
    target.tags = mergeTags(target.members);
  });

  const results: ClusterResult[] = clusters.map((cluster) => ({
    id: cluster.id,
    size: cluster.memberTweetIds.length,
    peakImportance: cluster.peakImportance,
    tags: cluster.tags,
    memberTweetIds: cluster.memberTweetIds,
    representative: cluster.representative,
    centroid: cluster.centroid
  }));

  results.sort((a, b) => {
    const imp = b.peakImportance - a.peakImportance;
    if (imp !== 0) return imp;
    if (b.size !== a.size) return b.size - a.size;
    return b.representative.tweetedAt - a.representative.tweetedAt;
  });

  return results;
}
