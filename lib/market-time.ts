const MARKET_TIME_ZONE = "America/New_York";

export function getMarketDateIso(
  now: Date,
  timeZone: string = MARKET_TIME_ZONE,
): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Failed to format market date for time zone ${timeZone}.`);
  }

  return `${year}-${month}-${day}`;
}

