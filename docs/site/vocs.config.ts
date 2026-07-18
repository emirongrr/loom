import { defineConfig } from 'vocs'

// eslint-disable-next-line import/no-default-export
export default defineConfig({
  title: 'Loom',
  titleTemplate: '%s · Loom',
  description: 'Self-sovereign wallet infrastructure for Ethereum',
  rootDir: '.',
  font: {
    google: 'Inter',
  },
  editLink: {
    pattern: 'https://github.com/emirongrr/loom/edit/main/docs/site/pages/:path',
    text: 'Suggest changes to this page',
  },
  topNav: [
    {
      text: 'Getting Started',
      link: '/getting-started',
    },
    {
      text: 'SDK',
      link: '/sdk',
    },
    {
      text: 'Operations',
      link: '/operations',
    },
    {
      text: 'Security',
      link: '/security',
    },
  ],
  // Task-oriented information architecture: start, build, operate, understand.
  sidebar: [
    {
      text: 'Start',
      items: [
        {
          text: 'Getting Started',
          link: '/getting-started',
        },
      ],
    },
    {
      text: 'Build',
      items: [
        {
          text: 'SDK',
          link: '/sdk',
        },
      ],
    },
    {
      text: 'Operate',
      items: [
        {
          text: 'CLI & devnet',
          link: '/operations',
        },
      ],
    },
    {
      text: 'Understand',
      items: [
        {
          text: 'Security',
          link: '/security',
        },
        {
          text: 'Comparisons',
          link: '/comparisons',
        },
      ],
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
  socials: [
    {
      icon: 'github',
      link: 'https://github.com/emirongrr/loom',
    },
  ],
  theme: {
    // Mint reads well on dark backgrounds; a deeper teal keeps accent text and
    // buttons legible in light mode.
    accentColor: {
      light: '#0d7d6f',
      dark: '#91f4c8',
    },
  },
  basePath: '/loom',
})
