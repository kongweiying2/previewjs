import {
  EMPTY_OBJECT,
  number,
  object,
  parseSerializableValue,
  string,
  unknown,
} from "@previewjs/serializable-values";
import type { TypeAnalyzer } from "@previewjs/type-analyzer";
import {
  NODE_TYPE,
  createTypeAnalyzer,
  functionType,
} from "@previewjs/type-analyzer";
import type { Reader, Writer } from "@previewjs/vfs";
import {
  createFileSystemReader,
  createMemoryReader,
  createStackedReader,
} from "@previewjs/vfs";
import path from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { extractArgs } from "./extract-args";

describe("extractArgs", () => {
  let memoryReader: Reader & Writer;
  let typeAnalyzer: TypeAnalyzer;

  beforeEach(() => {
    memoryReader = createMemoryReader();
    typeAnalyzer = createTypeAnalyzer({
      rootDir: path.join(__dirname, "virtual"),
      reader: createStackedReader([
        memoryReader,
        createFileSystemReader({
          watch: false,
        }), // required for TypeScript libs, e.g. Promise
      ]),
      specialTypes: {
        Component: NODE_TYPE,
        ComponentType: functionType(NODE_TYPE),
      },
    });
  });

  afterEach(() => {
    typeAnalyzer.dispose();
  });

  test("no args", async () => {
    expect(
      await extractArgsFromSource(`
      export const Foo = () => {};
    `)
    ).toEqual({});
  });

  test("empty args", async () => {
    expect(
      await extractArgsFromSource(`
      export const Foo = () => {};
      Foo.args = {};
    `)
    ).toEqual({
      Foo: EMPTY_OBJECT,
    });
  });

  test("explicit args", async () => {
    expect(
      await extractArgsFromSource(`
      export const Foo = () => {};
      Foo.args = {
        name: "foo",
        age: 31
      };
    `)
    ).toEqual({
      Foo: object([
        {
          kind: "key",
          key: string("name"),
          value: string("foo"),
        },
        {
          kind: "key",
          key: string("age"),
          value: number(31),
        },
      ]),
    });
  });

  test("spread args", async () => {
    expect(
      await extractArgsFromSource(`
      export const Bar = () = {};
      Bar.args = {
        name: "foo",
        age: 31
      }

      export const Foo = () => {};
      Foo.args = {
        ...Bar.args,
        age: 35,
        gender: "neutral"
      };
    `)
    ).toEqual({
      Bar: object([
        {
          kind: "key",
          key: string("name"),
          value: string("foo"),
        },
        {
          kind: "key",
          key: string("age"),
          value: number(31),
        },
      ]),
      Foo: object([
        {
          kind: "spread",
          value: unknown("Bar.args"),
        },
        {
          kind: "key",
          key: string("age"),
          value: number(35),
        },
        {
          kind: "key",
          key: string("gender"),
          value: string("neutral"),
        },
      ]),
    });
  });

  async function extractArgsFromSource(source: string) {
    const rootDir = path.join(__dirname, "virtual");
    const mainSourceFilePath = path.join(rootDir, "main.ts");
    memoryReader.updateFile(mainSourceFilePath, source);
    const resolver = typeAnalyzer.analyze([mainSourceFilePath]);
    const sourceFile = resolver.sourceFile(mainSourceFilePath);
    if (!sourceFile) {
      throw new Error(`No source file found`);
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(extractArgs(sourceFile)).map(async ([name, node]) => {
          return [name, await parseSerializableValue(node)];
        })
      )
    );
  }
});
