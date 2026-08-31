import ts from 'typescript'
import { defineConfig, type UserConfig } from 'tsdown'
import { isBuiltin } from 'node:module'

const lowerDecorators={name:'lower-standard-decorators',transform(code:string,id:string){if(!/\.[cm]?tsx?$/.test(id)||!/^\s*@[A-Za-z_$][\w$]*/m.test(code))return;const result=ts.transpileModule(code,{fileName:id,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});return{code:result.outputText}}}

/**
 * Specifiers the browser module table can answer (the dsh platform baseline —
 * mirror of packages/client/web/src/platform.ts in the harness). Everything
 * else MUST inline into the single-file bundle: a require() the table cannot
 * answer is a guaranteed boot-time throw.
 */
const CLIENT_EXTERNALS = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

const nodeHalf: UserConfig = {
  entry: ["src/index.ts", "src/setup.ts", "src/backends/select.ts", "src/backends/interface.ts", "src/backends/errors.ts", "src/backends/native.ts", "src/backends/bridge.ts", "src/db.ts", "src/sender.ts", "src/access.ts", "src/key-tools.ts", "src/k3s-deploy.ts"],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  external: ['@morewax/sam-mesh'],
  plugins: [lowerDecorators],
}

/**
 * The browser face: ONE self-contained CJS file that registers with the dsh
 * module loader (window.__ModuleLoader__.load). This is the artifact the
 * host's client-module registry serves at /plugins/@morewax/dsh-agent-mesh/client.js
 * — the exports['./client'] target. Multi-chunk ESM output cannot work here:
 * the registry serves exactly one file per plugin.
 */
const browserFace: UserConfig = {
  name: '@morewax/dsh-imessage/client',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  // tsdown 0.15 API (our pinned version — the harness's deps.neverBundle/
    // alwaysBundle functions are 0.22+): baseline specifiers stay external
    // (the module table answers them), EVERYTHING else inlines. The noExternal
    // function overrides the production-dep externalization fallback; the
  // post-build contract check (scripts/check-client-bundle.mjs) fails loudly
  // if any non-baseline require() survives anyway.
  external: [...CLIENT_EXTERNALS],
  noExternal: (specifier: string) => !isBuiltin(specifier) && !CLIENT_EXTERNALS.has(specifier),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "@morewax/dsh-imessage", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([nodeHalf])
