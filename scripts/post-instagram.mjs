#!/usr/bin/env node
// Lager og publiserer et Instagram-innlegg for hver nye artikkel i
// src/content/artikler/. Kalles med én eller flere filstier som argumenter
// (typisk satt av .github/workflows/instagram-post.yml basert på hvilke
// artikkelfiler som ble lagt til i siste kjøring/push).
//
// For hver artikkel:
// 1. Ber Azure AI Foundry-modellen (samme AZURE_FOUNDRY_ENDPOINT/API_KEY som
//    de andre skriptene, standard "gpt-5.6-luna") skrive en norsk
//    Instagram-bildetekst + en engelsk bildegenereringsprompt, basert KUN på
//    den ferdigskrevne artikkelen (ingen nytt websøk).
// 2. Genererer et fotorealistisk bilde med en Azure OpenAI-bildemodell i
//    gpt-image-serien (deployet på samme ressurs som tekstmodellen, f.eks.
//    gpt-image-2.5-sunburst), skriver det til public/instagram/<slug>.png, og
//    committer/pusher det, slik at det får en offentlig URL
//    (raw.githubusercontent.com) Instagram kan hente bildet fra – uten å
//    vente på at Cloudflare skal bygge/deploye nettsiden først. Krever at
//    repoet er offentlig.
// 3. Publiserer et bilde-innlegg på Instagram via Instagram API with
//    Instagram Login: opprett media-container -> vent til den er ferdig
//    prosessert -> publiser.
//
// Krever miljøvariablene:
//   AZURE_FOUNDRY_ENDPOINT, AZURE_FOUNDRY_API_KEY   – tekstmodell (delt med de andre skriptene)
//   AZURE_FOUNDRY_IMAGE_ENDPOINT, AZURE_FOUNDRY_IMAGE_API_KEY, AZURE_FOUNDRY_IMAGE_MODEL – bildemodell
//   IG_ACCESS_TOKEN, IG_USER_ID                     – Instagram API with Instagram Login
//   GITHUB_REPOSITORY                               – "eier/repo", satt automatisk av GitHub Actions
// Se README.md for full oversikt over valgfrie miljøvariabler.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const IMAGE_DIR = 'public/instagram';
const DEFAULT_TEXT_MODEL = 'gpt-5.6-luna';
const DEFAULT_GRAPH_API_VERSION = 'v21.0';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Mangler påkrevd miljøvariabel: ${name}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/);
  return match ? match[1].trim() : trimmed;
}

function extractFrontmatterField(content, field) {
  const re = new RegExp(`^${field}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  return content.match(re)?.[1]?.trim();
}

function parseArticle(filePath, raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`Fant ikke gyldig frontmatter i ${filePath}`);
  const [, frontmatter, body] = match;
  const title = extractFrontmatterField(frontmatter, 'title');
  if (!title) throw new Error(`Fant ikke "title" i frontmatter i ${filePath}`);
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const tagsMatch = frontmatter.match(/^tags:\s*\[(.*)\]\s*$/m);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(',')
        .map((t) => t.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    : [];
  return { title, description, tags, body: body.trim() };
}

function buildCaptionPrompt({ title, description, tags, body }) {
  return `Du skal lage innhold til ett Instagram-innlegg som annonserer en artikkel som
allerede er publisert på Seiltips.no – en norsk nettside om seiling og båtliv langs
norskekysten. Artikkelen under er FERDIGSKREVET – bruk kun informasjonen som står
her, ikke researche eller finn på noe nytt.

## Artikkelen
Tittel: ${title}
Ingress: ${description}
${tags.length ? `Tags: ${tags.join(', ')}\n` : ''}
Tekst:
${body.slice(0, 3000)}

## Oppgave
Skriv to ting:

1. CAPTION – en Instagram-bildetekst på norsk bokmål. Uformell og engasjerende tone,
   maks ca. 120 ord, som gir lyst til å lese mer uten å avsløre alt. Avslutt ALLTID
   med en oppfordring om å lese hele saken via lenken i bio (f.eks. "Lenke i bio for
   hele saken 👆" eller en naturlig variant av dette – ALDRI en URL eller "seiltips.no"
   skrevet ut, siden Instagram-bildetekster ikke støtter klikkbare lenker – lenken
   ligger allerede i kontoens bio). Legg til 5–8 relevante hashtags på egen linje til
   slutt (norske og/eller engelske, f.eks. #seiling #seilbåt #seiltips #norge – velg
   de som faktisk passer temaet).
2. IMAGE_PROMPT – en bildegenereringsprompt PÅ ENGELSK til en fotorealistisk
   AI-bildemodell. Beskriv et konkret, fotorealistisk motiv relatert til
   artikkelens tema (norsk kystnatur, seilbåt, vær, sjøliv e.l., alt etter hva
   som faktisk passer temaet over) – inkluder stemning, lys og komposisjon.
   Bildet skal IKKE inneholde noe tekst, bokstaver, logoer eller vannmerker.

## Svarformat (MÅ følges eksakt – ingen annen tekst før/etter, ingen \`\`\`-kodeblokk)
CAPTION:
<bildeteksten, inkl. hashtags til slutt>

IMAGE_PROMPT:
<bildegenereringsprompten, på engelsk>`;
}

function parseCaptionResponse(text) {
  const captionMatch = text.match(/CAPTION:\s*([\s\S]*?)\n\s*IMAGE_PROMPT:/i);
  const promptMatch = text.match(/IMAGE_PROMPT:\s*([\s\S]*)$/i);
  if (!captionMatch || !promptMatch) {
    throw new Error(
      `Fikk ikke svaret i forventet CAPTION/IMAGE_PROMPT-format. Rått svar: ${text.slice(0, 500)}`
    );
  }
  const caption = captionMatch[1].trim();
  const imagePrompt = promptMatch[1].trim();
  if (!caption || !imagePrompt) {
    throw new Error('CAPTION eller IMAGE_PROMPT var tom i modell-svaret.');
  }
  return { caption, imagePrompt };
}

// Hostet websøk finnes kun på Responses-API-et (/v1/responses) i denne
// Azure AI Foundry-oppsettet – samme mønster som de andre skriptene, men her
// uten "tools", siden bildetekst/bildeprompt kun skal baseres på artikkelen
// vi allerede har, ikke på nytt websøk.
function extractResponseText(data) {
  for (const item of data.output ?? []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    const textPart = item.content.find((c) => c.type === 'output_text');
    if (textPart?.text) return textPart.text;
  }
  return null;
}

const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_BACKOFF_FLOOR_SECONDS = [15, 30, 60, 120];

async function callFoundryText(userPrompt) {
  const endpoint = requireEnv('AZURE_FOUNDRY_ENDPOINT').replace(/\/+$/, '');
  const apiKey = requireEnv('AZURE_FOUNDRY_API_KEY');
  const model = process.env.AZURE_FOUNDRY_INSTAGRAM_MODEL || DEFAULT_TEXT_MODEL;

  const body = {
    model,
    input: userPrompt,
    max_output_tokens: process.env.AZURE_FOUNDRY_INSTAGRAM_MAX_TOKENS
      ? Number(process.env.AZURE_FOUNDRY_INSTAGRAM_MAX_TOKENS)
      : 2000,
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
    console.log(`Fikk 429 (rate limit) fra Azure AI Foundry (tekst), venter ${waitSeconds}s før nytt forsøk …`);
    await sleep(waitSeconds * 1000);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kall til Azure AI Foundry (tekst) feilet (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const content = extractResponseText(data);
  if (!content) {
    throw new Error(`Fikk ikke noe svarinnhold fra tekstmodellen. Rått svar: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return content;
}

// Genererer ett bilde med en Azure OpenAI-bildemodell i gpt-image-serien,
// deployet på SAMME Foundry-ressurs/prosjekt som tekstmodellen
// (AZURE_FOUNDRY_ENDPOINT), via "/openai/v1/images/generations" – samme
// mønster (ingen api-version, "Authorization: Bearer") som callFoundryText()
// bruker mot /openai/v1/responses på den ressursen.
async function generateImage(prompt) {
  const endpoint = requireEnv('AZURE_FOUNDRY_IMAGE_ENDPOINT').replace(/\/+$/, '');
  const apiKey = requireEnv('AZURE_FOUNDRY_IMAGE_API_KEY');
  const model = requireEnv('AZURE_FOUNDRY_IMAGE_MODEL');
  const size = process.env.AZURE_FOUNDRY_IMAGE_SIZE || '1024x1024';
  const outputFormat = process.env.AZURE_FOUNDRY_IMAGE_OUTPUT_FORMAT || 'png';
  const outputCompression = Number(process.env.AZURE_FOUNDRY_IMAGE_OUTPUT_COMPRESSION) || 100;

  const body = {
    model,
    prompt,
    size,
    n: 1,
    output_format: outputFormat,
    output_compression: outputCompression,
  };
  const url = `${endpoint}/openai/v1/images/generations`;

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) break;

    const retryAfter = Number(res.headers.get('retry-after'));
    const floor = RATE_LIMIT_BACKOFF_FLOOR_SECONDS[attempt] ?? RATE_LIMIT_BACKOFF_FLOOR_SECONDS.at(-1);
    const waitSeconds = Number.isFinite(retryAfter) ? Math.max(retryAfter, floor) : floor;
    console.log(`Fikk 429 (rate limit) fra Azure AI Foundry (bilde), venter ${waitSeconds}s før nytt forsøk …`);
    await sleep(waitSeconds * 1000);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Kall til Azure AI Foundry (bilde) feilet (${res.status} ${res.statusText}): ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const item = data.data?.[0];
  if (!item) {
    throw new Error(`Fikk ikke noe bilde tilbake fra bildemodellen. Rått svar: ${JSON.stringify(data).slice(0, 500)}`);
  }
  if (item.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item.url) {
    const imgRes = await fetch(item.url);
    if (!imgRes.ok) throw new Error(`Klarte ikke å laste ned det genererte bildet fra ${item.url}`);
    return Buffer.from(await imgRes.arrayBuffer());
  }
  throw new Error('Bildemodellen returnerte verken "b64_json" eller "url".');
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function hasChanges(filePath) {
  return git(['status', '--porcelain', '--', filePath]).length > 0;
}

// Committer og pusher bildet slik at det får en offentlig URL
// (raw.githubusercontent.com) med én gang – uten å vente på at Cloudflare
// skal bygge og deploye nettsiden, som Instagram sitt Graph API ellers ville
// måttet vente på for å kunne hente bildet.
function commitAndPushImage(imagePath, title) {
  git(['add', imagePath]);
  if (!hasChanges(imagePath)) {
    console.log(`${imagePath} var uendret, committer ikke på nytt.`);
    return git(['rev-parse', 'HEAD']);
  }
  git(['commit', '-m', `Legg til Instagram-bilde for: ${title}`]);
  git(['push']);
  return git(['rev-parse', 'HEAD']);
}

// Bruker "Instagram API with Instagram Login" (graph.instagram.com), ikke den
// eldre "Instagram API with Facebook Login" (graph.facebook.com) – kjennetegnes
// på at access-tokenet starter med "IGAA...". Denne varianten krever ingen
// tilkoblet Facebook-side, men bruker et annet vertsnavn for API-kall.
async function publishToInstagram({ imageUrl, caption }) {
  const accessToken = requireEnv('IG_ACCESS_TOKEN');
  const igUserId = requireEnv('IG_USER_ID');
  const apiVersion = process.env.IG_GRAPH_API_VERSION || DEFAULT_GRAPH_API_VERSION;
  const base = `https://graph.instagram.com/${apiVersion}`;

  const createRes = await fetch(`${base}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: accessToken }),
  });
  const createData = await createRes.json().catch(() => ({}));
  if (!createRes.ok || !createData.id) {
    throw new Error(`Kunne ikke opprette Instagram-mediecontainer: ${JSON.stringify(createData).slice(0, 500)}`);
  }
  const creationId = createData.id;

  // Vent til containeren er ferdig prosessert (vanligvis raskt for et enkelt
  // bilde, men Graph API anbefaler å sjekke status_code før publisering).
  let statusCode = 'IN_PROGRESS';
  for (let attempt = 0; attempt < 10 && statusCode === 'IN_PROGRESS'; attempt++) {
    if (attempt > 0) await sleep(3000);
    const statusRes = await fetch(`${base}/${creationId}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`);
    const statusData = await statusRes.json().catch(() => ({}));
    statusCode = statusData.status_code || 'IN_PROGRESS';
    if (statusCode === 'ERROR') {
      throw new Error(`Instagram feilet under prosessering av bildet: ${JSON.stringify(statusData).slice(0, 500)}`);
    }
  }

  const publishRes = await fetch(`${base}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: accessToken }),
  });
  const publishData = await publishRes.json().catch(() => ({}));
  if (!publishRes.ok || !publishData.id) {
    throw new Error(`Kunne ikke publisere Instagram-innlegget: ${JSON.stringify(publishData).slice(0, 500)}`);
  }
  return publishData.id;
}

async function processArticle(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const article = parseArticle(filePath, raw);
  const slug = path.basename(filePath, path.extname(filePath));

  console.log(`\n=== ${article.title} (${filePath}) ===`);

  console.log('Ber Azure AI Foundry-modellen skrive bildetekst og bildeprompt …');
  const rawCaptionResponse = await callFoundryText(buildCaptionPrompt(article));
  const { caption, imagePrompt } = parseCaptionResponse(stripCodeFence(rawCaptionResponse));
  console.log(`Bildeprompt: ${imagePrompt}`);

  console.log('Genererer bilde med Azure AI Foundry-bildemodellen …');
  const imageBytes = await generateImage(imagePrompt);

  await mkdir(IMAGE_DIR, { recursive: true });
  const imagePath = path.join(IMAGE_DIR, `${slug}.png`);
  await writeFile(imagePath, imageBytes);
  console.log(`Skrev ${imagePath} (${imageBytes.length} bytes)`);

  const sha = commitAndPushImage(imagePath, article.title);
  const repo = requireEnv('GITHUB_REPOSITORY');
  const imageUrl = `https://raw.githubusercontent.com/${repo}/${sha}/${imagePath}`;
  console.log(`Bilde tilgjengelig på: ${imageUrl}`);

  console.log('Publiserer på Instagram …');
  const mediaId = await publishToInstagram({ imageUrl, caption });
  console.log(`Publisert på Instagram, media-id: ${mediaId}`);
}

async function main() {
  const files = process.argv.slice(2).filter(Boolean);
  if (files.length === 0) {
    throw new Error('Ingen artikkelfil(er) oppgitt som argument til scriptet.');
  }
  for (const file of files) {
    await processArticle(file);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
