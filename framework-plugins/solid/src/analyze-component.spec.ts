import { decodeComponentId } from "@previewjs/component-analyzer-api";
import type { FrameworkPlugin } from "@previewjs/core";
import {
  arrayType,
  EMPTY_OBJECT_TYPE,
  namedType,
  NODE_TYPE,
  NUMBER_TYPE,
  objectType,
  STRING_TYPE,
} from "@previewjs/type-analyzer";
import type { Reader, Writer } from "@previewjs/vfs";
import {
  createFileSystemReader,
  createMemoryReader,
  createStackedReader,
} from "@previewjs/vfs";
import path from "path";
import createLogger from "pino";
import prettyLogger from "pino-pretty";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import solidFrameworkPlugin from ".";

const ROOT_DIR_PATH = path.join(__dirname, "virtual");
const MAIN_FILE = path.join(ROOT_DIR_PATH, "App.tsx");

describe("analyzeSolidComponent", () => {
  let memoryReader: Reader & Writer;
  let frameworkPlugin: FrameworkPlugin;

  beforeEach(async () => {
    memoryReader = createMemoryReader();
    frameworkPlugin = await solidFrameworkPlugin.create({
      rootDir: ROOT_DIR_PATH,
      dependencies: {},
      reader: createStackedReader([
        memoryReader,
        createFileSystemReader({
          watch: false,
        }), // required for TypeScript libs, e.g. Promise
      ]),
      logger: createLogger(
        { level: "debug" },
        prettyLogger({ colorize: true })
      ),
    });
  });

  afterEach(() => {
    frameworkPlugin.dispose();
  });

  test("local component with named export", async () => {
    expect(
      await analyze(
        `
function A() {
  return <div>Hello, World!</div>;
}

export { A }
`,
        "A"
      )
    ).toEqual({
      props: EMPTY_OBJECT_TYPE,
      types: {},
    });
  });

  test("local component with named aliased export", async () => {
    expect(
      await analyze(
        `
function A() {
  return <div>Hello, World!</div>;
}

export { A as B }
`,
        "A"
      )
    ).toEqual({
      props: EMPTY_OBJECT_TYPE,
      types: {},
    });
  });

  test("local component with default export", async () => {
    expect(
      await analyze(
        `
export function A() {
  return <div>Hello, World!</div>;
}

export default A
`,
        "A"
      )
    ).toEqual({
      props: EMPTY_OBJECT_TYPE,
      types: {},
    });
  });

  test("declared function with empty props", async () => {
    expect(
      await analyze(
        `
export function A() {
  return <div>Hello, World!</div>;
}
`,
        "A"
      )
    ).toEqual({
      props: EMPTY_OBJECT_TYPE,
      types: {},
    });
  });

  test("declared function with typed props parameter", async () => {
    expect(
      await analyze(
        `
  export function A(props: { foo: string }) {
    return <div>Hello, World!</div>;
  };
  `,
        "A"
      )
    ).toEqual({
      props: objectType({
        foo: STRING_TYPE,
      }),
      types: {},
    });
  });

  test("declared function with type alias props parameter", async () => {
    expect(
      await analyze(
        `

  type SomeProps = {
    foo: string
  };

  export function A(props: SomeProps) {
    return <div>Hello, World!</div>;
  };
  `,
        "A"
      )
    ).toEqual({
      props: objectType({ foo: STRING_TYPE }),
      types: {
        "App.tsx:SomeProps": {
          type: objectType({ foo: STRING_TYPE }),
          parameters: {},
        },
      },
    });
  });

  test("constant function with empty props", async () => {
    expect(
      await analyze(
        `
export const A = () => {
  return <div>Hello, World!</div>;
}
`,
        "A"
      )
    ).toEqual({
      props: EMPTY_OBJECT_TYPE,
      types: {},
    });
  });

  test("constant function with typed props parameter", async () => {
    expect(
      await analyze(
        `
export const A = (props: { foo: string }) => {
  return <div>Hello, World!</div>;
};
`,
        "A"
      )
    ).toEqual({
      props: objectType({
        foo: STRING_TYPE,
      }),
      types: {},
    });
  });

  test("constant function with complex typed props parameter", async () => {
    expect(
      await analyze(
        `
export const A = (props: { currentTab: PanelTab, tabs: PanelTab[] }) => {
  return <div>Hello, World!</div>;
};

interface PanelTab {
  label: string;
  key: string;
  notificationCount: number;
  panel: JSX.Element;
}
`,
        "A"
      )
    ).toEqual({
      props: objectType({
        currentTab: namedType("App.tsx:PanelTab"),
        tabs: arrayType(namedType("App.tsx:PanelTab")),
      }),
      types: {
        ["App.tsx:PanelTab"]: {
          type: objectType({
            label: STRING_TYPE,
            key: STRING_TYPE,
            notificationCount: NUMBER_TYPE,
            panel: NODE_TYPE,
          }),
          parameters: {},
        },
      },
    });
  });

  test("constant function with Component type and no parameter", async () => {
    expect(
      await analyze(
        `
import { Component } from 'solid-js';

export const A: Component<{ foo: string }> = (props) => {
  return <div>Hello, World!</div>;
};
`,
        "A"
      )
    ).toEqual({
      props: objectType({
        foo: STRING_TYPE,
      }),
      types: {},
    });
  });

  test("constant function with Component type and a parameter", async () => {
    expect(
      await analyze(
        `
import { Component } from 'solid-js';

export const A: Component<{ foo: string }> = (props) => {
  return <div>Hello, {foo}!</div>;
};
`,
        "A"
      )
    ).toEqual({
      props: objectType({
        foo: STRING_TYPE,
      }),
      types: {},
    });
  });

  test("default exported function with no name", async () => {
    expect(
      await analyze(
        `
export default function() {
  return <div>Hello, World!</div>;
};
`,
        "default"
      )
    ).toEqual({
      props: objectType({}),
      types: {},
    });
  });

  test("default exported function with no parameter", async () => {
    expect(
      await analyze(
        `
export default function A() {
  return <div>Hello, World!</div>;
};
`,
        "default"
      )
    ).toEqual({
      props: objectType({}),
      types: {},
    });
  });

  test("default exported function with props", async () => {
    expect(
      await analyze(
        `
export default function A(props: { name: string }) {
  return <div>Hello, {name}!</div>;
};
`,
        "default"
      )
    ).toEqual({
      props: objectType({
        name: STRING_TYPE,
      }),
      types: {},
    });
  });

  test("Storybook args support", async () => {
    expect(
      await analyze(
        `
import Solid from 'solid-js';

export const A: Solid.Component<{ foo: string, bar: string }> = (props) => {
  return <div>{foo}</div>;
};
A.args = {
  foo: "Hello, World!"
};
`,
        "A"
      )
    ).toEqual({
      props: objectType({
        foo: STRING_TYPE,
        bar: STRING_TYPE,
      }),
      types: {},
    });
  });

  async function analyze(source: string, componentName: string) {
    memoryReader.updateFile(MAIN_FILE, source);
    const component = (
      await frameworkPlugin.detectComponents([MAIN_FILE])
    ).components.find(
      (c) => decodeComponentId(c.componentId).name === componentName
    );
    if (!component) {
      throw new Error(`Component ${componentName} not found`);
    }
    return component.extractProps();
  }
});
