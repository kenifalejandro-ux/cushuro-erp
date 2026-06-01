export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatMultilineHtml(value: string) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

export function maskEmail(value: string) {
  const [name, domain] = value.split("@");
  if (!name || !domain) return value;
  const visibleName = name.slice(0, 2);
  return `${visibleName}${"*".repeat(Math.max(1, name.length - visibleName.length))}@${domain}`;
}
