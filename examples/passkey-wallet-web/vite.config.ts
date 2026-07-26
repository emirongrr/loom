import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022", sourcemap: true },
  server: {
    headers: {
      // Vite injects CSS through a development-only style element. The
      // production build emits a same-origin stylesheet and can drop
      // `unsafe-inline`; executable script remains strict in both modes.
      // connect-src allows any HTTPS origin because the RPC, bundler, and
      // explorer are user-configurable in Developer settings; localhost is kept
      // for a locally-run sponsor relay. Every other directive stays strict.
      "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: http://localhost:* ws://localhost:*; font-src 'self'; manifest-src 'self'"
    }
  }
});
