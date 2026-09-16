# Seiltips.no

Nettsiden for Seiltips.no – værvarsel, seiltips og nyheter for norske seilere. Bygget med
[Astro](https://astro.build) + [Tailwind CSS](https://tailwindcss.com), og laget for å
publiseres på [Cloudflare Pages](https://pages.cloudflare.com).

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

## Værvarsel (yr.no / MET Norway)

Værsiden (`/vaer`) henter data fra [MET Norways Locationforecast API](https://api.met.no)
(kjent fra Yr.no) via en Cloudflare Pages Function i `functions/api/weather.js`. Funksjonen:

- Kjører på Cloudflares kant (edge), så ingen API-nøkkel eller hemmelighet trengs.
- Setter en identifiserbar `User-Agent`-header slik MET Norways
  [brukervilkår](https://api.met.no/doc/TermsOfService) krever.
- Cacher svar i 10 minutter for å holde seg innenfor MET sine bruksgrenser.
- Regner ut min/maks temperatur, maks vind, nedbør og et symbol per dag, samt enkle
  seiltips basert på forholdene.

**Husk:** Oppdater `MET_USER_AGENT`-konstanten i `functions/api/weather.js` med riktig
kontakt-URL/e-post for din utgivelse, i tråd med MET sine retningslinjer.

Værdata er lisensiert under [NLOD](https://data.norge.no/nlod/no) – attribusjon til MET
Norway/Yr.no vises i bunnteksten og på værsiden.

Stedene i værvelgeren (Oslofjorden, Kristiansand, Bergen, osv.) er definert i
`src/data/locations.ts` – legg gjerne til flere kyststrekninger der.

## Publisere på Cloudflare Pages

1. Push repoet til GitHub/GitLab.
2. Gå til **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**, og
   velg dette repoet.
3. Byggeinnstillinger:
   - **Framework preset:** Astro
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
4. `functions/`-mappen plukkes opp automatisk av Cloudflare Pages som en Pages Function
   (ingen ekstra konfigurasjon nødvendig for `/api/weather`).
5. Deploy.

### Koble til seiltips.no

1. I det publiserte Pages-prosjektet: **Custom domains → Set up a custom domain**.
2. Legg til `seiltips.no` (og evt. `www.seiltips.no`).
3. Hvis domenet allerede ligger i Cloudflare, blir DNS-oppføringene lagt til automatisk.
   Ligger domenet hos en annen registrar, følg instruksjonene Cloudflare gir for
   CNAME/DNS-oppsett.
4. Vent på DNS-propagering og SSL-sertifikat (går som regel raskt når domenet er i
   Cloudflare fra før).

## Struktur

```
src/
  components/     Header, Footer, NewsCard
  content/news/   Nyhetsartikler (Markdown)
  data/           Steder for værvarsel
  layouts/        Felles sidemal
  pages/          Forside, nyhetsarkiv, vær, seiling-1-2-3, båter
functions/api/    Cloudflare Pages Function (værproxy mot MET Norway)
```
