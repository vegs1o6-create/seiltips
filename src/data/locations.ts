export interface SailingLocation {
  slug: string;
  name: string;
  lat: number;
  lon: number;
}

export const locations: SailingLocation[] = [
  { slug: 'oslofjorden', name: 'Oslofjorden (Oslo)', lat: 59.9139, lon: 10.7522 },
  { slug: 'fredrikstad-hvaler', name: 'Fredrikstad / Hvaler', lat: 59.1225, lon: 10.9573 },
  { slug: 'sandefjord', name: 'Sandefjord', lat: 59.1313, lon: 10.2166 },
  { slug: 'arendal', name: 'Arendal', lat: 58.4616, lon: 8.7724 },
  { slug: 'kristiansand', name: 'Kristiansand', lat: 58.1467, lon: 7.9956 },
  { slug: 'stavanger', name: 'Stavanger', lat: 58.9700, lon: 5.7331 },
  { slug: 'bergen', name: 'Bergen', lat: 60.3913, lon: 5.3221 },
  { slug: 'aalesund', name: 'Ålesund', lat: 62.4722, lon: 6.1495 },
  { slug: 'trondheim', name: 'Trondheim', lat: 63.4305, lon: 10.3951 },
  { slug: 'bodo', name: 'Bodø', lat: 67.2804, lon: 14.4049 },
  { slug: 'tromso', name: 'Tromsø', lat: 69.6492, lon: 18.9553 },
];

export const defaultLocation = locations[0];
