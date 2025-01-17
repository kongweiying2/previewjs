import {
  generateComponentId,
  type ComponentProps,
  type Story,
} from "@previewjs/component-analyzer-api";
import { parseSerializableValue } from "@previewjs/serializable-values";
import type { TypeResolver } from "@previewjs/type-analyzer";
import path from "path";
import ts from "typescript";
import { extractStoriesInfo } from "./extract-stories-info";
import { resolveComponentId } from "./resolve-component";

export async function extractCsf3Stories(
  rootDir: string,
  resolver: TypeResolver,
  sourceFile: ts.SourceFile,
  extractProps: (componentId: string) => Promise<ComponentProps>
): Promise<Story[]> {
  const storiesInfo = extractStoriesInfo(sourceFile);
  if (!storiesInfo) {
    return [];
  }

  const stories: Story[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }

    if (
      !statement.modifiers?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }
      if (
        !declaration.initializer ||
        !ts.isObjectLiteralExpression(declaration.initializer)
      ) {
        continue;
      }
      const name = declaration.name.text;
      let storyComponent: ts.Expression | undefined;
      let args: ts.Expression | undefined;
      for (const property of declaration.initializer.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name)
        ) {
          const propertyName = property.name.text;
          if (propertyName === "component") {
            storyComponent = property.initializer;
          } else if (propertyName === "args") {
            args = property.initializer;
          }
        }
      }

      const associatedComponentId = resolveComponentId(
        rootDir,
        resolver.checker,
        storyComponent || storiesInfo.component || null
      );
      stories.push({
        componentId: generateComponentId({
          filePath: path.relative(rootDir, sourceFile.fileName),
          name,
        }),
        offsets: [statement.getStart(), statement.getEnd()],
        args: args
          ? {
              start: args.getStart(),
              end: args.getEnd(),
              value: await parseSerializableValue(args),
            }
          : null,
        associatedComponent: associatedComponentId
          ? {
              componentId: associatedComponentId,
              extractProps: () => extractProps(associatedComponentId),
            }
          : null,
      });
    }
  }

  return stories;
}
