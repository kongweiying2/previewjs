import type { Component, Story } from "@previewjs/component-analyzer-api";
import type { FrameworkPluginFactory } from "@previewjs/core";
import { createTypeAnalyzer } from "@previewjs/type-analyzer";
import { createFileSystemReader, createStackedReader } from "@previewjs/vfs";
import fs from "fs-extra";
import path from "path";
import url from "url";
import { extractVueComponents } from "./extract-component.js";
import { createVueTypeScriptReader } from "./vue-reader.js";

const vue2FrameworkPlugin: FrameworkPluginFactory = {
  isCompatible: async (dependencies) => {
    const version =
      (await dependencies["vue"]?.readInstalledVersion()) ||
      (await dependencies["nuxt"]?.readInstalledVersion());
    if (!version) {
      return false;
    }
    return parseInt(version) === 2;
  },
  async create({ rootDir, reader, logger }) {
    const { loadNuxtConfig } = await import("@nuxt/config");
    const { default: vue2Plugin } = await import("@vitejs/plugin-vue2");
    const { default: vue2JsxPlugin } = await import("@vitejs/plugin-vue2-jsx");
    const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
    const previewDirPath = path.resolve(__dirname, "..", "preview");
    const typeAnalyzer = createTypeAnalyzer({
      rootDir,
      reader: createStackedReader([
        createVueTypeScriptReader(logger, reader),
        createFileSystemReader({
          mapping: {
            from: path.join(previewDirPath, "modules"),
            to: path.join(rootDir, "node_modules"),
          },
          watch: false,
        }),
      ]),
    });
    return {
      pluginApiVersion: 4,
      name: "@previewjs/plugin-vue2",
      defaultWrapperPath: "__previewjs__/Wrapper.vue",
      previewDirPath,
      typeAnalyzer,
      detectComponents: async (absoluteFilePaths) => {
        const resolver = typeAnalyzer.analyze(
          absoluteFilePaths.map((p) => (p.endsWith(".vue") ? p + ".ts" : p))
        );
        const components: Component[] = [];
        const stories: Story[] = [];
        for (const absoluteFilePath of absoluteFilePaths) {
          for (const componentOrStory of await extractVueComponents(
            reader,
            resolver,
            rootDir,
            absoluteFilePath
          )) {
            if ("extractProps" in componentOrStory) {
              components.push(componentOrStory);
            } else {
              stories.push(componentOrStory);
            }
          }
        }
        return {
          components,
          stories,
        };
      },
      viteConfig: (configuredPlugins) => {
        let rootDir: string;
        return {
          resolve: {
            alias: {
              vue: "vue/dist/vue.esm.js",
            },
          },
          plugins: [
            // TODO: Add vite-plugin-vue2 test app.
            ...configuredPlugins,
            configuredPlugins.find((plugin) => plugin.name.includes("vue2"))
              ? null
              : vue2Plugin(),
            configuredPlugins.find((plugin) => plugin.name.includes("jsx"))
              ? null
              : vue2JsxPlugin(),
            {
              name: "previewjs:import-vue-without-extension",
              configResolved(config) {
                rootDir = config.root;
              },
              async resolveId(source, importer) {
                const potentialVueFilePath = path.join(
                  importer && source.startsWith(".")
                    ? path.dirname(importer)
                    : rootDir,
                  source + ".vue"
                );
                if (await fs.pathExists(potentialVueFilePath)) {
                  return potentialVueFilePath;
                }
                return null;
              },
            },
            {
              name: "previewjs:disable-vue-hmr",
              async transform(code) {
                // HMR causes issues such as https://github.com/underfin/vite-plugin-vue2/issues/149.
                // It also prevents preview props from being refreshed.
                // For now, we disable it entirely.
                const matchHmr = /\/\* hot reload \*\/(.|\n)*\n}/m;
                return code.replace(matchHmr, "");
              },
            },
            {
              name: "previewjs:nuxt-style-resources",
              async config(config) {
                try {
                  const nuxtConfig = await loadNuxtConfig({
                    rootDir: config.root || process.cwd(),
                  });
                  const preprocessorOptions: Record<string, any> = {};
                  for (const [key, resources] of Object.entries(
                    nuxtConfig.styleResources || {}
                  )) {
                    const imports =
                      typeof resources === "string" ? [resources] : resources;
                    if (!Array.isArray(imports)) {
                      throw new Error(
                        `Unsupported styleResources: ${JSON.stringify(imports)}`
                      );
                    }
                    preprocessorOptions[key] = {
                      additionalData: imports
                        .map((p: string) => `@import "${p}";`)
                        .join("\n"),
                    };
                  }
                  return {
                    css: {
                      preprocessorOptions,
                    },
                  };
                } catch (e) {
                  logger.warn(e);
                  return {};
                }
              },
            },
            {
              name: "previewjs:optimize-deps",
              config: () => ({
                optimizeDeps: {
                  include: ["vue"],
                },
              }),
            },
          ],
        };
      },
      dispose: () => {
        typeAnalyzer.dispose();
      },
    };
  },
};

export default vue2FrameworkPlugin;
