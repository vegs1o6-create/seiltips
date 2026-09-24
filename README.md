# Seiltips.no

Nettsiden for Seiltips.no – værvarsel, seiltips og nyheter for norske seilere. Bygget med
[Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com), og laget for å
publiseres som en Cloudflare Worker med statiske assets (Cloudflares nyeste,
samlede Git-integrasjon for Pages/Workers).

## Kom i gang lokalt

```bash
npm install
npm run dev
```

Siden kjører da på `http://localhost:4321`.

```bash
npm run build    # bygger den statiske siden til ./dist
npm run preview  # forhåndsviser produksjonsbygget lokalt
```

## Publisere en nyhet

Nyheter er Markdown-filer i `src/content/news/`. For å publisere en ny sak:

1. Opprett en ny fil, f.eks. `src/content/news/min-nye-sak.md`.
2. Legg til frontmatter og innhold:

   ```md
   ---
   title: "Tittel på saken"
   description: "Kort ingress som vises i lister og på forsiden."
   pubDate: 2026-09-20
   ---

   Selve saken skrives her, i vanlig Markdown.
   ```

3. Commit og push til Git – Cloudflare Pages bygger og publiserer siden automatisk.

Den nyeste saken (høyest `pubDate`) vises automatisk fremhevet på forsiden, og alle saker
listes i [nyhetsarkivet](/nyheter). Sett `draft: true` i frontmatter for å skjule en sak uten
å slette den.

## Artikler (automatisk generert)

I tillegg til `nyheter` finnes en egen samling `artikler` i `src/content/artikler/`, for
lengre, mer tidløse artikler om seiling, vær, sikkerhet og båtliv. Skjemaet
(`src/content.config.ts`) ligner på `news`, men har også `tags` og `sources` (URL-ene
artikkelen er researchet fra).

En GitHub Action (`.github/workflows/daglig-seilartikkel.yml`) kjører hver dag rundt
kl. 08:00 norsk tid og bruker `scripts/daglig-seilartikkel.mjs` (ren Node.js, samme
mønster som `seilruteplanlegger.mjs`) til å:

1. Se på hva som allerede er publisert i `src/content/news/` og `src/content/artikler/`
   de siste ca. 30 dagene, for å unngå å skrive om samme tema på nytt.
2. Be en modell (`gpt-5.6-luna`, kan overstyres med `AZURE_FOUNDRY_ARTIKKEL_MODEL`) som
   kjører i Microsoft (Azure) AI Foundry – med websøk aktivert – research et aktuelt,
   sesongrelevant seilertema (vær, sikkerhet, praktiske tips, båtvedlikehold, miljø,
   norske seilingsdestinasjoner) og skrive en artikkel basert på det, med kildene den
   fant i et `sources`-felt.
3. Skrive svaret som en ny Markdown-fil i `src/content/artikler/` med gyldig
   frontmatter, og committe/pushe den direkte til hovedgrenen.

Workflowen bruker de samme `AZURE_FOUNDRY_ENDPOINT`- og `AZURE_FOUNDRY_API_KEY`-secretene
som `seilruteplanlegger.yml` (se under) – ressursen må derfor ha en `gpt-5.6-luna`-modell
deployet i tillegg til modellen ruteplanleggeren bruker. GitHub Actions må også ha lov
til å pushe direkte til hovedgrenen (`contents: write`-rettigheten er satt i workflowen,
men en eventuell branch protection-regel på hovedgrenen kan likevel blokkere direkte push
fra Actions). Du kan også trigge kjøringen manuelt fra fanen **Actions** i GitHub
(`workflow_dispatch`), noe som hopper over tidsvindu-sjekken.

### Tema fra søkeordanalysen

Hvis `keyword-suggestions.json` (fra [keyword-analysis-agent](#keyword-analysis-agent-ukentlige-nøkkelordforslag))
finnes og har forslag med `"brukt": false`, velger artikkelagenten ikke tema fritt. Den
skriver om forslaget med høyest prioritet (`høy` → `middels` → `lav`, eldste først ved
lik prioritet) og bruker søkeordene fra forslaget i tittel og tekst. Når artikkelen er
skrevet, settes `"brukt": true` (og `"artikkel": "<sti>"`) på forslaget, og
`keyword-suggestions.json` committes i samme commit som artikkelen. Uten ubrukte
forslag velger modellen tema fritt, som før.

## Keyword analysis agent (ukentlige nøkkelordforslag)

`.github/workflows/keyword-analysis.yml` kjører hver søndag kl. 19:00 UTC (og manuelt via
`workflow_dispatch`). Den finner søkeord seiltips.no *nesten* rangerer godt på i Google,
og foreslår nye artikkeltemaer for dem:

1. `scripts/fetch_search_console.py` henter `query`, `impressions`, `clicks`, `ctr` og
   `position` for de siste 90 dagene fra Google Search Console API og skriver dem til
   `data/gsc-queries.json`. Filen er et mellomsteg og ligger i `.gitignore`.
2. `scripts/generate_keyword_suggestions.py` plukker ut søkeord med over 50 impressions og
   posisjon 8–20. Den fyller inn promptmalen `.github/prompts/keyword-analysis.md` med disse
   søkeordene, titlene på alle artikler i `src/content/artikler/` og tidligere forslag.
   Deretter ber den en modell i **Microsoft (Azure) AI Foundry** gruppere søkeordene i
   3–5 klynger, fjerne det som allerede er dekket, og svare med forslag som ren JSON.
3. Nye forslag legges til i `keyword-suggestions.json` i roten av repoet, og filen
   committes med meldingen `Ukentlige nøkkelordforslag <dato>`, men bare hvis noe
   faktisk endret seg. Eksisterende forslag slettes aldri, heller ikke de med
   `"brukt": true`.

Artikkelagenten ([over](#tema-fra-søkeordanalysen)) bruker forslagene. Hele løkken
kjører i GitHub Actions, og all AI-generering (både her og i de andre agentene) går via
Foundry. Denne agenten bruker det vanlige chat-completions-endepunktet
(`/openai/v1/chat/completions`, samme som seilruteplanleggeren), uten websøk.

Om svarene fra modellen:

- Kallet prøves opptil 3 ganger hvis Foundry feiler eller svaret ikke er gyldig JSON.
  Eventuelle ```json-fences strippes før parsing.
- Tallene i `source_queries` hentes alltid fra de faktiske Search Console-dataene, ikke
  fra modellen. Søkeord som ikke finnes i dataene forkastes.
- Finnes ingen søkeord som oppfyller kriteriene (vanlig for en ny side med lite
  trafikk), kalles ikke modellen, og ingenting committes.

Formatet i `keyword-suggestions.json`:

```json
{
  "generated_at": "2026-09-27T19:03:12+00:00",
  "suggestions": [
    {
      "title": "Slik velger du riktig ankerkjetting",
      "keywords": ["ankerkjetting", "anker seilbåt"],
      "reasoning": "410 visninger totalt, snittposisjon 11 …",
      "priority": "høy",
      "brukt": false,
      "source_queries": [{ "query": "ankerkjetting", "impressions": 320, "position": 11.2 }]
    }
  ]
}
```

### Oppsett: Google Search Console

1. Opprett (eller gjenbruk) et prosjekt i Google Cloud Console, og aktiver
   **Google Search Console API**.
2. Opprett en **service account** i prosjektet og lag en JSON-nøkkel for den.
3. Gå til Search Console → eiendommen for seiltips.no → **Innstillinger → Brukere og
   tillatelser**, og legg til service accountens e-postadresse
   (`…@….iam.gserviceaccount.com`). Tillatelsen «Begrenset» er nok.
4. Legg hele innholdet i JSON-nøkkelfilen inn som secret **`GSC_SA_KEY`**.
5. Eiendommen antas å være domene-eiendommen `sc-domain:seiltips.no`. Er den en
   URL-prefiks-eiendom, sett repo-**variabelen** (ikke secret) `GSC_SITE_URL` til
   eiendomsnavnet slik det står i Search Console, f.eks. `https://seiltips.no/`. Ved
   tilgangsfeil lister scriptet hvilke eiendommer service accounten faktisk har tilgang til.

### Oppsett: Microsoft Foundry

Agenten bruker de samme secretene som de andre Foundry-agentene:

- `AZURE_FOUNDRY_ENDPOINT` – ressurs-/prosjekt-endepunktet (se seilruteplanleggeren).
- `AZURE_FOUNDRY_API_KEY` – API-nøkkelen.
- `AZURE_FOUNDRY_MODEL` – deployment-navnet til chat-modellen (samme secret som
  seilruteplanleggeren).

Valgfritt: secret `AZURE_FOUNDRY_KEYWORD_MODEL` gir søkeordanalysen et eget deployment,
og `AZURE_FOUNDRY_KEYWORD_MAX_TOKENS` overstyrer `max_completion_tokens` (standard 16000).

Lokal kjøring:

```sh
pip install -r requirements.txt
GSC_SA_KEY="$(cat nøkkel.json)" python scripts/fetch_search_console.py --site-url sc-domain:seiltips.no
AZURE_FOUNDRY_ENDPOINT=... AZURE_FOUNDRY_API_KEY=... AZURE_FOUNDRY_MODEL=... \
  python scripts/generate_keyword_suggestions.py
```

## Ukens bruktbåt-tips (automatisk generert)

En egen GitHub Action (`.github/workflows/ukentlig-bruktbaat-tips.yml`) kjører hver
søndag rundt kl. 18:00 norsk tid og bruker
`scripts/ukentlig-bruktbaat-tips.mjs` (samme mønster som `daglig-seilartikkel.mjs`) til å:

1. Be en modell (`gpt-5.6-luna`, kan overstyres med `AZURE_FOUNDRY_BRUKTBAAT_MODEL`) som
   kjører i Microsoft (Azure) AI Foundry – med websøk aktivert i *agentisk* modus
   (`reasoning.effort: "medium"`, kan overstyres med
   `AZURE_FOUNDRY_BRUKTBAAT_REASONING_EFFORT`) – søke på Google (bl.a. med
   `site:finn.no seilbåt til salgs`), faktisk åpne og lese hver kandidat-annonse (ikke
   bare søketreff-snippeten), og sammenligne dem på pris, størrelse, alder og utstyr. Uten
   `reasoning.effort` satt kjører web-søket kun i "rask" modus (sender søket videre og
   leser treff-snippets) og kan ikke åpne selve annonsesidene – da svarer modellen heller
   at den ikke fant nok informasjon enn å dikte opp tall.

   **Kvote-/rate limit-begrensning:** Websøk + agentisk reasoning er tunge kall, og
   `gpt-5.6-luna`-deploymentet kan ha en relativt lav TPM/RPM-kvote. Skriptet venter og
   prøver på nytt (inntil 4 ganger, med økende ventetid) ved 429-feil, men gjentatte
   manuelle testkjøringer rett etter hverandre kan likevel tømme kvoten. Vedvarende
   429-feil selv med god margin mellom kjøringer betyr at deploymentets kvote bør økes i
   Azure AI Foundry-portalen (Models + endpoints → gpt-5.6-luna → Edit → juster
   tokens-per-minute), eller at et annet deployment med mer ledig kapasitet bør brukes.
2. Velge ut de 3 annonsene som fremstår som best verdi for pengene, og skrive en artikkel
   (400–600 ord) om dem med lenke til hver annonse og en tydelig merknad om at
   Finn.no-annonser kan bli solgt eller fjernet når som helst.
3. Skrive svaret som en ny Markdown-fil i `src/content/artikler/`
   (`ukens-bruktbaat-tips-ÅÅÅÅ-MM-DD.md`) med gyldig frontmatter, og committe/pushe den
   direkte til hovedgrenen med commit-meldingen `Ukens bruktbåt-tips ÅÅÅÅ-MM-DD`.

Workflowen bruker de samme `AZURE_FOUNDRY_ENDPOINT`- og `AZURE_FOUNDRY_API_KEY`-secretene
som de andre workflowene. Samme forutsetninger som for `daglig-seilartikkel.yml` gjelder
ellers: `contents: write`-rettigheten er satt i workflowen, men en eventuell branch
protection-regel kan likevel blokkere direkte push fra Actions, og kjøringen kan trigges
manuelt via `workflow_dispatch`.

## Instagram-innlegg for nye artikler (automatisk)

En egen GitHub Action (`.github/workflows/instagram-post.yml`) lager og publiserer et
Instagram-innlegg hver gang en ny artikkel legges til i `src/content/artikler/` – enten
av `daglig-seilartikkel.yml`/`ukentlig-bruktbaat-tips.yml`, eller ved en manuell commit.
Workflowen bruker `scripts/post-instagram.mjs` til å:

1. Be tekstmodellen i Azure AI Foundry (samme `gpt-5.6-luna`-deployment som artiklene
   skrives med) om å lage en norsk Instagram-bildetekst (inkl. hashtags) og en engelsk
   bildegenereringsprompt, basert kun på den ferdigskrevne artikkelen.
2. Generere et fotorealistisk bilde ut fra den promptet med en Azure OpenAI-bildemodell
   (gpt-image-serien, f.eks. `gpt-image-2.5-sunburst`), lagre det i
   `public/instagram/<slug>.png`, og committe/pushe det med én gang. Det gjøres for at
   bildet skal få en offentlig URL (`raw.githubusercontent.com`) Instagram kan hente det
   fra, uten å måtte vente på at Cloudflare bygger og deployer nettsiden. **Krever at
   repoet er offentlig** – Instagrams servere kan ikke hente bilder fra
   `raw.githubusercontent.com` i et privat repo.
3. Publisere et bilde-innlegg på Instagram via **Instagram API with Instagram Login**
   (Metas offisielle Content Publishing API) – gratis, ingen abonnement, ingen
   tredjepartsverktøy.

**Trigger:** Både `daglig-seilartikkel.yml` og `ukentlig-bruktbaat-tips.yml` committer med
standard `GITHUB_TOKEN`, og slike pushes trigger *ikke* andre workflowers `on: push`
(GitHubs innebygde løkke-beskyttelse). `instagram-post.yml` bruker derfor `workflow_run`
for å kjede seg pålitelig etter dem, i tillegg til en vanlig `push`-trigger (som fanger
opp en artikkel du selv committer manuelt) og `workflow_dispatch` (for manuell testing av
én bestemt fil).

### Nødvendige secrets (Settings → Secrets and variables → Actions)

I tillegg til `AZURE_FOUNDRY_ENDPOINT`/`AZURE_FOUNDRY_API_KEY` (allerede satt for de andre
workflowene), trengs:

**Azure OpenAI – bildemodell (deployet på SAMME ressurs/prosjekt som tekstmodellen):**

- `AZURE_FOUNDRY_IMAGE_ENDPOINT` – samme verdi som `AZURE_FOUNDRY_ENDPOINT`. Bildemodellen må
  deployes på samme Foundry-ressurs/prosjekt som `gpt-5.6-luna`, ikke en separat Azure
  OpenAI-ressurs, siden skriptet bruker Azures versjonsløse v1-API
  (`/openai/v1/images/generations`, `Authorization: Bearer`, ingen `api-version`) – samme
  mønster som allerede fungerer for tekstmodellen mot `/openai/v1/responses`.
- `AZURE_FOUNDRY_IMAGE_API_KEY` – kan være samme verdi som `AZURE_FOUNDRY_API_KEY`.
- `AZURE_FOUNDRY_IMAGE_MODEL` – navnet på **deployment**en av bildemodellen (f.eks.
  `gpt-image-2.5-sunburst`), slik den heter under "Deployments" i Foundry-portalen.

Valgfrie: `AZURE_FOUNDRY_IMAGE_SIZE` (standard `1024x1024`), `AZURE_FOUNDRY_IMAGE_OUTPUT_FORMAT`
(standard `png`), `AZURE_FOUNDRY_IMAGE_OUTPUT_COMPRESSION` (standard `100`),
`AZURE_FOUNDRY_INSTAGRAM_MODEL` (overstyrer tekstmodellen, standard `gpt-5.6-luna`).

Sjekk kvote for deploymentet under "Models + endpoints" i Foundry-portalen dersom kall
avvises, og be om økt kvote (eller velg en annen gpt-image-variant med ledig kvote).

**Instagram (Instagram API with Instagram Login):**

- `IG_ACCESS_TOKEN` – access-tokenet (starter med `IGAA...`) generert for
  Instagram-kontoen i Meta for Developers, med tilgang til
  `instagram_business_basic` og `instagram_business_content_publish`.
- `IG_USER_ID` – den numeriske Instagram-bruker-ID-en som vises sammen med
  kontoen når tokenet genereres.

Valgfri: `IG_GRAPH_API_VERSION` (standard `v21.0`).

Kort oppsett (gjøres i [Meta for Developers](https://developers.facebook.com/)):

1. Konverter Instagram-kontoen til en Business- eller Creator-konto (kreves for
   API-tilgang – en vanlig privat konto virker ikke).
2. Opprett en Meta-app, legg til produktet **Instagram** med "Instagram API with
   Instagram Login", og generer et access token med rettighetene nevnt over
   direkte i app-dashbordet (ingen Facebook-side involvert).
3. **Viktig:** tokens generert her kan være kortlevde – sjekk utløpsdato i
   Meta-dashbordet og bytt til et *long-lived* token (varer ~60 dager) via
   `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token`
   om nødvendig. Det er ikke satt opp noen automatisk fornyelse i dette
   repoet ennå, så tokenet må fornyes manuelt før det utløper.

Kjøringen kan trigges manuelt via **Actions → Instagram-innlegg for ny artikkel →
Run workflow**, med filstien til en artikkel i feltet `artikkel_fil`, for å teste hele
kjeden (bildegenerering + publisering) uten å vente på neste automatiske artikkel.

## Seilruteplan (automatisk ruteplanlegging basert på vær)

En egen samling `seilvarsel` i `src/content/seilvarsel/` (skjema i `src/content.config.ts`,
vises på `/seilvarsel`) inneholder seilruteplaner for strekningen Oslo–Drøbak–Færder–
Hvaler–Kosterøyene.

En GitHub Action (`.github/workflows/seilruteplanlegger.yml`) kjører hver 3. dag rundt
kl. 07:00 norsk tid og bruker `scripts/seilruteplanlegger.mjs` (ren Node.js, ingen
ekstra npm-avhengigheter) til å:

1. Hente værdata (vind, kast, bølgehøyde, nedbør) direkte fra MET Norways
   locationforecast- og oceanforecast-API-er, og tidevannsdata (høyvann/lavvann,
   klokkeslett og høyde relativt til sjøkartnull) fra Kartverkets tidevanns-API
   (`vannstand.kartverket.no`), for de 5 faste målepunktene og de neste 5 dagene.
   Alt aggregeres deterministisk til tallverdier per dag (ingen KI involvert i selve
   tallknusingen) – høyvann/lavvann finnes ved å lete etter lokale topp-/bunnpunkter i
   tidevannskurven fra Kartverket.
2. Sende disse tallene, sammen med en navigatør-/værvarsler-persona fra
   `.github/prompts/seilruteplanlegger-persona.md`, til en GPT-modell som kjører i
   Microsoft (Azure) AI Foundry, og be den skrive en rapport med seilføring per dag,
   segmentvise ruteanbefalinger (inkl. tidevann/strøm, særlig ved Drøbaksundet),
   optimal timing sydover/nordover, en konfidensvurdering (høy for dag 1–2, usikker
   for dag 3–5) og én konkret anbefaling.
3. Skrive svaret som en ny Markdown-fil i `src/content/seilvarsel/` med gyldig
   frontmatter (skriptet validerer formatet før filen skrives), og
   committe/pushe den direkte til hovedgrenen.

Persona-filen inneholder også en standard båtprofil (lettere 35-fots sloop, 2 i
besetning, unngår >15–18 m/s) som styrer hvor forsiktige rådene er – juster denne filen
direkte dersom rådene skal tilpasses en annen båt.

For at workflowen skal virke må repoet ha disse tre secretene (Settings → Secrets and
variables → Actions):

- `AZURE_FOUNDRY_ENDPOINT` – prosjekt-/ressurs-endepunktet fra Azure AI Foundry (f.eks.
  `https://<ressursnavn>.services.ai.azure.com` eller
  `https://<ressursnavn>.services.ai.azure.com/api/projects/<prosjektnavn>` –
  skriptet legger selv på `/openai/v1/chat/completions`).
- `AZURE_FOUNDRY_API_KEY` – API-nøkkelen til ressursen/prosjektet.
- `AZURE_FOUNDRY_MODEL` – navnet på **deployment**en av GPT-modellen (ikke
  nødvendigvis samme som modellnavnet), slik den heter under "Models + endpoints" i
  Foundry-portalen.

Valgfrie secrets/miljøvariabler for å justere kallet til modellen:

- `AZURE_FOUNDRY_MAX_TOKENS` – overstyrer `max_completion_tokens` (standard 16000).
  Reasoning-modeller (bl.a. gpt-5-familien) bruker en ukjent andel av dette budsjettet
  på skjulte resonnement-tokens før selve svarteksten – for lavt tall gir et tomt svar
  med `finish_reason: "length"`.
- `AZURE_FOUNDRY_TEMPERATURE` – setter `temperature` (utelates helt som standard, siden
  enkelte reasoning-modeller avviser parameteren uansett verdi).

I tillegg må GitHub Actions ha lov til å pushe direkte til hovedgrenen (`contents:
write`-rettigheten er satt i workflowen, men en eventuell branch protection-regel på
hovedgrenen kan likevel blokkere direkte push fra Actions). Workflowen kan også trigges
manuelt via `workflow_dispatch`, og skriptet kan kjøres lokalt for feilsøking med
`AZURE_FOUNDRY_ENDPOINT=... AZURE_FOUNDRY_API_KEY=... AZURE_FOUNDRY_MODEL=... node scripts/seilruteplanlegger.mjs`.

## Værvarsel (yr.no / MET Norway)

Værsiden (`/vaer`) henter data fra [MET Norways Locationforecast API](https://api.met.no)
(kjent fra Yr.no) via Worker-koden i `worker/weather.js`, kalt fra `worker/index.js` når en
forespørsel treffer `/api/weather`. Alle andre forespørsler serveres som statiske filer fra
`dist/` via `env.ASSETS`. Funksjonen:

- Kjører på Cloudflares kant (edge), så ingen API-nøkkel eller hemmelighet trengs.
- Setter en identifiserbar `User-Agent`-header slik MET Norways
  [brukervilkår](https://api.met.no/doc/TermsOfService) krever.
- Cacher svar i 10 minutter for å holde seg innenfor MET sine bruksgrenser.
- Regner ut min/maks temperatur, maks vind, nedbør og et symbol per dag, samt enkle
  seiltips basert på forholdene.

**Husk:** Oppdater `MET_USER_AGENT`-konstanten i `worker/weather.js` med riktig
kontakt-URL/e-post for din utgivelse, i tråd med MET sine retningslinjer.

Værdata er lisensiert under [NLOD](https://data.norge.no/nlod/no) – attribusjon til MET
Norway/Yr.no vises i bunnteksten og på værsiden.

Stedene i værvelgeren (Oslofjorden, Drøbak, Moss, Fredrikstad/Hvaler, Halden, Strömstad og
Kosterøyene) er definert i `src/data/locations.ts` – legg gjerne til flere punkter langs
strekningen der.

## Værkart (Windy Map Forecast API)

Forsiden viser et live vind-/værkart via [Windys Map Forecast API](https://api.windy.com),
implementert i `src/components/WindyMap.astro` og sentrert på strekningen Oslofjorden til
Kosterøyene (`lat: 59.4, lon: 10.9, zoom: 8`).

- Nøkkelen leses fra miljøvariabelen `PUBLIC_WINDY_API_KEY` (`PUBLIC_`-prefikset gjør at
  Astro bygger den inn i klient-bundlen, siden Windy sitt kart kjører i nettleseren).
- Lokalt: kopier `.env.example` til `.env` og sett din egen nøkkel. `.env` er gitignored og
  committes aldri.
- I produksjon: nøkkelen må settes som **Build-variabel** i Cloudflare (se under), siden den
  trengs når `npm run build` kjører – ikke bare ved kjøretid.
- Hent en nøkkel på [api.windy.com/keys](https://api.windy.com/keys) – velg nøkkeltypen
  **"Map Forecast API"** (ikke Point Forecast eller Webcams), og begrens den til ditt domene
  i Windy sin nøkkeladministrasjon.
- Mangler nøkkelen (f.eks. i en forhåndsvisning uten variabelen satt), viser komponenten en
  enkel fallback-tekst i stedet for et tomt kart.

## Publisere på Cloudflare

Prosjektet deployes som en **Cloudflare Worker med statiske assets**, konfigurert via
`wrangler.jsonc` i rotmappen. Dette er Cloudflares nyeste, samlede modell for
Git-tilkoblede nettsteder (etterfølgeren til klassisk "Pages"), og bruker
`npx wrangler versions upload` som deploy-kommando.

1. Push repoet til GitHub/GitLab.
2. Gå til **Cloudflare Dashboard → Workers & Pages → Create → Connect to Git**, og velg
   dette repoet.
3. I prosjektinnstillingene (Settings → Build):
   - **Build command:** `npm run build` (bygger Astro-siden til `./dist` – dette må settes
     eksplisitt, ellers finnes ikke `dist/` når Wrangler skal deploye).
   - **Deploy command:** `npx wrangler versions upload` (dette er som regel forhåndsutfylt).
   - **Environment variables (Build):** legg til `PUBLIC_WINDY_API_KEY` med din Windy
     Map Forecast-nøkkel (se avsnittet om værkartet over) – den må være satt her siden
     Astro bygger den inn i siden under `npm run build`, ikke i selve Workeren.
4. `wrangler.jsonc` forteller Wrangler hva som skal deployes:
   - `main: "worker/index.js"` – Worker-koden som ruter `/api/weather` og ellers serverer
     statiske filer.
   - `assets.directory: "./dist"` – selve Astro-bygget.
5. Deploy. Sjekk byggeloggen – du skal se både en `npm run build`-steg og en vellykket
   `wrangler versions upload` uten "Missing entry-point"-feil.

### Koble til seiltips.no

1. I det publiserte Worker-prosjektet: **Custom domains → Set up a custom domain** (evt.
   under **Triggers** hvis prosjektet vises som en ren Worker).
2. Legg til `seiltips.no` (og evt. `www.seiltips.no`).
3. Hvis domenet allerede ligger i Cloudflare, blir DNS-oppføringene lagt til automatisk.
   Ligger domenet hos en annen registrar, følg instruksjonene Cloudflare gir for
   CNAME/DNS-oppsett.
4. Vent på DNS-propagering og SSL-sertifikat (går som regel raskt når domenet er i
   Cloudflare fra før).

### Lokal test av selve Workeren

```bash
npm run build
npx wrangler dev --local
```

Dette starter en lokal Worker som ruter `/api/weather` og serverer resten fra `dist/`,
akkurat som i produksjon.

## Struktur

```
.github/workflows/  daglig-seilartikkel.yml – automatisk artikkelpublisering
                    ukentlig-bruktbaat-tips.yml – ukentlig bruktbåt-tips (søndager)
                    instagram-post.yml – Instagram-innlegg for nye artikler
                    seilruteplanlegger.yml – automatisk seilruteplan (vær)
                    keyword-analysis.yml – ukentlige nøkkelordforslag (Search Console)
.github/prompts/     seilruteplanlegger-persona.md – navigatør-persona/båtprofil
                    keyword-analysis.md – promptmal for søkeordanalysen
scripts/             seilruteplanlegger.mjs – henter værdata + kaller Azure AI Foundry
                    ukentlig-bruktbaat-tips.mjs – søker Finn.no + kaller Azure AI Foundry
                    post-instagram.mjs – bildetekst + AI-bilde + publisering til Instagram
                    fetch_search_console.py – henter søkeord-data fra Search Console
                    generate_keyword_suggestions.py – nøkkelordforslag via Azure AI Foundry
keyword-suggestions.json  Artikkelforslag fra søkeordanalysen (brukes av artikkelagenten)
requirements.txt    Python-avhengigheter for keyword-analysis-agent
src/
  components/        Header, Footer, ArtikkelCard, SeilvarselCard
  content/artikler/   Utdypende artikler (Markdown, ofte auto-generert)
  content/seilvarsel/ Seilruteplaner (Markdown, auto-generert hver 3. dag)
  data/               Steder for værvarsel
  layouts/            Felles sidemal
  pages/              Forside, artikler, seilvarsel, vær, seiling-1-2-3, båter
worker/             Cloudflare Worker: index.js ruter forespørsler,
                    weather.js er værproxyen mot MET Norway
wrangler.jsonc      Deploy-konfigurasjon (Worker-entry + assets-mappe)
```
