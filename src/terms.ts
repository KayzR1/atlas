/**
 * Official term dates, so class schedules end when classes do and skip the university's no-class days.
 * Source: UNC-Chapel Hill academic calendar, catalog.unc.edu/academic-calendar (checked 2026-10-16).
 * Professional schools can differ (well-being days vary; Law ends earlier): `/skip` and `/unskip` cover those.
 */
export type NoClassDay = { date: string; name: string };
export type Term = { key: string; name: string; start: string; end: string; noClass: NoClassDay[] };

export const TERMS: Term[] = [
  {
    key: "fall-2026",
    name: "Fall 2026",
    start: "2026-08-17", // classes begin Monday, August 17
    end: "2026-12-02", // classes end Wednesday, December 2
    noClass: [
      { date: "2026-09-07", name: "Labor Day" },
      { date: "2026-09-21", name: "a well-being day" },
      { date: "2026-10-06", name: "a well-being day" },
      { date: "2026-10-15", name: "fall break" },
      { date: "2026-10-16", name: "fall break" },
      { date: "2026-11-25", name: "Thanksgiving recess" },
      { date: "2026-11-26", name: "Thanksgiving recess" },
      { date: "2026-11-27", name: "Thanksgiving recess" },
    ],
  },
];

/** The term that contains `ymd`, or the next one that starts after it; null if every known term is over. */
export function defaultTerm(ymd: string): Term | null {
  return TERMS.find((t) => ymd <= t.end) ?? null;
}

/** The known term with exactly these dates (so its holidays apply), if any. */
export const termFor = (start: string, end: string): Term | null => TERMS.find((t) => t.start === start && t.end === end) ?? null;
