/**
 * Periods and events that help to find one's way along the time slider.
 * Ages in ka before present, from the general literature (marine isotope
 * stage boundaries after Lisiecki & Raymo 2005, LGM after Clark et al. 2009).
 * They are real-world dates; the modelled ice follows its own climate forcing
 * and can lead or lag them by a few thousand years.
 */

export interface Period {
  from: number;
  to: number;
  name: string;
  /** shown where the band is too narrow for the full name */
  short: string;
  color: string;
}

export interface TimelineEvent {
  age: number;
  title: string;
  detail: string;
}

export const PERIODS: Period[] = [
  { from: 130, to: 115, name: "Last interglacial (Eemian)", short: "Eemian", color: "#f3c98b" },
  { from: 115, to: 71, name: "Early glacial (MIS 5d–a)", short: "Early glacial", color: "#c9dcec" },
  { from: 71, to: 57, name: "First great advance (MIS 4)", short: "MIS 4", color: "#8fb5d9" },
  { from: 57, to: 29, name: "Milder interlude (MIS 3)", short: "MIS 3", color: "#c9dcec" },
  { from: 29, to: 14.7, name: "Last glacial maximum period (MIS 2)", short: "MIS 2", color: "#6f9fd0" },
  { from: 14.7, to: 11.7, name: "Late glacial", short: "Late gl.", color: "#b5cfe6" },
  { from: 11.7, to: 0, name: "Holocene (present warm period)", short: "Holocene", color: "#f3c98b" },
];

export const EVENTS: TimelineEvent[] = [
  { age: 115, title: "End of the last warm period", detail: "The Eemian interglacial ends and glaciers start to grow." },
  { age: 74, title: "Toba super-eruption", detail: "One of the largest known eruptions, in Sumatra, about 74 000 years ago." },
  { age: 65, title: "First great ice advance", detail: "Glaciers reach the Alpine foreland during marine isotope stage 4." },
  { age: 45, title: "Modern humans reach Europe", detail: "Homo sapiens spreads across Europe and meets the Neanderthals." },
  { age: 40, title: "Neanderthals disappear", detail: "The last Neanderthals vanish around 40 000 years ago." },
  { age: 36, title: "Chauvet cave paintings", detail: "Lions, rhinos and mammoths painted in the Ardèche, France." },
  { age: 24, title: "Last Glacial Maximum", detail: "Ice sheets worldwide near their largest, 26 500 to 19 000 years ago; sea level about 125 m lower." },
  { age: 17, title: "Lascaux cave paintings", detail: "Painted while the Alpine glaciers were already retreating into the valleys." },
  { age: 14.7, title: "Abrupt warming (Bølling–Allerød)", detail: "Rapid warming; forests return to the Alpine foreland." },
  { age: 12.3, title: "Younger Dryas cold snap", detail: "A return to near-glacial cold, 12 900 to 11 700 years ago; glaciers re-advance in the high valleys." },
  { age: 7.5, title: "First farmers at the Alps", detail: "Neolithic farming arrives; pile dwellings on the lakes follow." },
  { age: 5.3, title: "Ötzi the Iceman", detail: "Dies at the Tisenjoch, Ötztal Alps, around 3300 BC; found in melting ice in 1991." },
  { age: 2, title: "Roman Empire", detail: "Roman roads cross the Alpine passes." },
];

export function periodAt(age: number): Period | undefined {
  return PERIODS.find((p) => age <= p.from && age >= p.to);
}
