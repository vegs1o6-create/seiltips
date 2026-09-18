# Bildebibliotek for Seiltips.no

Legg bilder rett inn i mappene under (via GitHub sin nettside – "Add file" →
"Upload files" – eller `git add`/`git push`). Så snart et bilde ligger i riktig
mappe med riktig filnavn, plukker nettsiden det automatisk opp – ingen
kodeendring nødvendig.

**Filformat:** `.jpg`, `.jpeg`, `.png`, `.webp` eller `.avif`.
**Filnavn:** alltid små bokstaver, uten mellomrom eller æøå (bruk `ae`/`oe`/`aa`
eller bindestrek).
**Størrelse:** liggende bilder (bredde > høyde) fungerer best. Rundt
1200–1600 px bredde er nok – ingen grunn til å laste opp rådata fra kamera.

## artikler/

Ett bilde per artikkel, som toppbilde på artikkelsiden og miniatyrbilde i
artikkellisten. Filnavnet må være **nøyaktig samme navn som artikkel-filen**
i `src/content/artikler/` (uten `.md`), for eksempel:

- `slik-kjoper-du-brukt-seilbaat.jpg`
- `valg-av-redningsvest-for-seilere.jpg`

Har en artikkel ikke noe bilde her, brukes automatisk det AI-genererte
Instagram-bildet for artikkelen (`public/instagram/<samme-navn>.png`) hvis
det finnes, ellers vises artikkelen uten bilde som i dag.

## baater/

Ett bilde per båttype, vist på båttype-oversikten og øverst på hver
båttype-side. Filnavnet må matche siste del av URL-en til båttypen:

- `daysailer-jolle.jpg`
- `kjolbaat-turseiler.jpg`
- `motorseiler.jpg`
- `racer-regattabaat.jpg`

## havner/

Ett bilde per havn/uthavn på havnetips-siden (`/seiling-1-2-3/havnetips`).
Se `slug`-verdien for hver havn i `src/pages/seiling-1-2-3/havnetips.astro`
for riktig filnavn, for eksempel:

- `oslo-frognerkilen.jpg`
- `drobak.jpg`
- `steilene.jpg`
- `sandspollen.jpg`
- `middagsbukta.jpg`
- `son.jpg`
- `skjaerhalden.jpg`
- `stromstad.jpg`
- `kosteroyene.jpg`

(full liste med alle slugs finnes i samme fil)

## generelt/

Frittstående bilder som ikke er knyttet til én bestemt artikkel/båt/havn,
f.eks. et headerbilde på forsiden. Ta kontakt (eller be Claude om det) når du
har lagt inn noe her, så kobles det til riktig sted på siden.

---

Rettigheter: bruk kun bilder du selv har tatt eller har lov til å bruke fritt
(eget innhold, kjøpte lisenser, eller bilder med en lisens som tillater bruk
på en kommersiell nettside).
