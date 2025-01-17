import { RPCs } from "@previewjs/api";
import { decodeComponentId } from "@previewjs/component-analyzer-api";
import { exclusivePromiseRunner } from "exclusive-promises";
import fs from "fs-extra";
import path from "path";
import type { Logger } from "pino";
import type { FrameworkPlugin, Workspace } from ".";
import { getCacheDir } from "./caching";
import { findFiles } from "./find-files";

export const FILES_REQUIRING_REDETECTION = new Set([
  "jsconfig.json",
  "tsconfig.json",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

type CachedProjectComponents = {
  detectionStartTimestamp: number;
  components: RPCs.Component[];
  stories: RPCs.Story[];
};

// Prevent concurrent running of detectComponents()
// to avoid corrupting the cache and optimise for cache hits.
const oneAtATime = exclusivePromiseRunner();

export function detectComponents(
  logger: Logger,
  workspace: Workspace,
  frameworkPlugin: FrameworkPlugin,
  options: {
    filePaths?: string[];
    forceRefresh?: boolean;
  } = {}
): Promise<RPCs.DetectComponentsResponse> {
  return oneAtATime(async () => {
    logger.debug(
      `Detecting components with options: ${JSON.stringify(options)}`
    );
    const detectionStartTimestamp = Date.now();
    const cacheFilePath = path.join(
      getCacheDir(workspace.rootDir),
      "components.json"
    );
    const absoluteFilePaths = await (async () => {
      if (options.filePaths) {
        return options.filePaths.map((filePath) =>
          path.join(workspace.rootDir, filePath)
        );
      } else {
        logger.debug(`Finding component files from root: ${workspace.rootDir}`);
        const filePaths = await findFiles(
          workspace.rootDir,
          "**/*.@(js|jsx|ts|tsx|svelte|vue)"
        );
        logger.debug(`Found ${filePaths.length} component files`);
        return filePaths;
      }
    })();
    const filePathsSet = new Set(
      absoluteFilePaths.map((absoluteFilePath) =>
        path.relative(workspace.rootDir, absoluteFilePath).replace(/\\/g, "/")
      )
    );
    let existingCache: CachedProjectComponents = {
      detectionStartTimestamp: 0,
      components: [],
      stories: [],
    };
    if (fs.existsSync(cacheFilePath)) {
      try {
        existingCache = JSON.parse(
          fs.readFileSync(cacheFilePath, "utf8")
        ) as CachedProjectComponents;
      } catch (e) {
        logger.warn(`Unable to parse JSON from cache at ${cacheFilePath}`);
      }
    }
    if (
      existingCache.detectionStartTimestamp <
      (await detectionMinimalTimestamp(workspace.rootDir))
    ) {
      // Cache cannot be used as it was generated before detection-impacted files were updated.
      existingCache = {
        detectionStartTimestamp: 0,
        components: [],
        stories: [],
      };
    }
    const changedAbsoluteFilePaths = absoluteFilePaths.filter(
      (absoluteFilePath) => {
        const entry = workspace.reader.readSync(absoluteFilePath);
        return (
          entry?.kind === "file" &&
          (options.forceRefresh ||
            entry.lastModifiedMillis() >= existingCache.detectionStartTimestamp)
        );
      }
    );
    const refreshedFilePaths = new Set(
      changedAbsoluteFilePaths.map((absoluteFilePath) =>
        path.relative(workspace.rootDir, absoluteFilePath).replace(/\\/g, "/")
      )
    );
    const shouldRecycle = ({ componentId }: { componentId: string }) => {
      const filePath = decodeComponentId(componentId).filePath;
      return filePathsSet.has(filePath) && !refreshedFilePaths.has(filePath);
    };
    const recycledComponents = existingCache.components.filter(shouldRecycle);
    const recycledStories = existingCache.stories.filter(shouldRecycle);
    const { components: refreshedComponents, stories: refreshedStories } =
      await detectComponentsCore(
        logger,
        workspace,
        frameworkPlugin,
        changedAbsoluteFilePaths
      );
    const components = [...recycledComponents, ...refreshedComponents];
    const stories = [...recycledStories, ...refreshedStories];
    if (!options.filePaths) {
      await fs.mkdirp(path.dirname(cacheFilePath));
      const updatedCache: CachedProjectComponents = {
        detectionStartTimestamp,
        components,
        stories,
      };
      await fs.writeFile(cacheFilePath, JSON.stringify(updatedCache));
    }
    return { components, stories };
  });
}

async function detectComponentsCore(
  logger: Logger,
  workspace: Workspace,
  frameworkPlugin: FrameworkPlugin,
  changedAbsoluteFilePaths: string[]
): Promise<{
  components: RPCs.Component[];
  stories: RPCs.Story[];
}> {
  const components: RPCs.Component[] = [];
  const stories: RPCs.Story[] = [];
  if (changedAbsoluteFilePaths.length === 0) {
    return { components, stories };
  }
  logger.debug(
    `Running component detection with file paths:\n- ${changedAbsoluteFilePaths
      .map((absoluteFilePath) =>
        path.relative(workspace.rootDir, absoluteFilePath)
      )
      .join("\n- ")}`
  );
  const found = await frameworkPlugin.detectComponents(
    changedAbsoluteFilePaths
  );
  logger.debug(`Done running component detection`);
  for (const component of found.components) {
    const [start, end] = component.offsets;
    components.push({
      componentId: component.componentId,
      start,
      end,
      exported: component.exported,
    });
  }
  for (const story of found.stories) {
    const [start, end] = story.offsets;
    stories.push({
      componentId: story.componentId,
      start,
      end,
      args: story.args,
      associatedComponentId: story.associatedComponent?.componentId || null,
    });
  }
  return { components, stories };
}

async function detectionMinimalTimestamp(rootDir: string) {
  const nodeModulesPath = path.join(rootDir, "node_modules");
  let lastModifiedMillis = 0;
  if (await fs.pathExists(nodeModulesPath)) {
    // Find the latest subdirectory or symlink (important for pnpm).
    for (const subdirectory of await fs.readdir(nodeModulesPath)) {
      const subdirectoryPath = path.join(nodeModulesPath, subdirectory);
      const stat = await fs.lstat(subdirectoryPath);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        lastModifiedMillis = Math.max(lastModifiedMillis, stat.mtimeMs);
      }
    }
  }
  for (const f of FILES_REQUIRING_REDETECTION) {
    const filePath = path.join(rootDir, f);
    if (await fs.pathExists(filePath)) {
      const stat = await fs.stat(filePath);
      lastModifiedMillis = Math.max(lastModifiedMillis, stat.mtimeMs);
    }
  }
  return lastModifiedMillis;
}
