import { ConfigEnv, Plugin, ResolvedConfig, ViteDevServer } from "vite";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import fs from "fs";
import MagicString from "magic-string";
import { RequestOptions, get as httpGet } from "http";

const pluginName = "vite:logseq-dev-plugin";

function getLogseqPluginId() {
  try {
    const packageJson = fs.readFileSync(
      path.join(process.cwd(), "package.json"),
      "utf-8"
    );

    return JSON.parse(packageJson).logseq.id;
  } catch (err) {
    console.error(`${pluginName}: failed to get valid plugin id`);
  }
}

// TODO: support https?
const request = async (url: string, options: RequestOptions) => {
  let resolve: (body: any) => void;
  let data: any[] = [];
  let promise = new Promise<string>((res) => {
    resolve = res;
  });

  httpGet(url, options, (res) => {
    res.on("data", (chunk) => {
      data.push(chunk);
    });
    res.on("end", () => {
      resolve(Buffer.concat(data).toString());
    });
  });
  return promise;
};

const logseqDevPlugin: (options: {entry: string}) => Plugin = ({entry: entryFile}) => {
  let config: ResolvedConfig;
  let configEnv: ConfigEnv;
  let server: ViteDevServer;
  const pluginId = getLogseqPluginId();

  // eagerly load the HTML file to let it write to the dist
  const tapHtml = async (address: string) => {
    const res = await request(address, {
      method: "GET",
      headers: {
        accept: "text/html",
      },
    });
    return res;
  };

  return {
    name: pluginName,
    enforce: "post",
    apply: 'serve',
    config: async (config, resolvedEnv) => {
      configEnv = resolvedEnv;

      // make sure base is empty, otherwise when running in build mode
      // the asset will be served from the root "/"
      config.base = "";

      // Plugin works in file://, but it fetches vite resources from 127.0.0.1
      // thus we must turn on cors
      if (resolvedEnv.command === "serve") {
        config.server = Object.assign({}, config.server, {
          cors: true,
          // I think we do not need to concern about this ...
          // host: "127.0.0.1",
          // hmr: {
          //   host: "127.0.0.1",
          // },
          // There is no point to open the index.html
          open: false
        });
      }

      return config;
    },

    configureServer(_server) {
      server = _server;
      console.warn(`${pluginName}: got server`);
    },

    configResolved(resolvedConfig) {
      // store the resolved config
      config = resolvedConfig;

      console.warn(`${pluginName}: got config`);
    },

    transform(code, id) {
      console.debug(id,'entry?', entryFile, id.endsWith(entryFile))
      if (
        // server?.moduleGraph.getModuleById(id)?.importers.size === 0 &&
        !/node_modules/.test(id) &&
        id.startsWith(process.cwd()) &&
        id.endsWith(entryFile) &&
        (id.endsWith("ts") || id.endsWith("tsx") || id.endsWith("js") || id.endsWith("jsx"))
      ) {
        const s = new MagicString(code);

        s.append(`\n\n
var top_ref = top;
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // don't actually hot reload, do a cold reload - we just wanted to trigger a plugin reload when the new module is ready
    import.meta.hot.invalidate()

    void (async () => {
      if (!top_ref) return WARN('HMR fail - no top')
      if (top_ref.hmrCheckTimer) {
        console.debug("Debouncing reload bc. of another HMR", top_ref.hmrCheckTimer)
        clearInterval(top_ref.hmrCheckTimer)
      } else {
        console.log('[${pluginId}] update in progress...✨')
      }
      top_ref.hmrCheckTimer = setTimeout(() => {
        console.log('%c✨ [${pluginId}] update ready - reloading ✨', 'font-weight: bold; font-size: 15px; color: purple;')
        top_ref.LSPluginCore.reload('${pluginId}')
        .catch(err => DEBUG('HMR error (probably double HMR race):', err))
        .then(() => {
          // Reload page
          // TODO: is there a way to trigger re-render globally ?
          top_ref.eval(\`(() => {
            let name = logseq.api.get_current_page().originalName;
            //console.debug("✨ Post-HMR -> RELOADING PAGE ✨", name);
            logseq.api.replace_state("home");
            setTimeout(() => logseq.api.replace_state("page", { name }), 300); // sometimes it works without defer, but sometimes it doesn't
          })();\`)
        })
      }, 2000)
    })()
  });
  import.meta.hot.dispose(() => {
    console.debug("HMR Dispose")
  })
}`
        );

// ANOTHER ATTEMPT:
//         s.prepend(`
// top.eval(\`(async () => {
//   console.log("✨ [${pluginId}] startup done. already loaded?", (LSPluginCore.registeredPlugins.has('${pluginId}')));
//   if (LSPluginCore.registeredPlugins.has('${pluginId}')) {
//     await (new Promise(resolve => setTimeout(resolve, 1000)))
//     console.log('%c✨ [${pluginId}] loaded, but already registered - reloading ✨', 'font-weight: bold; font-size: 15px; color: purple;')
//     try {
//       await LSPluginCore.reload('${pluginId}')
//     } catch (err) { DEBUG('HMR error (probably double HMR race):', err); return }

//     // Reload page
//     // TODO: is there a way to trigger re-render globally ?
//     let name = logseq.api.get_current_page().originalName;
//     await (new Promise(resolve => setTimeout(resolve, 1000)))
//     console.debug("✨ [${pluginId}] Post-HMR -> RELOADING PAGE ✨", name);
//     logseq.api.replace_state("home");
//     setTimeout(() => logseq.api.replace_state("page", { name })); // sometimes it works without defer, but sometimes it doesn't
//   }
// })();\`)
// \n\n`
//         );

        // amend entries
        return {
          code: s.toString(),
          map: s.generateMap({ hires: true }),
        };
      }
    },

    // Overwrite dev HTML
    async buildStart() {
      if (configEnv.command === "serve" && server) {
        console.warn(`${pluginName}: buildStart hook`);
        if (!server.httpServer) {
          throw new Error(
            `${pluginName} Only works for non-middleware mode for now`
          );
        }

        server.httpServer.once("listeniXng", () => {
          let address = server.httpServer!.address()!;
          if (typeof address === "object" && address) {
            address = "http://127.0.0.1" + ":" + address.port;
          }
          tapHtml(address as string).then((html) => setTimeout(async () => {
            // Rewrite the base, otherwise assets like `/@vite/client` will
            // subject to default `file://` path
            const baseHref = address;
            const baseString = `<base href="${baseHref}">`;
            const htmlWithBase = html.replace(`<head>`, `<head>${baseString}`);

            await mkdir(config.build.outDir, { recursive: true });
            await writeFile(
              path.resolve(config.build.outDir, "index.html"),
              htmlWithBase,
              {
                encoding: "utf-8",
              }
            );
            console.info(`${pluginName}: Wrote development index.html`);
          }, 3000));
        });
      }
    },
  };
};

export default logseqDevPlugin;
