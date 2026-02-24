export interface ClusterVisibilityInput {
  peakImportance: number;
  size: number;
}

const IMPORTANCE_THREE_MIN_CLUSTER_SIZE = 2;
const IMPORTANCE_TWO_MIN_CLUSTER_SIZE = 3;

export function shouldKeepClusterByImportance(input: ClusterVisibilityInput): boolean {
  const peak = Math.floor(input.peakImportance);
  const size = Math.max(0, Math.floor(input.size));

  if (peak >= 4) return true;
  if (peak === 3) return size >= IMPORTANCE_THREE_MIN_CLUSTER_SIZE;
  if (peak === 2) return size >= IMPORTANCE_TWO_MIN_CLUSTER_SIZE;
  return false;
}
