import { defineConfig } from 'vocs'

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  title: 'Loom',
  titleTemplate: '%s · Loom',
  description: 'Self-sovereign wallet infrastructure for Ethereum',
  rootDir: '.',
  editLink: {
    pattern: 'https://github.com/emirongrr/loom/edit/main/docs/site/pages/:path',
    text: 'Suggest changes to this page',
  },
  sidebar: [
    {
      text: 'Getting Started',
      link: '/getting-started',
    },
    {
      text: 'SDK',
      link: '/sdk',
    },
    {
      text: 'Comparisons',
      link: '/comparisons',
    },
    {
      text: 'Security',
      link: '/security',
    },
    {
      text: 'LLM Context',
      items: [
        {
          text: 'llms.txt',
          link: '/llms.txt',
        },
        {
          text: 'llms-full.txt',
          link: '/llms-full.txt',
        },
      ],
    },
  ],
  topNav: [
    {
      text: 'GitHub',
      link: 'https://github.com/emirongrr/loom',
    },
  ],
  socials: [
    {
      icon: 'github',
      link: 'https://github.com/emirongrr/loom',
    },
  ],
  theme: {
    accentColor: '#91f4c8',
  },
  basePath: '/loom',
})
