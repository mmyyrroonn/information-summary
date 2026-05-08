export interface PagedItems<T> {
  items: T[];
  page: number;
  pageCount: number;
  start: number;
  end: number;
  total: number;
}

export function getPagedItems<T>(items: T[], requestedPage: number, pageSize: number): PagedItems<T> {
  const total = items.length;
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const page = Math.min(Math.max(1, Math.floor(requestedPage) || 1), pageCount);
  const start = total === 0 ? 0 : (page - 1) * safePageSize + 1;
  const end = Math.min(total, page * safePageSize);

  return {
    items: items.slice(start === 0 ? 0 : start - 1, end),
    page,
    pageCount,
    start,
    end,
    total
  };
}
