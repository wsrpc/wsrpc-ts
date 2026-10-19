import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { rollup } from "rollup";
import { babel } from "@rollup/plugin-babel";
import terser from "@rollup/plugin-terser";

const root = "packages/client";
await mkdir(`${root}/lib`, { recursive: true });
await copyFile(`${root}/wsrpc.es6.js`, `${root}/lib/browser.js`);
await copyFile(`${root}/src/browser.d.ts`, `${root}/lib/browser.d.ts`);
await copyFile(`${root}/src/browser.d.cts`, `${root}/lib/browser.d.cts`);
await writeFile(`${root}/lib/package.json`, '{"type":"module"}\n');
const bundle = await rollup({
  input: `${root}/wsrpc.es6.js`,
  plugins: [
    babel({
      babelHelpers: "bundled",
      babelrc: false,
      configFile: false,
      presets: [
        ["@babel/preset-env", { targets: { ie: "11" }, modules: false }],
      ],
    }),
  ],
});
try {
  const options = {
    format: "umd",
    name: "WSRPC",
    exports: "default",
    sourcemap: true,
  };
  await bundle.write({ ...options, file: `${root}/dist/wsrpc.js` });
  await bundle.write({
    ...options,
    file: `${root}/dist/wsrpc.min.js`,
    plugins: [terser()],
  });
} finally {
  await bundle.close();
}
await copyFile(`${root}/wsrpc.es6.js`, `${root}/dist/wsrpc.es6.js`);
