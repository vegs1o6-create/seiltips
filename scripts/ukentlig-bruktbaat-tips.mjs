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

function buildPrompt(today) {
  return `Du skal skrive en ukentlig tipsartikkel til Seiltips.no – en norsk
nettside om seiling og båtliv langs norskekysten. Dagens dato er ${today}.

## 1. Søk opp aktuelle bruktbåt-annonser
Bruk websøket ditt til å søke på Google etter seilbåtannonser, blant annet med
søket \`site:finn.no seilbåt til salgs\`. Gjør flere søk om nødvendig (f.eks.
med ulike størrelser/prisklasser) for å få et godt utvalg å sammenligne.

## 2. Velg de 3 beste kjøpene
Sammenlign annonsene på pris, størrelse (lengde), alder (byggeår) og
medfølgende utstyr (seil, elektronikk, motor osv.), og velg ut de 3
annonsene som fremstår som best verdi for pengene akkurat nå. Bruk KUN
informasjon du faktisk finner i annonsene – dikt aldri opp pris, mål,
byggeår, utstyr eller andre detaljer.

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
pubDate: ${today}
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

async function callFoundry(userPrompt) {
  const endpoint = requireEnv('AZURE_FOUNDRY_ENDPOINT').replace(/\/+$/, '');
  const apiKey = requireEnv('AZURE_FOUNDRY_API_KEY');
  const model = process.env.AZURE_FOUNDRY_BRUKTBAAT_MODEL || DEFAULT_MODEL;

  const body = {
    model,
    input: userPrompt,
    // Aktiverer modellens innebygde websøk/browsing, slik at annonsene som
    // omtales faktisk er hentet fra et ferskt Google-/Finn.no-søk.
    tools: [{ type: 'web_search' }],
    max_output_tokens: process.env.AZURE_FOUNDRY_BRUKTBAAT_MAX_TOKENS
      ? Number(process.env.AZURE_FOUNDRY_BRUKTBAAT_MAX_TOKENS)
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
  const raw = await callFoundry(buildPrompt(today));
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
