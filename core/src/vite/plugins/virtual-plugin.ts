import type { Reader } from "@previewjs/vfs";
import fs from "fs-extra";
import path from "path";
import type { Logger } from "pino";
import type * as vite from "vite";
import { transformWithEsbuild } from "vite";

const VIRTUAL_PREFIX = `/@previewjs-virtual:`;

const jsExtensions = new Set([".js", ".jsx", ".ts", ".tsx"]);

export function virtualPlugin(options: {
  logger: Logger;
  reader: Reader;
  rootDir: string;
  allowedAbsolutePaths: string[];
  moduleGraph: () => vite.ModuleGraph | null;
  esbuildOptions: vite.ESBuildOptions;
}): vite.Plugin {
  const { reader, rootDir } = options;
  return {
    name: "previewjs:virtual-fs",
    resolveId: async function (id, importer) {
      const virtualImporter = importer?.startsWith(VIRTUAL_PREFIX) || false;
      if (id.indexOf(`/node_modules/`) !== -1) {
        return null;
      }
      if (id.startsWith(VIRTUAL_PREFIX)) {
        id = id.slice(VIRTUAL_PREFIX.length);
      }
      // Remove query params.
      id = id.split("?", 2)[0]!;
      const extension = path.extname(id);
      let absoluteId;
      if (path.isAbsolute(id)) {
        absoluteId = id;
      } else {
        if (!importer) {
          return null;
        }
        if (virtualImporter) {
          importer = importer.slice(VIRTUAL_PREFIX.length);
        }
        if (extension && !jsExtensions.has(extension) && extension !== ".svg") {
          // Virtual files mess with CSS processors like postcss.
          return path.join(path.dirname(importer), id);
        }
        absoluteId = path.join(path.dirname(importer), id);
      }
      const resolved = await resolveAbsoluteModuleId(absoluteId);
      if (resolved) {
        const [absoluteFilePath] = resolved;
        if ((await fs.pathExists(absoluteFilePath)) && !virtualImporter) {
          // This file doesn't need to be virtual.
          return null;
        }
        if (!absoluteId.endsWith(extension)) {
          absoluteId += extension;
        }
        const resolvedId =
          VIRTUAL_PREFIX + absoluteFilePath.replace(/\\/g, "/");
        return resolvedId;
      }
      return null;
    },
    load: async function (id) {
      if (id.indexOf(`/node_modules/`) !== -1) {
        return null;
      }
      if (id.startsWith(VIRTUAL_PREFIX)) {
        id = id.slice(VIRTUAL_PREFIX.length);
      }
      const resolved = await resolveAbsoluteModuleId(id);
      if (!resolved) {
        // This could be a file handled by another plugin, e.g. CSS modules.
        return null;
      }
      const [absoluteFilePath, entry] = resolved;
      let isAllowed = false;
      for (const allowedAbsolutePath of options.allowedAbsolutePaths) {
        const relativePath = path.relative(
          allowedAbsolutePath,
          absoluteFilePath
        );
        if (
          relativePath &&
          !relativePath.startsWith("..") &&
          !path.isAbsolute(relativePath)
        ) {
          // The path is a descendant of an allowed path, so we're OK.
          isAllowed = true;
          break;
        }
      }
      if (!isAllowed) {
        options.logger.error(
          `Attempted access to ${absoluteFilePath} which is outside of allowed directories. See https://previewjs.com/docs/config and https://vitejs.dev/config/server-options.html#server-fs-allow for more information.`
        );
        return null;
      }
      if (entry.kind !== "file") {
        options.logger.error(`Unable to read file from ${absoluteFilePath}`);
        return null;
      }
      const source = await entry.read();
      const fileExtension = path.extname(absoluteFilePath);
      if (!jsExtensions.has(fileExtension)) {
        return source;
      }
      const moduleExtension = path.extname(id);
      return {
        code:
          // We run an esbuild transform for .js or no extension
          // because it may include JSX. Otherwise, let plugins
          // decide whether to use esbuild or not.
          !id.includes("__previewjs_internal__") &&
          (moduleExtension === "" || moduleExtension === ".js")
            ? (
                await transformWithEsbuild(source, absoluteFilePath, {
                  loader: absoluteFilePath.endsWith(".ts") ? "ts" : "tsx",
                  format: "esm",
                  target: "es2020",
                  sourcefile: path.relative(rootDir, absoluteFilePath),
                  ...options.esbuildOptions,
                })
              ).code
            : source,
      };
    },
    transform: (code, id) => {
      if (!id.startsWith(VIRTUAL_PREFIX)) {
        return null;
      }
      // Disable source mapping for virtual files.
      // Otherwise, we'd see warnings about missing /@previewjs-virtual/... files.
      return {
        code,
        map: {
          mappings: "",
          names: [],
          sources: [],
          version: 3,
        },
      };
    },
    handleHotUpdate: async function (context) {
      const moduleGraph = options.moduleGraph();
      if (!moduleGraph) {
        return;
      }
      const filePath = path.relative(rootDir, context.file);
      const absoluteFilePath = path.join(rootDir, filePath);
      const entry = await reader.read(absoluteFilePath);
      if (!entry || entry.kind !== "file") {
        return;
      }
      // Note: backslash handling is Windows-specific.
      const virtualModuleId =
        VIRTUAL_PREFIX + absoluteFilePath.replace(/\\/g, "/");
      const node = moduleGraph.getModuleById(virtualModuleId);
      return node && [node];
    },
  };

  async function resolveAbsoluteModuleId(id: string) {
    return (
      (await resolveBaseFilePath(id)) ||
      (await resolveBaseFilePath(path.join(rootDir, id)))
    );
  }

  async function resolveBaseFilePath(baseFilePath: string) {
    for (const suffix of [
      "",
      ...jsExtensions,
      ...[...jsExtensions].map((extension) => `${path.sep}index${extension}`),
    ]) {
      const absoluteFilePath = `${baseFilePath}${suffix}`;
      const entry = await reader.read(absoluteFilePath);
      if (entry?.kind === "file") {
        return [absoluteFilePath, entry] as const;
      }
    }
    return null;
  }
}
