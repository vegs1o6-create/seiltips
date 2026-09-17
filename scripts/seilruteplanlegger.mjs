#!/usr/bin/env node
// Henter værdata (vind, kast, bølgehøyde, nedbør) for 5 faste punkter langs
// Oslo–Kosterøyene direkte fra MET Norways API-er, ber en GPT-modell hosted
// i Microsoft (Azure) AI Foundry analysere seilingsforholdene, og skriver
// resultatet som en ny fil i src/content/seilvarsel/.
//
// Selve værdata-aggregeringen (vind/kast/bølge/nedbør per dag) gjøres
// deterministisk her i skriptet – modellen brukes kun til analyse/tekst, slik
// at den aldri kan dikte opp tallverdier.
//
// Krever miljøvariablene AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY og
// AZURE_FOUNDRY_MODEL (se README.md).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MET_USER_AGENT = 'seiltips.no seilruteplanlegger/1.0 (+https://seiltips.no)';
const DAYS_AHEAD = 5;
const OUTPUT_DIR = 'src/content/seilvarsel';

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

  for (const point of POINTS) {
    const [lf, of] = await Promise.all([
      fetchJson(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${point.lat}&lon=${point.lon}`),
      fetchJson(`https://api.met.no/weatherapi/oceanforecast/2.0/complete?lat=${point.lat}&lon=${point.lon}`),
    ]);

    const lfSeries = lf?.properties?.timeseries;
    if (!lfSeries) {
      lines.push(`**${point.name} (${point.lat}, ${point.lon}):** Ingen værdata tilgjengelig fra MET akkurat nå.`, '');
      continue;
    }

    const wind = aggregateWind(lfSeries, dayKeys);
    const waves = aggregateWaves(of?.properties?.timeseries, dayKeys);

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
          `bølgehøyde ${maxWave !== null ? maxWave.toFixed(1) : 'n/a'} m, nedbør ${precipYesNo}`
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
<For hver av de 5 dagene: anbefalt seilføring (full rigg / ett reff / dobbelt
reff / stormseil / motorbåt-forhold). Marker dager som er uegnet for seilas
med ⚠️.>

## Ruteanbefalinger – segmentvis
<Vurder hvert segment separat: Oslo → Drøbak, Drøbak → Færder, Færder →
Hvaler, Hvaler → Kosterøyene. For hvert segment: beste dag/tidspunkt å
passere, vindvinkel på kursen, eventuelle advarsler.>

## Timing – sydover
<Hvilket tidspunkt (dag + ca. klokkeslett) er optimalt for avgang sydover fra
Oslo? Begrunn med vindretning, styrke og eventuelle fronter underveis.>

## Timing – nordover
<Hvilket tidspunkt er optimalt for avgang nordover fra Kosterøyene/Hvaler mot
Oslo?>

## Konfidensvurdering
<Marker tydelig hvilke deler av analysen som er høy konfidens (dag 1–2) vs.
usikre indikasjoner (dag 3–5).>

## Anbefaling
<Ett avsnitt: én konkret anbefaling – bør man dra nå, vente, eller er det en
spesifikk dag som peker seg ut?>

Skriv på norsk bokmål, konsist og tydelig, med norske nautiske termer der det
er naturlig (jf. persona og båtprofil i systemprompten).`;
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
    max_completion_tokens: 3000,
  };
  // Noen "reasoning"-modeller (o-serien) støtter ikke temperature-parameteren
  // i det hele tatt, så vi lar den være valgfri fremfor å risikere et 400-svar.
  if (process.env.AZURE_FOUNDRY_TEMPERATURE) {
    body.temperature = Number(process.env.AZURE_FOUNDRY_TEMPERATURE);
  }

  const res = await fetch(`${endpoint}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kall til Azure AI Foundry feilet (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Fikk ikke noe svarinnhold fra modellen. Rått svar: ${JSON.stringify(data).slice(0, 500)}`);
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
  const content = stripCodeFence(raw);
  validateContent(content);

  const filename = `${periodeFra}-seilruteplan-oslo-kosteroeyene.md`;
  const outPath = path.join(OUTPUT_DIR, filename);
  await mkdir(path.dirname(outPath), { recursive: true });
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
