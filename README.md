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
kl. 16:25 norsk tid og bruker `scripts/daglig-seilartikkel.mjs` (ren Node.js, samme
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
2. Generere et fotorealistisk bilde ut fra den promptet med en **egen** MAI-bildemodell
   (Microsoft AI, f.eks. `MAI-Image-2.6`) i Microsoft Foundry – en annen modellfamilie
   enn Azure OpenAI sine bildemodeller (gpt-image-1/DALL-E), med sitt eget
   `/mai/v1/images/generations`-endepunkt – lagre bildet i `public/instagram/<slug>.png`,
   og committe/pushe det med én gang. Det gjøres for at bildet skal få en offentlig URL
   (`raw.githubusercontent.com`) Instagram kan hente det fra, uten å måtte vente på at
   Cloudflare bygger og deployer nettsiden.
3. Publisere et bilde-innlegg på Instagram via **Metas offisielle Graph API**
   (Content Publishing API) – dette er den reelt gratis, "offisielle" veien til å
   publisere programmatisk (ikke et tredjepartsverktøy), og krever ingen abonnementer.

**Trigger:** Både `daglig-seilartikkel.yml` og `ukentlig-bruktbaat-tips.yml` committer med
standard `GITHUB_TOKEN`, og slike pushes trigger *ikke* andre workflowers `on: push`
(GitHubs innebygde løkke-beskyttelse). `instagram-post.yml` bruker derfor `workflow_run`
for å kjede seg pålitelig etter dem, i tillegg til en vanlig `push`-trigger (som fanger
opp en artikkel du selv committer manuelt) og `workflow_dispatch` (for manuell testing av
én bestemt fil).

### Nødvendige secrets (Settings → Secrets and variables → Actions)

I tillegg til `AZURE_FOUNDRY_ENDPOINT`/`AZURE_FOUNDRY_API_KEY` (allerede satt for de andre
workflowene), trengs:

**Microsoft Foundry – MAI-bildemodell (egen ressurs/deployment):**

- `AZURE_FOUNDRY_IMAGE_ENDPOINT` – ressurs-endepunktet med MAI-bildemodellen (f.eks.
  `https://<ressursnavn>.services.ai.azure.com`).
- `AZURE_FOUNDRY_IMAGE_API_KEY` – API-nøkkelen til den ressursen.
- `AZURE_FOUNDRY_IMAGE_MODEL` – navnet på **deployment**en av en MAI-bildemodell
  (f.eks. `MAI-Image-2.6`), slik den heter under "Deployments" i Foundry-portalen.

Valgfrie: `AZURE_FOUNDRY_IMAGE_API_VERSION` (standard `2026-07-31` – modellversjonen til
`MAI-Image-2.6`; sjekk "Get code" i Foundry-portalen for deploymentet ditt hvis du bruker
en annen MAI-modell), `AZURE_FOUNDRY_IMAGE_WIDTH`/
`AZURE_FOUNDRY_IMAGE_HEIGHT` (standard `1024`/`1024` – begge må være minst 768, og produktet
kan maks være 1 048 576), `AZURE_FOUNDRY_INSTAGRAM_MODEL` (overstyrer tekstmodellen, standard
`gpt-5.6-luna`).

**Viktig – kvotetier:** MAI-bildemodeller har **0 forespørsler/minutt på standard
"Free"-kvotetier**. Deploymentet må ha minst kvotetier 1 satt i Foundry-portalen
(Models + endpoints → deploymentet → rediger kvote), ellers avvises alle kall.

**Instagram (Meta Graph API):**

- `IG_ACCESS_TOKEN` – en *long-lived* access token med tilgang til
  `instagram_basic`, `instagram_content_publish`, `pages_show_list` og
  `pages_read_engagement` for Facebook-siden som er koblet til Instagram-kontoen.
- `IG_USER_ID` – Instagram Business-/Creator-kontoens numeriske "Instagram Business
  Account ID" (finnes f.eks. via `GET /{page-id}?fields=instagram_business_account`).

Valgfri: `IG_GRAPH_API_VERSION` (standard `v21.0`).

Kort oppsett av Instagram-siden av dette (gjøres i [Meta for Developers](https://developers.facebook.com/)):

1. Konverter Instagram-kontoen til en Business- eller Creator-konto, og koble den til en
   Facebook-side du administrerer (kreves av Graph API – en vanlig privat konto virker ikke).
2. Opprett en Meta-utviklerapp, legg til produktet **Instagram** (Content Publishing), og
   generer en access token med rettighetene nevnt over.
3. Bytt token til en *long-lived* token (varer ~60 dager) via Metas
   `/oauth/access_token`-endepunkt med `grant_type=fb_exchange_token`.
4. **Viktig:** long-lived tokens utløper etter ca. 60 dager og må fornyes manuelt (eller med
   et eget script som kaller forlengelses-endepunktet før utløp) – det er ikke satt opp noen
   automatisk fornyelse i dette repoet ennå.

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
.github/prompts/     seilruteplanlegger-persona.md – navigatør-persona/båtprofil
scripts/             seilruteplanlegger.mjs – henter værdata + kaller Azure AI Foundry
                    ukentlig-bruktbaat-tips.mjs – søker Finn.no + kaller Azure AI Foundry
                    post-instagram.mjs – bildetekst + AI-bilde + publisering til Instagram
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
