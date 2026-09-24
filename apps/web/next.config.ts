import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Project rules live in the root CLAUDE.md; don't generate per-app agent files.
  agentRules: false,
}

export default config
