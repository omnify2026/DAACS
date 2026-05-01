from typing import Dict, Any, List

def scaffold_title(auto_spec: Dict[str, Any]) -> str:
    domain = auto_spec.get("domain", "app").replace("_", " ").title()
    return f"{domain} Dashboard"

def scaffold_sections(auto_spec: Dict[str, Any]) -> List[str]:
    sections = auto_spec.get("ui_sections") or []
    return sections if sections else ["summary", "list", "details"]

def frontend_scaffold_page(auto_spec: Dict[str, Any]) -> str:
    title = scaffold_title(auto_spec)
    sections = scaffold_sections(auto_spec)
    sections_literal = ", ".join([f'"{s}"' for s in sections])
    return f"""export default function Page() {{
  const sections = [{sections_literal}];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-5xl px-6 py-10 space-y-8">
        <header className="space-y-2">
          <p className="text-xs uppercase tracking-[0.35em] text-neutral-500">Foundation UI</p>
          <h1 className="text-3xl font-semibold">{title}</h1>
          <p className="text-sm text-neutral-400">
            Scaffold is ready. Implement full features and data wiring next.
          </p>
        </header>
        <section className="grid gap-4 md:grid-cols-2">
          {{sections.map((section) => (
            <div key={{section}} className="rounded-xl border border-neutral-800/60 bg-neutral-900/40 p-4">
              <p className="text-sm font-medium capitalize">{{section}}</p>
              <p className="text-xs text-neutral-500">Section scaffold</p>
            </div>
          ))}}
        </section>
      </div>
    </main>
  );
}}
"""

FRONTEND_SCAFFOLD_LAYOUT = """import "./globals.css";
import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
"""

FRONTEND_SCAFFOLD_CSS = """@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: dark;
  font-family: "Inter", system-ui, sans-serif;
  background: #0b0b0b;
  color: #e5e7eb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background: #0b0b0b;
  color: #e5e7eb;
}
"""

# === CURATED PACKAGE.JSON ===
# These versions are tested and known to work together.
# LLM should NOT modify core dependency versions.
FRONTEND_SCAFFOLD_PACKAGE_JSON = """{
  "name": "daacs-frontend",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.7.0"
  }
}
"""

FRONTEND_SCAFFOLD_NEXT_CONFIG = """/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true
};

module.exports = nextConfig;
"""

FRONTEND_SCAFFOLD_POSTCSS_CONFIG = """module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {}
  }
};
"""

FRONTEND_SCAFFOLD_TAILWIND_CONFIG = """module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {}
  },
  plugins: []
};
"""

FRONTEND_SCAFFOLD_TSCONFIG = """{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": false,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve"
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
"""

FRONTEND_SCAFFOLD_NEXT_ENV = """/// <reference types="next" />
/// <reference types="next/image-types/global" />
"""
