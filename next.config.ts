import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Photos are uploaded and served via signed URLs from private storage.
  // Next's body size limit is not used: /api/upload reads the raw request stream.
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
};

export default nextConfig;