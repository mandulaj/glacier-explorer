/**
 * Periods and events that help to find one's way along the time slider.
 * Ages in ka before present; every entry links the source its date comes from
 * (each DOI was resolved and checked against the claim). They are real-world
 * dates: the modelled ice follows its own climate forcing and can lead or lag
 * them by a few thousand years.
 */

export interface Source {
  /** short citation, e.g. "Clark et al. 2009, Science" */
  label: string;
  url: string;
}

export interface Period {
  from: number;
  to: number;
  name: string;
  /** shown where the band is too narrow for the full name */
  short: string;
  color: string;
  detail?: string;
  sources?: Source[];
}

export interface TimelineEvent {
  age: number;
  title: string;
  detail: string;
  sources?: Source[];
}

const NEEM: Source = { label: "NEEM community members 2013, Nature", url: "https://doi.org/10.1038/nature11789" };
const LR04: Source = { label: "Lisiecki & Raymo 2005, Paleoceanography", url: "https://doi.org/10.1029/2004PA001071" };
const INTIMATE: Source = { label: "Rasmussen et al. 2014, Quat. Sci. Rev.", url: "https://doi.org/10.1016/j.quascirev.2014.09.007" };
const ALPS_CHRONOLOGY: Source = { label: "Ivy-Ochs et al. 2008, J. Quat. Sci.", url: "https://doi.org/10.1002/jqs.1202" };

export const PERIODS: Period[] = [
  {
    from: 130,
    to: 115,
    name: "Last interglacial (Eemian)",
    short: "Eemian",
    color: "#f3c98b",
    detail: "The last warm period before ours, 130 000 to 115 000 years ago.",
    sources: [NEEM],
  },
  {
    from: 115,
    to: 71,
    name: "Early glacial (MIS 5d–a)",
    short: "Early glacial",
    color: "#c9dcec",
    detail: "Cooling with milder phases; a first Swiss glacier advance past the mountain front is dated to about 100 000 years ago.",
    sources: [LR04, ALPS_CHRONOLOGY],
  },
  {
    from: 71,
    to: 57,
    name: "Major advance (MIS 4)",
    short: "MIS 4",
    color: "#8fb5d9",
    detail: "Marine isotope stage 4, a cold stage in which glaciers again reached the Swiss foreland.",
    sources: [LR04, ALPS_CHRONOLOGY],
  },
  {
    from: 57,
    to: 29,
    name: "Milder interlude (MIS 3)",
    short: "MIS 3",
    color: "#c9dcec",
    detail: "Marine isotope stage 3: cold, but with smaller glaciers and many abrupt climate swings.",
    sources: [LR04, INTIMATE],
  },
  {
    from: 29,
    to: 14.7,
    name: "Last glacial maximum period (MIS 2)",
    short: "MIS 2",
    color: "#6f9fd0",
    detail: "Marine isotope stage 2 (29 000 to 14 000 years ago in the marine record), shown here up to the abrupt warming at 14 700 years ago.",
    sources: [LR04],
  },
  {
    from: 14.7,
    to: 11.7,
    name: "Late glacial",
    short: "Late gl.",
    color: "#b5cfe6",
    detail: "From the abrupt Bølling warming to the end of the Younger Dryas cold snap.",
    sources: [INTIMATE],
  },
  {
    from: 11.7,
    to: 0,
    name: "Holocene (present warm period)",
    short: "Holocene",
    color: "#f3c98b",
    detail: "Formally begins 11 700 years before AD 2000.",
    sources: [{ label: "Walker et al. 2009, J. Quat. Sci.", url: "https://doi.org/10.1002/jqs.1227" }],
  },
];

export const EVENTS: TimelineEvent[] = [
  {
    age: 115,
    title: "End of the last warm period",
    detail: "The Eemian interglacial ends and glaciers start to grow.",
    sources: [NEEM],
  },
  {
    age: 74,
    title: "Toba super-eruption",
    detail: "One of the largest known eruptions, in Sumatra, dated to 73 880 ± 320 years ago.",
    sources: [{ label: "Storey et al. 2012, PNAS", url: "https://doi.org/10.1073/pnas.1208178109" }],
  },
  {
    age: 65,
    title: "Ice reaches the Swiss foreland",
    detail: "Glacier advances in northern Switzerland are dated to about 105 000, 65 000 and 25 000 years ago.",
    sources: [{ label: "Preusser et al. 2011, E&G Quat. Sci. J.", url: "https://doi.org/10.3285/eg.60.2-3.06" }],
  },
  {
    age: 45,
    title: "Modern humans in Europe",
    detail: "Directly dated Homo sapiens remains from Bacho Kiro Cave, Bulgaria, show the spread into Europe before 45 000 years ago.",
    sources: [{ label: "Hublin et al. 2020, Nature", url: "https://doi.org/10.1038/s41586-020-2259-z" }],
  },
  {
    age: 40,
    title: "Neanderthals disappear",
    detail: "Neanderthal (Mousterian) sites across Europe end by about 41 000 to 39 000 years ago, after millennia of overlap with modern humans.",
    sources: [{ label: "Higham et al. 2014, Nature", url: "https://doi.org/10.1038/nature13621" }],
  },
  {
    age: 36,
    title: "Chauvet cave paintings",
    detail: "Lions, rhinos and mammoths painted in the Ardèche, France; first phase of human activity 37 000 to 33 500 years ago.",
    sources: [{ label: "Quiles et al. 2016, PNAS", url: "https://doi.org/10.1073/pnas.1523158113" }],
  },
  {
    age: 24,
    title: "Last Glacial Maximum",
    detail: "Nearly all ice sheets at their largest from 26 500 to about 19 000 years ago; global sea level some 130 m lower.",
    sources: [
      { label: "Clark et al. 2009, Science", url: "https://doi.org/10.1126/science.1172873" },
      { label: "Lambeck et al. 2014, PNAS", url: "https://doi.org/10.1073/pnas.1411762111" },
    ],
  },
  {
    age: 21,
    title: "Lascaux cave",
    detail: "People use the painted cave about 21 000 calendar years ago (the familiar 17 000 is the uncalibrated radiocarbon age).",
    sources: [{ label: "Ducasse & Langlais 2019, PALEO", url: "https://doi.org/10.4000/paleo.4558" }],
  },
  {
    age: 14.7,
    title: "Abrupt warming (Bølling)",
    detail: "Greenland ice cores date the rapid warming to 14 700 years ago.",
    sources: [INTIMATE],
  },
  {
    age: 12.3,
    title: "Younger Dryas cold snap",
    detail: "A return to near-glacial cold, 12 900 to 11 700 years ago; in the Alps the Egesen glacier re-advance is linked to it.",
    sources: [INTIMATE, ALPS_CHRONOLOGY],
  },
  {
    age: 7.5,
    title: "First farmers in Central Europe",
    detail: "The first farming culture (LBK) spreads from 5500 BC; the oldest known Swiss pile dwellings date to about 4300 BC.",
    sources: [
      { label: "Haak et al. 2010, PLoS Biology", url: "https://doi.org/10.1371/journal.pbio.1000536" },
      { label: "University of Basel 2022", url: "https://www.unibas.ch/en/News-Events/News/Uni-Research/7000-year-old-grains-hints-at-origin-of-Swiss-pile-dwellings.html" },
    ],
  },
  {
    age: 5.3,
    title: "Ötzi the Iceman",
    detail: "Lived between 3359 and 3105 BC; found in melting ice near the Tisenjoch, Ötztal Alps, in 1991.",
    sources: [
      { label: "Bonani et al. 1994, Radiocarbon", url: "https://doi.org/10.1017/S0033822200040534" },
      { label: "South Tyrol Museum of Archaeology", url: "https://www.iceman.it/en/the-discovery/" },
    ],
  },
  {
    age: 2,
    title: "Roman Empire",
    detail: "Under Claudius (AD 41–54) the Great St Bernard route is reorganised; Julier and Septimer are Roman pass crossings too.",
    sources: [{ label: "Historisches Lexikon der Schweiz", url: "https://hls-dhs-dss.ch/de/articles/008248/2015-02-04/" }],
  },
];

export function periodAt(age: number): Period | undefined {
  return PERIODS.find((p) => age <= p.from && age >= p.to);
}
