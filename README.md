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
kl. 21:30 norsk tid og bruker [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
til å:

1. Se på hva som allerede er publisert i `src/content/news/` og `src/content/artikler/`
   for å unngå å skrive om samme tema på nytt.
2. Research aktuelle, sesongrelevante seilertemaer på nettet (vær, sikkerhet,
   praktiske tips, båtvedlikehold, miljø, norske seilingsdestinasjoner) og notere ned
   kildene som brukes.
3. Skrive en ny Markdown-fil i `src/content/artikler/` med gyldig frontmatter, og
   committe/pushe den direkte til hovedgrenen.

Claude kjører via [Microsoft Foundry](https://ai.azure.com/) (Azure AI Foundry), ikke
direkte mot Anthropics API. For at workflowen skal virke må repoet ha disse secretene
(Settings → Secrets and variables → Actions):

- `ANTHROPIC_FOUNDRY_API_KEY` – API-nøkkelen fra **Endpoints and keys** på
  Foundry-ressursen din i [Microsoft Foundry-portalen](https://ai.azure.com/).
- `ANTHROPIC_FOUNDRY_RESOURCE` – navnet på Foundry-ressursen (samme navn som i
  ressurs-URL-en, ikke hele URL-en).

Foundry-ressursen må ha en deployment av modellen som brukes i workflowen
(`claude-sonnet-5`). GitHub Actions må også ha lov til å pushe direkte til
hovedgrenen (`contents: write`-rettigheten er satt i workflowen, men en eventuell
branch protection-regel på hovedgrenen kan likevel blokkere direkte push fra Actions).
Du kan også trigge kjøringen manuelt fra fanen **Actions** i GitHub (`workflow_dispatch`).

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

Stedene i værvelgeren (Oslofjorden, Kristiansand, Bergen, osv.) er definert i
`src/data/locations.ts` – legg gjerne til flere kyststrekninger der.

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
src/
  components/        Header, Footer, NewsCard, ArtikkelCard
  content/news/       Nyhetsartikler (Markdown)
  content/artikler/   Utdypende artikler (Markdown, ofte auto-generert)
  data/               Steder for værvarsel
  layouts/            Felles sidemal
  pages/              Forside, nyhetsarkiv, artikler, vær, seiling-1-2-3, båter
worker/             Cloudflare Worker: index.js ruter forespørsler,
                    weather.js er værproxyen mot MET Norway
wrangler.jsonc      Deploy-konfigurasjon (Worker-entry + assets-mappe)
```
