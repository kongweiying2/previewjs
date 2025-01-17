import type { Reader } from "@previewjs/vfs";
import fs from "fs-extra";
import { createRequire } from "module";
import path from "path";
import type { Logger } from "pino";
import type { PackageDependencies } from "./dependencies";
import type { FrameworkPluginFactory } from "./framework";

const require = createRequire(import.meta.url);

export async function setupFrameworkPlugin({
  rootDir,
  frameworkPlugins,
  reader,
  logger,
}: {
  rootDir: string;
  frameworkPlugins: FrameworkPluginFactory[];
  reader: Reader;
  logger: Logger;
}) {
  const dependencies = await extractPackageDependencies(logger, rootDir);
  for (const candidate of frameworkPlugins) {
    if (await candidate.isCompatible(dependencies)) {
      return candidate.create({
        rootDir,
        reader,
        logger,
        dependencies,
      });
    }
  }
  return null;
}

async function extractPackageDependencies(
  logger: Logger,
  rootDir: string
): Promise<PackageDependencies> {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return {};
  }
  const { dependencies, devDependencies, peerDependencies } = JSON.parse(
    await fs.readFile(packageJsonPath, "utf8")
  );
  const allDependencies = {
    ...dependencies,
    ...devDependencies,
    ...peerDependencies,
  };
  return Object.fromEntries(
    Object.entries(allDependencies).map(
      ([name, version]): [string, PackageDependencies[string]] => {
        let majorVersion: number;
        if (typeof version !== "string") {
          majorVersion = 0;
        } else if (version.startsWith("^") || version.startsWith("~")) {
          majorVersion = parseInt(version.slice(1));
        } else {
          majorVersion = parseInt(version);
        }
        const readInstalledVersion = async () => {
          try {
            const moduleEntryPath = findModuleEntryPath(name, rootDir);
            let packagePath = moduleEntryPath;
            let packageJsonPath: string | null = null;
            while (packagePath !== path.dirname(packagePath)) {
              const candidatePackageJsonPath = path.join(
                packagePath,
                "package.json"
              );
              if (fs.existsSync(candidatePackageJsonPath)) {
                packageJsonPath = candidatePackageJsonPath;
                break;
              }
              packagePath = path.dirname(packagePath);
            }
            if (!packageJsonPath) {
              throw new Error(
                `No package.json path found from: ${moduleEntryPath}`
              );
            }
            const packageInfo = JSON.parse(
              await fs.readFile(packageJsonPath, "utf8")
            );
            const version = packageInfo["version"];
            if (!version || typeof version !== "string") {
              throw new Error(
                `Invalid version found for package: ${packageJsonPath}`
              );
            }
            return version;
          } catch (e) {
            logger.error(
              `Unable to read installed version of package: ${name}`,
              e
            );
            return null;
          }
        };
        return [name, { majorVersion, readInstalledVersion }];
      }
    )
  );
}

function findModuleEntryPath(name: string, rootDir: string): string {
  try {
    return require.resolve(name, {
      paths: [rootDir],
    });
  } catch (e: any) {
    if (e.code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      // When this occurs, the error conveniently includes the package path we're precisely trying to extract.
      //
      // Note: this could break in future Node versions.
      //
      // Example:
      // Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: No "exports" main defined in .../nuxt-app/node_modules/nuxt/package.json
      const potentialMatch = (e.message as string).match(
        /No "exports" main defined in (.*)(\/|\\)package\.json/
      );
      if (potentialMatch) {
        return potentialMatch[1]!;
      }
    }
    throw e;
  }
}
