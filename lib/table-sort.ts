export type SortDirection = "asc" | "desc";

export type SortConfig<T> = {
  key: keyof T | null;
  direction: SortDirection;
};

function compareValues(key: PropertyKey, left: unknown, right: unknown): number {
  if (left === right) {
    return 0;
  }
  if (left === null || left === undefined) {
    return 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }

  if (key === "tradeClass") {
    const rank = { standard: 2, "earnings-exposed": 1 };
    return (rank[left as keyof typeof rank] ?? 0) - (rank[right as keyof typeof rank] ?? 0);
  }
  if (key === "verdict") {
    const rank = { recommended: 3, consider: 2, avoid: 1 };
    return (rank[left as keyof typeof rank] ?? 0) - (rank[right as keyof typeof rank] ?? 0);
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

export function sortRows<T>(rows: T[], config: SortConfig<T>): T[] {
  if (config.key === null) {
    return [...rows];
  }

  const direction = config.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = left[config.key!];
    const rightValue = right[config.key!];
    if (leftValue === null || leftValue === undefined) {
      return rightValue === null || rightValue === undefined ? 0 : 1;
    }
    if (rightValue === null || rightValue === undefined) {
      return -1;
    }
    return compareValues(config.key as PropertyKey, leftValue, rightValue) * direction;
  });
}

export function toggleSort<T>(current: SortConfig<T>, key: keyof T): SortConfig<T> {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }

  return { key, direction: "desc" };
}
