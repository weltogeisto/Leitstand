import type { NextConfig } from "next";

const publicDocs = ["./docs/MCP.md", "./docs/API.md", "./docs/AGENTS.md"];

// Vercel copies these into the route functions. The Docker image copies the
// same files itself: `next start` does not unpack this list.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
  outputFileTracingIncludes: {
    "/llms.txt": publicDocs,
    "/docs/[name]": publicDocs,
  },
};

export default nextConfig;
