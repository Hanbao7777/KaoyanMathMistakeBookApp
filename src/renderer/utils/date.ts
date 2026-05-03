export function formatDate(value?: string | null) {
  if (!value) return '暂无';
  return value.slice(0, 10);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
