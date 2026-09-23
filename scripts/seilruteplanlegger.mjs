#!/usr/bin/env node
// Henter værdata (vind, kast, bølgehøyde, nedbør) fra MET Norway og
// tidevannsdata (høyvann/lavvann) fra Kartverket for 5 faste punkter langs
// Oslo–Kosterøyene, ber en GPT-modell hosted i Microsoft (Azure) AI Foundry
// analysere seilingsforholdene, og skriver resultatet til én fast fil i
// src/content/seilvarsel/ – som dermed alltid inneholder kun den nyeste
// ruteplanen (erstattes hver gang skriptet kjører), ikke en historikk av
// separate artikler.
//
// Selve værdata-/tidevannsaggregeringen (vind/kast/bølge/nedbør/høyvann-
// lavvann per dag) gjøres deterministisk her i skriptet – modellen brukes
// kun til analyse/tekst, slik at den aldri kan dikte opp tallverdier.
//
// Krever miljøvariablene AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY og
// AZURE_FOUNDRY_MODEL (se README.md).

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MET_USER_AGENT = 'seiltips.no seilruteplanlegger/1.0 (+https://seiltips.no)';
const TIDE_API_BASE = 'https://vannstand.kartverket.no/tideapi.php';
const DAYS_AHEAD = 5;
const OUTPUT_DIR = 'src/content/seilvarsel';
const OUTPUT_FILENAME = 'naavarende-seilruteplan.md';

const POINTS = [
  { name: 'Oslo havn', lat: 59.9, lon: 10.73 },
  { name: 'Drøbak', lat: 59.66, lon: 10.62 },
  { name: 'Færder fyr', lat: 59.03, lon: 10.53 },
  { name: 'Hvaler', lat: 59.05, lon: 11.0 },
  { name: 'Kosterøyene', lat: 58.88, lon: 11.15 },
];

const COMPASS = ['N', 'NNØ', 'NØ', 'ØNØ', 'Ø', 'ØSØ', 'SØ', 'SSØ', 'S', 'SSV', 'SV', 'VSV', 'V', 'VNV', 'NV', 'NNV'];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Mangler påkrevd miljøvariabel: ${name}`);
  return value;
}

function dateKeyOslo(isoTime) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoTime));
}

function hourOslo(isoTime) {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', hour12: false }).format(
      new Date(isoTime)
    )
  );
}

function addDaysToKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function compassFromDegrees(deg) {
  if (deg === null || deg === undefined) return null;
  return COMPASS[Math.round(deg / 22.5) % 16];
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': MET_USER_AGENT } });
  if (!res.ok) return null;
  return res.json();
}

function aggregateWind(timeseries, dayKeys) {
  const byDay = new Map(
    dayKeys.map((k) => [k, { windSpeeds: [], gusts: [], dirCandidates: [], precip: 0, hasPrecipData: false }])
  );
  for (const entry of timeseries ?? []) {
    const day = byDay.get(dateKeyOslo(entry.time));
    if (!day) continue;

    const instant = entry.data?.instant?.details;
    if (instant) {
      if (typeof instant.wind_speed === 'number') day.windSpeeds.push(instant.wind_speed);
      if (typeof instant.wind_speed_of_gust === 'number') day.gusts.push(instant.wind_speed_of_gust);
      if (typeof instant.wind_from_direction === 'number') {
        day.dirCandidates.push({ hour: hourOslo(entry.time), dir: instant.wind_from_direction });
      }
    }

    const next6 = entry.data?.next_6_hours?.details?.precipitation_amount;
    const next1 = entry.data?.next_1_hours?.details?.precipitation_amount;
    if (typeof next6 === 'number') {
      day.precip += next6;
      day.hasPrecipData = true;
    } else if (typeof next1 === 'number') {
      day.precip += next1;
      day.hasPrecipData = true;
    }
  }
  return byDay;
}

function aggregateWaves(timeseries, dayKeys) {
  const byDay = new Map(dayKeys.map((k) => [k, []]));
  for (const entry of timeseries ?? []) {
    const day = byDay.get(dateKeyOslo(entry.time));
    if (!day) continue;
    const h = entry.data?.instant?.details?.sea_surface_wave_height;
    if (typeof h === 'number') day.push(h);
  }
  return byDay;
}

// Kartverkets tidevanns-API (vannstand.kartverket.no) svarer med XML. Vi
// bruker ingen XML-parser-avhengighet, men plukker ut <waterlevel time="…"
// value="…"/>-elementene direkte med regex – det er alt vi trenger fra
// svaret, uavhengig av hvilken <data type="…">-blokk de ligger i.
function parseWaterlevels(xmlText) {
  const points = [];
  const re = /<waterlevel\b([^>]*)\/?>/g;
  let match;
  while ((match = re.exec(xmlText ?? ''))) {
    const attrs = match[1];
    const time = attrs.match(/\btime="([^"]+)"/)?.[1];
    const value = attrs.match(/\bvalue="([^"]+)"/)?.[1];
    if (time && value !== undefined && !Number.isNaN(Number(value))) {
      points.push({ time, value: Number(value) });
    }
  }
  // Samme punkt kan forekomme i flere <data>-blokker i "ALL"-svaret
  // (f.eks. både en sammenhengende kurve og en tabell med topp-/bunnpunkter)
  // – dedupliser på tidspunkt.
  const seen = new Set();
  return points
    .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

// Finner høyvann/lavvann som lokale topp-/bunnpunkter i den sammenhengende
// tidevannskurven, fremfor å stole på en antatt "flag"-attributt i XML-en
// (som vi ikke har kunnet verifisere eksakt format på).
function findTideExtrema(points) {
  const extrema = [];
  for (let i = 1; i < points.length - 1; i++) {
    const { value } = points[i];
    if (value > points[i - 1].value && value > points[i + 1].value) {
      extrema.push({ ...points[i], kind: 'høyvann' });
    } else if (value < points[i - 1].value && value < points[i + 1].value) {
      extrema.push({ ...points[i], kind: 'lavvann' });
    }
  }
  return extrema;
}

async function fetchTideExtrema(point, periodeFra, periodeTilEksklusiv) {
  const url = new URL(TIDE_API_BASE);
  url.searchParams.set('tide_request', 'locationdata');
  url.searchParams.set('lat', point.lat);
  url.searchParams.set('lon', point.lon);
  url.searchParams.set('fromtime', `${periodeFra}T00:00`);
  url.searchParams.set('totime', `${periodeTilEksklusiv}T00:00`);
  url.searchParams.set('datatype', 'ALL');
  url.searchParams.set('refcode', 'CD'); // sjøkartnull, samme referanse som nautiske kart
  url.searchParams.set('lang', 'nb');
  url.searchParams.set('interval', '10');
  url.searchParams.set('dst', '1');

  try {
    const res = await fetch(url, { headers: { 'User-Agent': MET_USER_AGENT } });
    if (!res.ok) return [];
    const xml = await res.text();
    return findTideExtrema(parseWaterlevels(xml));
  } catch {
    return [];
  }
}

function groupTideExtremaByDay(extrema, dayKeys) {
  const byDay = new Map(dayKeys.map((k) => [k, []]));
  for (const e of extrema) {
    const day = byDay.get(dateKeyOslo(e.time));
    if (day) day.push(e);
  }
  return byDay;
}

function formatTideLine(dayExtrema) {
  if (!dayExtrema || dayExtrema.length === 0) return 'tidevannsdata mangler';
  return dayExtrema
    .map((e) => `${e.kind} kl ${hourMinuteOslo(e.time)} (${Math.round(e.value)} cm over sjøkartnull)`)
    .join(', ');
}

function hourMinuteOslo(isoTime) {
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(isoTime));
}

async function buildVaerdataBlock() {
  const today = dateKeyOslo(new Date().toISOString());
  const dayKeys = Array.from({ length: DAYS_AHEAD }, (_, i) => addDaysToKey(today, i));
  const periodeFra = dayKeys[0];
  const periodeTil = dayKeys.at(-1);

  const lines = [
    '## Værdata – Oslofjorden og Skagerrakkysten',
    `Hentet: ${new Date().toISOString()}`,
    `Periode: ${periodeFra} til ${periodeTil}`,
    '',
  ];

  const periodeTilEksklusiv = addDaysToKey(periodeTil, 1);

  for (const point of POINTS) {
    const [lf, of, tideExtrema] = await Promise.all([
      fetchJson(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${point.lat}&lon=${point.lon}`),
      fetchJson(`https://api.met.no/weatherapi/oceanforecast/2.0/complete?lat=${point.lat}&lon=${point.lon}`),
      fetchTideExtrema(point, periodeFra, periodeTilEksklusiv),
    ]);

    const lfSeries = lf?.properties?.timeseries;
    if (!lfSeries) {
      lines.push(`**${point.name} (${point.lat}, ${point.lon}):** Ingen værdata tilgjengelig fra MET akkurat nå.`, '');
      continue;
    }

    const wind = aggregateWind(lfSeries, dayKeys);
    const waves = aggregateWaves(of?.properties?.timeseries, dayKeys);
    const tideByDay = groupTideExtremaByDay(tideExtrema, dayKeys);

    lines.push(`**${point.name} (${point.lat}, ${point.lon}):**`);
    dayKeys.forEach((key, i) => {
      const w = wind.get(key);
      const maxWind = w.windSpeeds.length ? Math.max(...w.windSpeeds) : null;
      const maxGust = w.gusts.length ? Math.max(...w.gusts) : null;
      const dir = w.dirCandidates.length
        ? compassFromDegrees(
            w.dirCandidates.reduce((best, c) => (Math.abs(c.hour - 12) < Math.abs(best.hour - 12) ? c : best)).dir
          )
        : null;
      const maxWave = waves.get(key)?.length ? Math.max(...waves.get(key)) : null;
      const precipYesNo = w.hasPrecipData ? (w.precip > 0.2 ? 'ja' : 'nei') : 'ukjent';

      lines.push(
        `- Dag ${i + 1} (${key}): Vind ${maxWind !== null ? maxWind.toFixed(1) : 'n/a'} m/s fra ${dir ?? 'n/a'}, ` +
          `kast ${maxGust !== null ? maxGust.toFixed(1) : 'n/a'} m/s, ` +
          `bølgehøyde ${maxWave !== null ? maxWave.toFixed(1) : 'n/a'} m, nedbør ${precipYesNo}, ` +
          `tidevann: ${formatTideLine(tideByDay.get(key))}`
      );
    });
    lines.push('');
  }

  return { block: lines.join('\n'), periodeFra, periodeTil, today };
}

function buildTaskInstructions({ periodeFra, periodeTil, today }) {
  return `Du skal analysere værdataene under og skrive en seilruteplan for strekningen
Oslo havn–Drøbak–Færder fyr–Hvaler–Kosterøyene, til den norske nettsiden Seiltips.no.

Værdataene under er hentet direkte fra MET Norways API-er og er allerede
kvalitetssikrede tallverdier – IKKE dikt opp eller endre tallene, bruk dem
akkurat som de står. "n/a" betyr at data mangler for det punktet/den dagen
(typisk bølgehøyde for skjermede innaskjærs punkter som Oslo/Drøbak) – skriv
da at data mangler i stedet for å gjette et tall. "ukjent" for nedbør betyr at
nedbørsdata ikke var tilgjengelig for den dagen.

Tidevannsverdiene ("tidevann: …") er hentet fra Kartverkets tidevanns-API og
viser klokkeslett og høyde (i cm relativt til sjøkartnull) for hvert
høyvann/lavvann den dagen. Du SKAL ta hensyn til tidevannet i vurderingen
din – både i seksjonen om ruteanbefalinger og i timing-seksjonene. Vær
spesielt oppmerksom på Drøbaksundet, som er smalt og grunt, hvor
tidevannsstrøm kan påvirke passering mer enn ellers i fjorden/langs kysten.
Tidevannsforskjellene i dette området er normalt beskjedne (typisk noen få
titalls cm), så vurder dette som en finjustering av
timing/strøm-forhold – ikke la det overstyre vind- og bølgevurderingene.
"tidevannsdata mangler" betyr at Kartverkets API ikke ga data for det
punktet/den dagen – skriv da at tidevannsdata mangler i stedet for å gjette.

## Svarformat (MÅ følges eksakt)
Svar KUN med innholdet i en ferdig Markdown-fil, ingen annen tekst før eller
etter, og ingen \`\`\`-kodeblokk rundt hele svaret. Filen skal se nøyaktig
slik ut (fyll inn de spisse parentesene, behold resten ordrett):

---
title: "Seilruteplan <periodeFra dag/måned>–<periodeTil dag/måned>: <kort stikkord om vindforholdene, maks 6 ord>"
description: "<kort ingress, maks ca. 160 tegn, oppsummerer perioden>"
pubDate: ${today}
periodeFra: ${periodeFra}
periodeTil: ${periodeTil}
tags: ["ruteplanlegging", "vaervarsel"]
---

## Sammendrag
<3–5 linjer: rask oversikt over perioden. Hva dominerer? Er det et klart seilvindu?>

## Seilføring per dag
<For hver av de 5 dagene: anbefalt seilføring (full rigg / ett rev / dobbelt
rev / stormseil / motorbåt-forhold). Marker dager som er uegnet for seilas
med ⚠️.>

## Ruteanbefalinger – segmentvis
<Vurder hvert segment separat: Oslo → Drøbak, Drøbak → Færder, Færder →
Hvaler, Hvaler → Kosterøyene. For hvert segment: beste dag/tidspunkt å
passere, vindvinkel på kursen, eventuelle advarsler. Nevn tidevann/strøm der
det er relevant, særlig gjennom Drøbaksundet.>

## Timing – sydover
<Hvilket tidspunkt (dag + ca. klokkeslett) er optimalt for avgang sydover fra
Oslo? Begrunn med vindretning, styrke, eventuelle fronter underveis, og
tidevann/strømforhold (særlig ved Drøbak) der det påvirker timingen.>

## Timing – nordover
<Hvilket tidspunkt er optimalt for avgang nordover fra Kosterøyene/Hvaler mot
Oslo? Ta med tidevann/strømforhold der det er relevant.>

## Konfidensvurdering
<Marker tydelig hvilke deler av analysen som er høy konfidens (dag 1–2) vs.
usikre indikasjoner (dag 3–5).>

## Anbefaling
<Ett avsnitt: én konkret anbefaling – bør man dra nå, vente, eller er det en
spesifikk dag som peker seg ut?>

Skriv på norsk bokmål, konsist og tydelig, med norske nautiske termer der det
er naturlig (jf. persona og båtprofil i systemprompten). Det norske ordet for
å minske seilarealet er "rev" (ett rev, dobbelt rev, ta rev, revet storseil) –
skriv ALDRI "reff", som er en fornorsking av engelske "reef".`;
}

// Sikkerhetsnett i tillegg til instruksen i prompten: modellen har en tendens
// til å skrive «reff» (fra engelske «reef») i stedet for det norske «rev».
function fixReefTerm(text) {
  return text.replace(/(?<!\p{L})([Rr])eff/gu, '$1ev');
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  return match ? match[1].trim() : trimmed;
}

function validateContent(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('Svaret fra modellen manglet gyldig frontmatter (--- ... ---).');
  const [, frontmatter, body] = match;
  for (const key of ['title:', 'description:', 'pubDate:', 'periodeFra:', 'periodeTil:']) {
    if (!frontmatter.includes(key)) throw new Error(`Frontmatter i modell-svaret mangler feltet "${key}".`);
  }
  if (!body.trim()) throw new Error('Svaret fra modellen manglet selve rapportteksten.');
}

async function callFoundry(systemPrompt, userPrompt) {
  const endpoint = requireEnv('AZURE_FOUNDRY_ENDPOINT').replace(/\/+$/, '');
  const apiKey = requireEnv('AZURE_FOUNDRY_API_KEY');
  const model = requireEnv('AZURE_FOUNDRY_MODEL');

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    // Reasoning-modeller (bl.a. gpt-5-familien) bruker en ukjent mengde av
    // dette budsjettet på skjulte resonnement-tokens FØR selve svarteksten,
    // så vi gir god margin. Kan overstyres med AZURE_FOUNDRY_MAX_TOKENS.
    max_completion_tokens: process.env.AZURE_FOUNDRY_MAX_TOKENS
      ? Number(process.env.AZURE_FOUNDRY_MAX_TOKENS)
      : 16000,
  };
  // Nyere "reasoning"-modeller (bl.a. gpt-5-familien) avviser temperature-
  // parameteren helt, så vi sender den kun hvis den er eksplisitt satt.
  if (process.env.AZURE_FOUNDRY_TEMPERATURE) {
    body.temperature = Number(process.env.AZURE_FOUNDRY_TEMPERATURE);
  }

  const res = await fetch(`${endpoint}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kall til Azure AI Foundry feilet (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    if (choice?.finish_reason === 'length') {
      throw new Error(
        'Modellen brukte opp hele tokenbudsjettet (trolig på skjulte resonnement-tokens) uten å ' +
          'skrive noe svar. Sett AZURE_FOUNDRY_MAX_TOKENS til en høyere verdi enn dagens 16000.'
      );
    }
    throw new Error(`Fikk ikke noe svarinnhold fra modellen. Rått svar: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return content;
}

async function main() {
  const personaPath = new URL('../.github/prompts/seilruteplanlegger-persona.md', import.meta.url);
  const persona = await readFile(personaPath, 'utf8');

  console.log('Henter værdata fra MET Norway for 5 punkter, 5 dager …');
  const { block, periodeFra, periodeTil, today } = await buildVaerdataBlock();

  const userPrompt = `${buildTaskInstructions({ periodeFra, periodeTil, today })}\n\n${block}`;

  console.log('Ber Azure AI Foundry-modellen analysere seilingsforholdene …');
  const raw = await callFoundry(persona, userPrompt);
  const content = fixReefTerm(stripCodeFence(raw));
  validateContent(content);

  const outPath = path.join(OUTPUT_DIR, OUTPUT_FILENAME);
  await mkdir(OUTPUT_DIR, { recursive: true });

  // Rydd bort ev. eldre filer (f.eks. fra tidligere versjoner av skriptet som
  // skrev én fil per dato) – vi skal alltid ha nøyaktig én, gjeldende ruteplan.
  const existing = await readdir(OUTPUT_DIR).catch(() => []);
  await Promise.all(
    existing
      .filter((name) => name !== '.gitkeep' && name !== OUTPUT_FILENAME)
      .map((name) => rm(path.join(OUTPUT_DIR, name)))
  );

  await writeFile(outPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  console.log(`Skrev ${outPath}`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `file=${outPath}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
