import { defineConfig, type Plugin } from "vite";

// One policy, built once, so the development server and the shipped build cannot
// drift apart. It used to live only in `server.headers`, which Vite applies to
// `vite dev` and nothing else: the build that anyone actually deploys carried no
// CSP at all. That is the wrong way round. The dev CSP has already earned its
// keep -- it is what caught the `new Function` call recorded in
// docs/SDK_NOTES.md -- and the store this wallet keeps its guardian
// capabilities in states plainly that an XSS on this origin can use its key
// (src/storage/encryptedStore.ts). The deployed page is exactly where that
// matters.
//
// Directive notes:
// - `script-src 'self'`: no inline script, no `eval`, no `new Function`.
// - `style-src`: Vite injects CSS through an inline style element while
//   developing. The build emits a same-origin stylesheet, so production drops
//   `'unsafe-inline'` rather than inheriting a development affordance. React's
//   `style={{...}}` props are CSSOM writes and are not governed by this.
// - `connect-src` allows any HTTPS origin because the RPC, bundler, and explorer
//   are user-chosen in Developer settings; `http://localhost:*` reaches a
//   locally-run sponsor relay, and `ws://localhost:*` is the dev HMR socket.
// - `img-src` allows HTTPS so collectible artwork from the configured explorer
//   or gateway renders.
export function contentSecurityPolicy(options: { development: boolean; asMetaTag: boolean }): string {
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "script-src 'self'",
    `style-src 'self'${options.development ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data: https:",
    "connect-src 'self' https: http://localhost:* ws://localhost:*",
    "font-src 'self'",
    "manifest-src 'self'"
  ];
  // `frame-ancestors` is ignored when a policy arrives in a meta tag, so it is
  // only emitted where it is honoured. A host serving this build must send it as
  // a real header; README's deployment section says so.
  if (!options.asMetaTag) directives.splice(3, 0, "frame-ancestors 'none'");
  return directives.join("; ");
}

// The meta tag is what survives `vite build`. Serving it as a header as well is
// strictly better, and the README asks hosts to do that, but a policy that
// depends on the host getting its configuration right is a policy that is
// usually absent.
function contentSecurityPolicyTag(): Plugin {
  return {
    name: "loom-content-security-policy",
    transformIndexHtml(html, context) {
      return {
        html,
        tags: [{
          tag: "meta",
          attrs: {
            "http-equiv": "Content-Security-Policy",
            content: contentSecurityPolicy({ development: context.server !== undefined, asMetaTag: true })
          },
          injectTo: "head-prepend"
        }]
      };
    }
  };
}

export default defineConfig({
  plugins: [contentSecurityPolicyTag()],
  build: { target: "es2022", sourcemap: true },
  server: { headers: { "Content-Security-Policy": contentSecurityPolicy({ development: true, asMetaTag: false }) } },
  preview: { headers: { "Content-Security-Policy": contentSecurityPolicy({ development: false, asMetaTag: false }) } }
});
