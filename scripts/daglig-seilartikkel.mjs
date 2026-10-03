#!/usr/bin/env node
// Ser på hvilke nyheter/artikler som allerede er publisert (for å unngå
// duplikater), ber en modell hosted i Microsoft (Azure) AI Foundry – med
// websøk aktivert – research og skrive en ny seilartikkel, og skriver
// resultatet til en ny fil i src/content/artikler/.
//
// Krever miljøvariablene AZURE_FOUNDRY_ENDPOINT og AZURE_FOUNDRY_API_KEY
// (samme som scripts/seilruteplanlegger.mjs bruker). Modell-deploymentet kan
// overstyres med AZURE_FOUNDRY_ARTIKKEL_MODEL (standard: gpt-5.6-luna).
//
// Hvis keyword-suggestions.json (fra keyword-analysis-agent, se
// scripts/generate_keyword_suggestions.py) har forslag med "brukt": false,
// skrives dagens artikkel om forslaget med høyest prioritet i stedet for et
// fritt valgt tema, og forslaget markeres med "brukt": true. Workflowen
// committer den oppdaterte filen sammen med artikkelen.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NEWS_DIR = 'src/content/news';
const ARTIKLER_DIR = 'src/content/artikler';
const DEFAULT_MODEL = 'gpt-5.6-luna';
const RECENT_DAYS = 30;
const SUGGESTIONS_FILE = 'keyword-suggestions.json';
const PRIORITY_ORDER = { høy: 0, middels: 1, lav: 2 };
const MAX_ATTEMPTS = 2;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Mangler påkrevd miljøvariabel: ${name}`);
  return value;
}

function todayOslo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// pubDate skal inkludere klokkeslett (ikke bare dato), slik at artikler som
// publiseres samme dag likevel får en unik, korrekt sorterbar pubDate –
// ellers sorterer flere artikler fra samme dag likt og faller tilbake til
// alfabetisk filnavn-orden i stedet for faktisk publiseringstidspunkt.
function nowIso() {
  return new Date().toISOString();
}

function extractFrontmatterField(content, field) {
  const re = new RegExp(`^${field}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  return content.match(re)?.[1]?.trim();
}

async function listRecentEntries(dir) {
  const files = await readdir(dir).catch(() => []);
  const entries = [];
  for (const name of files) {
    if (!name.endsWith('.md')) continue;
    const content = await readFile(path.join(dir, name), 'utf8').catch(() => '');
    const title = extractFrontmatterField(content, 'title');
    const pubDate = extractFrontmatterField(content, 'pubDate');
    if (title) entries.push({ title, pubDate });
  }
  return entries;
}

// Norske bokstaver skrives ut som ae/o/a i filnavn, som i eksisterende filer
// (f.eks. src/content/news/hosten-er-fin-seilingstid.md).
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function loadSuggestions() {
  let raw;
  try {
    raw = await readFile(SUGGESTIONS_FILE, 'utf8');
  } catch {
    return null; // keyword-analysis-agent har ikke kjørt ennå
  }
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data?.suggestions) ? data : null;
  } catch (err) {
    // En ødelagt forslagsfil skal ikke stoppe den daglige artikkelen.
    console.warn(`Kunne ikke lese ${SUGGESTIONS_FILE} (${err.message}) – velger tema fritt.`);
    return null;
  }
}

// Forslaget med høyest prioritet vinner; ved lik prioritet det eldste
// (først i listen), slik at ingen forslag blir liggende for alltid.
function pickSuggestion(data) {
  const unused = (data?.suggestions ?? [])
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => s && s.brukt === false && s.title);
  unused.sort(
    (a, b) => (PRIORITY_ORDER[a.s.priority] ?? 1) - (PRIORITY_ORDER[b.s.priority] ?? 1) || a.index - b.index
  );
  return unused[0] ?? null;
}

// Rydder opp i modell-svaret før validering: fjerner BOM, normaliserer
// CRLF, plukker ut innholdet i en ```-kodeblokk (også om det står tekst rundt
// den) og kutter bort eventuell innledende prat før frontmatteren
// (f.eks. "Her er artikkelen:").
function normalizeContent(text) {
  let s = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const fence = s.match(/```[a-zA-Z]*\n(---\n[\s\S]*?)\n```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/^---[ \t]*\n(?=[\s\S]*?^title:)/m);
  if (start > 0) s = s.slice(start);
  return s.replace(/^---[ \t]*$/gm, '---');
}

function validateContent(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('Svaret fra modellen manglet gyldig frontmatter (--- ... ---).');
  const [, frontmatter, body] = match;
  for (const key of ['title:', 'description:', 'pubDate:']) {
    if (!frontmatter.includes(key)) throw new Error(`Frontmatter i modell-svaret mangler feltet "${key}".`);
  }
  if (!body.trim()) throw new Error('Svaret fra modellen manglet selve artikkelteksten.');
  return frontmatter;
}

function suggestionSection(suggestion) {
  const keywords = (suggestion.keywords ?? []).map((k) => `"${k}"`).join(', ');
  return `## 2. Tema (bestemt av søkeordanalysen) – research med websøk
Dagens tema er valgt ut fra søkeord Seiltips.no nesten rangerer godt på i Google.
Skriv artikkelen om DETTE temaet (du kan justere vinklingen og tittelen, men ikke
bytte tema):

- Arbeidstittel: ${suggestion.title}
- Viktigste søkeord: ${keywords}
- Hvorfor: ${suggestion.reasoning ?? ''}

Bruk det viktigste søkeordet naturlig i tittelen og description, og de andre
søkeordene naturlig i teksten og mellomtitlene – uten å overdrive (ingen
søkeord-stapping). Dagens dato er`;
}

function buildPrompt(recentEntries, today, pubDate, suggestion) {
  const recentList = recentEntries.length
    ? recentEntries.map((e) => `- ${e.title}${e.pubDate ? ` (${e.pubDate})` : ''}`).join('\n')
    : '(ingen tidligere artikler funnet)';

  return `Du skal skrive en ny artikkel til Seiltips.no – en norsk nettside om seiling og
båtliv langs norskekysten.

## 1. Unngå duplikater
Disse temaene/titlene er allerede publisert nylig (nyheter + artikler) – velg IKKE
samme tema, og velg et klart vinklet undertema hvis hovedtemaet er brukt nylig:

${recentList}

${
    suggestion
      ? `${suggestionSection(suggestion)} ${today}.
`
      : `## 2. Velg tema og research med websøk
Bruk websøket ditt til å research aktuell, sesongrelevant informasjon om seiling
langs norskekysten. Dagens dato er ${today}. Velg ett konkret tema innenfor en av
disse kategoriene (velg det som er mest aktuelt akkurat nå OG minst dekket fra før):

- Værforhold/sesongvarsler og hvordan lese dem
- Sikkerhet til sjøs: redningsvester, brannsikkerhet, sjøveisregler, mann-over-bord
- Praktisk seilerkunnskap: knop, navigasjon, fortøyning, ankring, seiltrim
- Båtvedlikehold og utstyr: sesongklargjøring, vinteropplag, sjøsetting, motor
- Bærekraft og miljø til sjøs
- Norske seilingsdestinasjoner: skjærgårder, gjestehavner, seilingsleder
`
  }
Gjør minst 3–5 websøk. Prioriter norske/skandinaviske kilder der det finnes, og
kryssjekk faktapåstander i minst 2 kilder før du bruker dem. Noter ned de fulle
URL-ene du faktisk hentet informasjon fra – disse skal inn i sources-feltet.

## 3. Skriv artikkelen
- Norsk bokmål, uformell og informativ tone (ikke høytidelig), 250–500 ord, gjerne
  med en mellomtittel eller punktliste der det er naturlig.
- Dikt ALDRI opp fakta, statistikk, tall eller sitater – hold deg strengt til det
  kildene faktisk sier. Skriv heller mer generelt/forsiktig enn å gjette.
- Alt skal skrives med egne ord, ikke avskrift fra kildene.
- Nevn eventuelle norske lov-/forskriftskrav (f.eks. fra Sjøfartsdirektoratet)
  korrekt og tydelig, uten å overdrive eller skremme unødig.
- Sett IKKE inn kildehenvisninger, lenker eller parenteser som "(kilde.no)" eller
  "([met.no](https://...))" løpende i selve artikkelteksten. Brødteksten skal
  leses som ren løpende tekst uten avbrytelser – alle kildene skal kun ligge i
  sources-feltet i frontmatter, ikke gjentas eller lenkes til inne i teksten.

## Svarformat (MÅ følges eksakt)
Svar KUN med innholdet i en ferdig Markdown-fil, ingen annen tekst før eller etter,
og ingen \`\`\`-kodeblokk rundt hele svaret. Filen skal se nøyaktig slik ut (fyll inn
de spisse parentesene, behold resten ordrett):

---
title: "<tittel, uten anførselstegn inni selve teksten>"
description: "<kort ingress, maks ca. 160 tegn>"
pubDate: ${pubDate}
tags: ["<tag1>", "<tag2>"]
sources: ["<url1>", "<url2>"]
---

<selve artikkelteksten i Markdown>`;
}

// Hostet websøk finnes kun på Responses-API-et (/v1/responses), ikke på
// Chat Completions (/v1/chat/completions) – der er "tools" begrenset til
// egendefinerte function/custom-verktøy, uten server-side søk.
// Med websøk kan modellen sende flere message-elementer (f.eks. en kort
// statusmelding før søkene), så vi foretrekker den siste meldingen som
// inneholder frontmatter, og faller ellers tilbake til den siste meldingen.
function extractResponseText(data) {
  const texts = [];
  for (const item of data.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter((c) => c.type === 'output_text' && c.text)
      .map((c) => c.text)
      .join('');
    if (text.trim()) texts.push(text);
  }
  if (!texts.length) return data.output_text || null;
  return [...texts].reverse().find((t) => /^---\s*$/m.test(t) && /^title:/m.test(t)) ?? texts.at(-1);
}

async function callFoundry(userPrompt) {
  const endpoint = requireEnv('AZURE_FOUNDRY_ENDPOINT').replace(/\/+$/, '');
  const apiKey = requireEnv('AZURE_FOUNDRY_API_KEY');
  const model = process.env.AZURE_FOUNDRY_ARTIKKEL_MODEL || DEFAULT_MODEL;

  const body = {
    model,
    input: userPrompt,
    // Aktiverer modellens innebygde websøk/browsing, slik at artikkelen kan
    // baseres på fersk research i stedet for bare treningskunnskap.
    tools: [{ type: 'web_search' }],
    max_output_tokens: process.env.AZURE_FOUNDRY_ARTIKKEL_MAX_TOKENS
      ? Number(process.env.AZURE_FOUNDRY_ARTIKKEL_MAX_TOKENS)
      : 16000,
  };

  const res = await fetch(`${endpoint}/openai/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kall til Azure AI Foundry feilet (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = extractResponseText(data);
  if (!content) {
    if (data.status === 'incomplete') {
      throw new Error(
        `Modellen fullførte ikke svaret (status "incomplete", grunn: ` +
          `${data.incomplete_details?.reason ?? 'ukjent'}). Sett ` +
          `AZURE_FOUNDRY_ARTIKKEL_MAX_TOKENS til en høyere verdi enn dagens 16000.`
      );
    }
    throw new Error(`Fikk ikke noe svarinnhold fra modellen. Rått svar: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return content;
}

async function main() {
  const today = todayOslo();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENT_DAYS);

  const [newsEntries, artikkelEntries] = await Promise.all([
    listRecentEntries(NEWS_DIR),
    listRecentEntries(ARTIKLER_DIR),
  ]);
  const recentEntries = [...newsEntries, ...artikkelEntries].filter((e) => {
    if (!e.pubDate) return true;
    const d = new Date(e.pubDate);
    return Number.isNaN(d.getTime()) || d >= cutoff;
  });

  console.log(`Fant ${recentEntries.length} nylig publiserte sak(er) å unngå duplikat av.`);
  const suggestionsData = await loadSuggestions();
  const picked = pickSuggestion(suggestionsData);
  if (picked) {
    console.log(`Bruker forslag fra søkeordanalysen [${picked.s.priority}]: ${picked.s.title}`);
  } else {
    console.log('Ingen ubrukte forslag i keyword-suggestions.json – modellen velger tema fritt.');
  }
  console.log('Ber Azure AI Foundry-modellen research og skrive dagens artikkel …');
  const prompt = buildPrompt(recentEntries, today, nowIso(), picked?.s);
  let content;
  let frontmatter;
  for (let attempt = 1; ; attempt++) {
    const raw = await callFoundry(prompt);
    content = normalizeContent(raw);
    try {
      frontmatter = validateContent(content);
      break;
    } catch (err) {
      console.warn(`Forsøk ${attempt}: ${err.message}\nStarten av svaret var:\n${raw.slice(0, 800)}`);
      if (attempt >= MAX_ATTEMPTS) throw err;
      console.log('Prøver på nytt …');
    }
  }

  const title = frontmatter.match(/^title:\s*"?([^"\n]+)"?\s*$/m)?.[1]?.trim();
  if (!title) throw new Error('Fant ikke title i frontmatter fra modell-svaret.');
  const slug = slugify(title);
  if (!slug) throw new Error(`Kunne ikke lage et gyldig filnavn fra tittelen: "${title}"`);

  const outPath = path.join(ARTIKLER_DIR, `${slug}.md`);
  await writeFile(outPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  console.log(`Skrev ${outPath}`);

  if (picked) {
    // Markeres først etter at artikkelen er skrevet, slik at en feilet kjøring
    // ikke "bruker opp" forslaget. Committes sammen med artikkelen.
    suggestionsData.suggestions[picked.index] = { ...picked.s, brukt: true, artikkel: outPath };
    await writeFile(SUGGESTIONS_FILE, `${JSON.stringify(suggestionsData, null, 2)}\n`, 'utf8');
    console.log(`Markerte forslaget "${picked.s.title}" som brukt i ${SUGGESTIONS_FILE}.`);
  }

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `file=${outPath}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
