import { existsSync } from 'node:fs';
import path from 'node:path';

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif'];

/**
 * Ser etter et bilde i public/bilder/<subdir>/<slug>.<ext> og returnerer den
 * offentlige URL-stien til det (f.eks. "/bilder/artikler/min-artikkel.jpg")
 * dersom det finnes, ellers null. Brukes til å la maler vise bilder når
 * noen har lagt dem i bildebiblioteket, uten å måtte skrive om koden for
 * hvert nye bilde.
 */
export function findImage(subdir: string, slug: string): string | null {
  for (const ext of EXTENSIONS) {
    const relativePath = `bilder/${subdir}/${slug}.${ext}`;
    if (existsSync(path.join(PUBLIC_DIR, relativePath))) {
      return `/${relativePath}`;
    }
  }
  return null;
}

/**
 * Samme som findImage(), men for artikler faller den i tillegg tilbake til
 * det AI-genererte Instagram-bildet i public/instagram/<slug>.png dersom
 * det ikke finnes noe manuelt lagt inn bilde i bildebiblioteket.
 */
export function findArticleImage(slug: string): string | null {
  const fromLibrary = findImage('artikler', slug);
  if (fromLibrary) return fromLibrary;

  const instagramPath = path.join(PUBLIC_DIR, 'instagram', `${slug}.png`);
  return existsSync(instagramPath) ? `/instagram/${slug}.png` : null;
}
