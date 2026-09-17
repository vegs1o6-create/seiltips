#!/usr/bin/env node
// Ber en modell hosted i Microsoft (Azure) AI Foundry – med websøk aktivert –
// søke opp seilbåt-annonser på Finn.no, plukke ut de tre som ser ut som best
// verdi for pengene, og skrive en ukentlig tipsartikkel om dem. Resultatet
// skrives til en ny fil i src/content/artikler/.
//
// Krever miljøvariablene AZURE_FOUNDRY_ENDPOINT og AZURE_FOUNDRY_API_KEY
// (samme som scripts/daglig-seilartikkel.mjs og scripts/seilruteplanlegger.mjs
// bruker). Modell-deploymentet kan overstyres med
// AZURE_FOUNDRY_BRUKTBAAT_MODEL (standard: gpt-5.6-luna).

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const ARTIKLER_DIR = 'src/content/artikler';
const DEFAULT_MODEL = 'gpt-5.6-luna';

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

function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  return match ? match[1].trim() : trimmed;
}

function validateContent(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('Svaret fra modellen manglet gyldig frontmatter (--- ... ---).');
  const [, frontmatter, body] = match;
  for (const key of ['title:', 'description:', 'pubDate:']) {
    if (!frontmatter.includes(key)) throw new Error(`Frontmatter i modell-svaret mangler feltet "${key}".`);
  }
  if (!body.trim()) throw new Error('Svaret fra modellen manglet selve artikkelteksten.');
  if (!/finn\.no/i.test(body)) {
    throw new Error('Artikkelteksten inneholder ingen finn.no-lenker – avbryter i stedet for å publisere noe uten annonselenker.');
  }
  return frontmatter;
}

function buildPrompt(today, pubDate) {
  return `Du skal skrive en ukentlig tipsartikkel til Seiltips.no – en norsk
nettside om seiling og båtliv langs norskekysten. Dagens dato er ${today}.

## 1. Søk opp aktuelle bruktbåt-annonser
Bruk websøket ditt til å søke på Google etter seilbåtannonser, blant annet med
søket \`site:finn.no seilbåt til salgs\`. Gjør flere søk om nødvendig (f.eks.
med ulike størrelser/prisklasser) for å få et godt utvalg å sammenligne.

Nøy deg ALDRI med bare søketreff-overskriften/snippeten – åpne hver
kandidat-annonse du vurderer å bruke, og les selve annonseteksten, slik at
pris, mål, byggeår og utstyr er hentet fra den faktiske annonsesiden, ikke
gjettet ut fra søkeresultatet.

## 2. Velg de 3 beste kjøpene
Sammenlign annonsene på pris, størrelse (lengde), alder (byggeår) og
medfølgende utstyr (seil, elektronikk, motor osv.), og velg ut de 3
annonsene som fremstår som best verdi for pengene akkurat nå. Bruk KUN
informasjon du faktisk fant ved å åpne annonsene – dikt aldri opp pris, mål,
byggeår, utstyr eller andre detaljer. Klarer du ikke å åpne og lese nok
annonser til å fylle 3 trygt, skriv heller om færre enn 3 båter enn å gjette.

## 3. Skriv artikkelen
- Norsk bokmål, uformell og informativ tone, 400–600 ord.
- Presenter alle de 3 båtene med et kort avsnitt hver: pris, størrelse,
  byggeår, viktigste utstyr, og hvorfor akkurat denne fremstår som et godt
  kjøp.
- Lenk til hver annonse inne i teksten (den fulle finn.no-URL-en du faktisk
  fant den under, som en vanlig Markdown-lenke, f.eks. [se annonsen her](URL)).
- Avslutt med en tydelig merknad om at dette er et øyeblikksbilde – annonser
  på Finn.no kan bli solgt eller fjernet når som helst, så lenkene kan slutte
  å virke.

## Svarformat (MÅ følges eksakt)
Svar KUN med innholdet i en ferdig Markdown-fil, ingen annen tekst før eller
etter, og ingen \`\`\`-kodeblokk rundt hele svaret. Filen skal se nøyaktig
slik ut (fyll inn de spisse parentesene, behold resten ordrett):

---
title: "<tittel, uten anførselstegn inni selve teksten>"
description: "<kort ingress, maks ca. 160 tegn>"
pubDate: ${pubDate}
tags: ["bruktbåt", "finn.no", "kjøpsguide"]
sources: ["<url til annonse 1>", "<url til annonse 2>", "<url til annonse 3>"]
---

<selve artikkelteksten i Markdown>`;
}

// Hostet websøk finnes kun på Responses-API-et (/v1/responses), ikke på
// Chat Completions (/v1/chat/completions) – der er "tools" begrenset til
// egendefinerte function/custom-verktøy, uten server-side søk.
function extractResponseText(data) {
  for (const item of data.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    const textPart = item.content.find((c) => c.type === 'output_text');
    if (textPart?.text) return textPart.text;
  }
  return null;
}

const RATE_LIMIT_RETRIES = 4;
// Azure sin Retry-After-header har vist seg å love ledig kapasitet igjen om
// noen få sekunder, uten at det stemmer (påfølgende forsøk får 429 på nytt
// med en gang) – trolig fordi deploymentet har en lav TPM/RPM-kvote som
// flere tunge kall (websøk + reasoning) fyller opp igjen momentant. Vi
// stoler derfor ikke blindt på headeren, men venter minst like lenge som en
// økende backoff-gulv, og lar headeren kun forlenge ventetiden.
const RATE_LIMIT_BACKOFF_FLOOR_SECONDS = [20, 45, 90, 180];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callFoundry(userPrompt) {
  const endpoint = requireEnv('AZURE_FOUNDRY_ENDPOINT').replace(/\/+$/, '');
  const apiKey = requireEnv('AZURE_FOUNDRY_API_KEY');
  const model = process.env.AZURE_FOUNDRY_BRUKTBAAT_MODEL || DEFAULT_MODEL;

  const body = {
    model,
    input: userPrompt,
    // Uten "reasoning" kjører web_search i rask modus: den sender kun
    // søket videre og leser søketreff-snippets, uten å faktisk åpne
    // annonsesidene (open_page/find_in_page krever en reasoning-modell OG at
    // reasoning.effort er satt – ellers har modellen ikke nok til å lese
    // pris/mål/byggeår/utstyr fra selve Finn.no-annonsen, og bør heller si
    // fra enn å dikte opp tall). "medium" holder for å slå på agentisk søk
    // (åpne/lese sider), og er billigere i tokens enn "high".
    reasoning: { effort: process.env.AZURE_FOUNDRY_BRUKTBAAT_REASONING_EFFORT || 'medium' },
    tools: [{ type: 'web_search', search_context_size: 'medium' }],
    max_output_tokens: process.env.AZURE_FOUNDRY_BRUKTBAAT_MAX_TOKENS
      ? Number(process.env.AZURE_FOUNDRY_BRUKTBAAT_MAX_TOKENS)
      : 32000,
  };

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${endpoint}/openai/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;

    const retryAfter = Number(res.headers.get('retry-after'));
    const floor = RATE_LIMIT_BACKOFF_FLOOR_SECONDS[attempt] ?? RATE_LIMIT_BACKOFF_FLOOR_SECONDS.at(-1);
    const waitSeconds = Number.isFinite(retryAfter) ? Math.max(retryAfter, floor) : floor;
    console.log(`Fikk 429 (rate limit) fra Azure AI Foundry, venter ${waitSeconds}s før nytt forsøk …`);
    await sleep(waitSeconds * 1000);
  }

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
          `AZURE_FOUNDRY_BRUKTBAAT_MAX_TOKENS til en høyere verdi enn dagens 16000.`
      );
    }
    throw new Error(`Fikk ikke noe svarinnhold fra modellen. Rått svar: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return content;
}

async function main() {
  const today = todayOslo();

  console.log('Ber Azure AI Foundry-modellen søke opp og skrive ukens bruktbåt-tips …');
  const raw = await callFoundry(buildPrompt(today, nowIso()));
  const content = stripCodeFence(raw);
  validateContent(content);

  const outPath = path.join(ARTIKLER_DIR, `ukens-bruktbaat-tips-${today}.md`);
  await writeFile(outPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  console.log(`Skrev ${outPath}`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `file=${outPath}\ndato=${today}\n`, { flag: 'a' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
