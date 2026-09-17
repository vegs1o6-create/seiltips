import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const artikler = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/artikler' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.date(),
    image: z.string().optional(),
    draft: z.boolean().optional().default(false),
    tags: z.array(z.string()).optional(),
    sources: z.array(z.string().url()).optional(),
  }),
});

export const collections = { artikler };
