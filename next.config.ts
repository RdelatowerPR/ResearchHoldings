/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,  // Skip TypeScript errors during build
  },
  eslint: {
    ignoreDuringBuilds: true, // Skip ESLint errors during build
  },
};

export default nextConfig;
