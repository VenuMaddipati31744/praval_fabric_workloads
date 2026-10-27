/**
 * KQL text builders.
 *
 * Every name that reaches a command comes from a remote cluster's metadata, so
 * nothing is ever interpolated raw: identifiers are always bracket-quoted and
 * literals always escaped. A name that cannot be quoted safely is rejected.
 */

/** Characters that never appear in a legitimate Kusto entity name. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f]/;

export function assertSafeName(name: string): void {
  if (!name || UNSAFE_NAME.test(name) || name.length > 1024) {
    throw new Error(`Refusing to use the entity name ${JSON.stringify(name)} in a command.`);
  }
}

/** A bracket-quoted identifier: ['my table']. */
export function kqlName(name: string): string {
  assertSafeName(name);
  return `['${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

/** A single-quoted string literal. */
export function kqlString(value: string): string {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n")}'`;
}

/** A verbatim string literal, for JSON payloads: @'...'. */
export function kqlVerbatim(value: string): string {
  return `@'${String(value).replace(/'/g, "''")}'`;
}

/** A datetime literal from an ISO timestamp. */
export function kqlDatetime(iso: string): string {
  if (isNaN(Date.parse(iso))) {
    throw new Error(`Not a valid timestamp: ${iso}`);
  }
  return `datetime(${new Date(iso).toISOString()})`;
}

/** Only https cluster URIs on a hostname, with no path or credentials. */
export function normalizeClusterUri(input: string): string {
  const trimmed = (input || "").trim().replace(/\/+$/, "");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid cluster URI: ${input}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.pathname && url.pathname !== "/")) {
    throw new Error(`Use the cluster's https URI with no path, e.g. https://mycluster.westeurope.kusto.windows.net`);
  }
  return `https://${url.host.toLowerCase()}`;
}

/** A Kusto timespan string ("365.00:00:00", "01:00:00", "7d") to whole days, rounded up. */
export function timespanToDays(timespan: string | undefined): number | undefined {
  if (!timespan) {
    return undefined;
  }
  const short = /^(\d+(?:\.\d+)?)d$/i.exec(timespan.trim());
  if (short) {
    return Math.ceil(Number(short[1]));
  }
  const long = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(timespan.trim());
  if (!long) {
    return undefined;
  }
  const days = Number(long[1] || 0);
  const rest = Number(long[2]) * 3600 + Number(long[3]) * 60 + Number(long[4]);
  return days + (rest > 0 ? 1 : 0);
}
