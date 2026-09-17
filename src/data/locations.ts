export interface SailingLocation {
  slug: string;
  name: string;
  lat: number;
  lon: number;
}

export const locations: SailingLocation[] = [
  { slug: 'oslofjorden', name: 'Oslofjorden (Oslo)', lat: 59.9139, lon: 10.7522 },
  { slug: 'droebak', name: 'Drøbak', lat: 59.6647, lon: 10.6088 },
  { slug: 'moss', name: 'Moss', lat: 59.434, lon: 10.6577 },
  { slug: 'fredrikstad-hvaler', name: 'Fredrikstad / Hvaler', lat: 59.1225, lon: 10.9573 },
  { slug: 'halden', name: 'Halden', lat: 59.133, lon: 11.3874 },
  { slug: 'stroemstad', name: 'Strömstad (Sverige)', lat: 58.9337, lon: 11.1631 },
  { slug: 'kosteroeyene', name: 'Kosterøyene (Sverige)', lat: 58.8814, lon: 11.0367 },
];

export const defaultLocation = locations[0];
