import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Abyss',
  description: 'Self-hosted chat with text, voice, screen sharing, watch parties, and role-based permissions.',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Features', link: '/features' },
      { text: 'Deployment', link: '/deployment' },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'API Overview', link: '/api-overview' },
          { text: 'Voice Architecture', link: '/VOICE_ARCHITECTURE' },
          { text: 'Configuration', link: '/configuration' },
        ]
      },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/' },
          { text: 'Local Setup', link: '/getting-started' },
          { text: 'Features', link: '/features' },
        ]
      },
      {
        text: 'Development',
        items: [
          { text: 'Development Workflow', link: '/development' },
          { text: 'Contributing', link: '/contributing' },
        ]
      },
      {
        text: 'Operations',
        items: [
          { text: 'Deployment', link: '/deployment' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Troubleshooting', link: '/troubleshooting' },
        ]
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/architecture' },
          { text: 'API Overview', link: '/api-overview' },
          { text: 'Voice Architecture', link: '/VOICE_ARCHITECTURE' },
        ]
      }
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/msuddaby/Abyss' }
    ],
    search: {
      provider: 'local'
    },
    editLink: {
      pattern: 'https://github.com/msuddaby/Abyss/edit/main/docs/:path',
      text: 'Edit this page on GitHub'
    },
    footer: {
      message: 'Self-hosted, feature-complete, and built for control.',
      copyright: 'Copyright © Abyss contributors'
    },
    outline: {
      level: [2, 3]
    }
  }
})
