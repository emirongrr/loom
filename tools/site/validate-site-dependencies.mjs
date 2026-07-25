import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const siteRoot = join(root, "docs", "site");
const requireFromSite = createRequire(join(siteRoot, "package.json"));
const sitePackage = JSON.parse(readFileSync(join(siteRoot, "package.json"), "utf8"));

assertInstalledOverride("postcss");
assertInstalledOverride("react-router");

const router = await import(pathToFileURL(requireFromSite.resolve("react-router")));
for (const name of [
  "createBrowserRouter",
  "RouterProvider",
  "createStaticHandler",
  "createStaticRouter",
  "Route",
  "Routes",
  "StaticRouter",
  "StaticRouterProvider",
  "ScrollRestoration",
  "useLocation",
  "useNavigate",
  "Link",
  "matchRoutes",
  "matchPath",
  "useMatch"
]) {
  if (!(name in router)) throw new Error(`react-router override is missing Vocs API ${name}`);
}

console.log("validated website dependency overrides and Vocs router API compatibility");

function assertInstalledOverride(name) {
  const manifestPath = requireFromSite.resolve(`${name}/package.json`);
  const installed = JSON.parse(readFileSync(manifestPath, "utf8")).version;
  const expected = sitePackage.overrides?.[name];
  if (!expected || installed !== expected) {
    throw new Error(`${name} override mismatch: expected ${expected ?? "missing"}, received ${installed}`);
  }
}
