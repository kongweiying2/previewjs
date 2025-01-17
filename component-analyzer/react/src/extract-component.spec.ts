import type { ComponentAnalyzer } from "@previewjs/component-analyzer-api";
import { object, string, TRUE } from "@previewjs/serializable-values";
import { objectType, STRING_TYPE } from "@previewjs/type-analyzer";
import type { Reader, Writer } from "@previewjs/vfs";
import {
  createFileSystemReader,
  createMemoryReader,
  createStackedReader,
} from "@previewjs/vfs";
import path from "path";
import createLogger from "pino";
import prettyLogger from "pino-pretty";
import url from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractReactComponents } from "./extract-component.js";
import { createComponentAnalyzer } from "./index.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = path.join(__dirname, "virtual");
const APP_TSX = path.join(ROOT_DIR, "App.tsx");
const APP_STORIES_TSX = path.join(ROOT_DIR, "App.stories.tsx");

describe("extractReactComponents", () => {
  const logger = createLogger(
    { level: "debug" },
    prettyLogger({ colorize: true })
  );

  let memoryReader: Reader & Writer;
  let analyzer: ComponentAnalyzer;

  beforeEach(async () => {
    memoryReader = createMemoryReader();
    memoryReader.updateFile(
      APP_TSX,
      "export default ({ label }: { label: string }) => <div>{label}</div>;"
    );
    analyzer = createComponentAnalyzer({
      rootDir: ROOT_DIR,
      reader: createStackedReader([
        memoryReader,
        createFileSystemReader({
          watch: false,
        }), // required for TypeScript libs, e.g. Promise
      ]),
      logger,
    });
  });

  afterEach(() => {
    analyzer.dispose();
  });

  it("detects expected components", async () => {
    memoryReader.updateFile(
      APP_TSX,
      `
import React, { Component, PureComponent } from "react";

function wrapComponent<P>(c: React.ComponentType<P>): React.ComponentType<P> {
  return c;
}

function DeclaredFunction() {
  return <div>Hello, World!</div>;
}

const ConstantFunction = () => <div>Hello, World!</div>;

// Note: this isn't detected as of October 2021.
const HocComponent = wrapComponent(() => <div>Hello, World!</div>);

class ClassComponent1 extends React.Component {}

class ClassComponent2 extends Component {}

const ForwardRef = React.forwardRef((props, ref) => <ConstantFunction {...props} />);

const NextComponent: NextPage = () => {
  return <div>Hello, World!</div>;
};

export class Pure extends PureComponent<{foo: string}> {}

export class BaseClass<T> {}

export class NotComponentClass extends BaseClass<SomeProps> {}

export const NotObjectProps = (props: () => void) => {
  return <div>Hello, World!</div>;
};

export const MissingType = (props) => {
  return <div>Hello, World!</div>;
};

export const NotComponent = () => {
  // This isn't a component.
};

export const NotComponentEither = () => {
  return "Hello";
};

export const AlsoNotAStory = {
  args: {}
};
`
    );
    expect(await extract(APP_TSX)).toMatchObject([
      {
        componentId: "App.tsx:DeclaredFunction",
        exported: false,
      },
      {
        componentId: "App.tsx:ConstantFunction",
        exported: false,
      },
      // Note: this isn't detected as of October 2021.
      // {
      //   name: "HocComponent",
      //   exported: false,
      //   offsets: expect.anything(),
      // },
      {
        componentId: "App.tsx:ClassComponent1",
        exported: false,
      },
      {
        componentId: "App.tsx:ClassComponent2",
        exported: false,
      },
      {
        componentId: "App.tsx:ForwardRef",
        exported: false,
      },
      {
        componentId: "App.tsx:NextComponent",
        exported: false,
      },
      {
        componentId: "App.tsx:Pure",
        exported: true,
      },
      {
        componentId: "App.tsx:NotObjectProps",
        exported: true,
      },
      {
        componentId: "App.tsx:MissingType",
        exported: true,
      },
    ]);
  });

  it("detects components without any React import", async () => {
    memoryReader.updateFile(
      APP_TSX,
      `
function DeclaredFunction() {
  return <div>Hello, World!</div>;
}

const ConstantFunction = () => <div>Hello, World!</div>;
`
    );
    expect(await extract(APP_TSX)).toMatchObject([
      {
        componentId: "App.tsx:DeclaredFunction",
        exported: false,
      },
      {
        componentId: "App.tsx:ConstantFunction",
        exported: false,
      },
    ]);
  });

  it("ignores default export of identifier", async () => {
    memoryReader.updateFile(
      APP_TSX,
      `
const A = () => {
  return <div>Hello, World!</div>;
};

export default A;
`
    );
    expect(await extract(APP_TSX)).toMatchObject([
      {
        componentId: "App.tsx:A",
        exported: true,
      },
    ]);
  });

  it("detects default export component (arrow function)", async () => {
    memoryReader.updateFile(
      APP_TSX,
      `
export default () => {
  return <div>Hello, World!</div>;
}
`
    );
    expect(await extract(APP_TSX)).toMatchObject([
      {
        componentId: "App.tsx:default",
        exported: true,
      },
    ]);
  });

  it("detects default export component (named function)", async () => {
    memoryReader.updateFile(
      APP_TSX,
      `
export default function test(){
  return <div>Hello, World!</div>;
}
`
    );
    expect(await extract(APP_TSX)).toMatchObject([
      {
        componentId: "App.tsx:test",
        exported: true,
      },
    ]);
  });

  it("detects default export component (anonymous function)", async () => {
    memoryReader.updateFile(
      APP_TSX,
      `
export default function(){
  return <div>Hello, World!</div>;
}
`
    );
    expect(await extract(APP_TSX)).toMatchObject([
      {
        componentId: "App.tsx:default",
        exported: true,
      },
    ]);
  });

  it("does not detect default export non-component", async () => {
    memoryReader.updateFile(
      APP_TSX,
      `
export default () => {
  return "foo";
}
`
    );
    expect(await extract(APP_TSX)).toMatchObject([]);
  });

  it("detects CSF1 stories (exported with component)", async () => {
    memoryReader.updateFile(
      APP_STORIES_TSX,
      `
import Button from "./App";

export default {
  component: Button
}

export const Primary = () => <Button primary label="Button" />;

export const NotStory = (props) => <Button {...props} />;
`
    );

    const extractedStories = await extract(APP_STORIES_TSX);
    expect(extractedStories).toMatchObject([
      {
        componentId: "App.stories.tsx:Primary",
        args: null,
        associatedComponent: {
          componentId: "App.tsx:default",
        },
      },
      {
        componentId: "App.stories.tsx:NotStory",
        exported: true,
      },
    ]);
    const story = extractedStories[0];
    if (
      !story ||
      !("associatedComponent" in story) ||
      !story.associatedComponent
    ) {
      throw new Error();
    }
    expect(await story.associatedComponent.extractProps()).toEqual({
      props: objectType({
        label: STRING_TYPE,
      }),
      types: {},
    });
  });

  it("detects CSF1 stories (exported with title)", async () => {
    memoryReader.updateFile(
      APP_STORIES_TSX,
      `
import Button from "./App";

export default {
  title: "Stories"
}

export const Primary = () => <Button primary label="Button" />;

export const NotStory = (props) => <Button {...props} />;
`
    );

    const extractedStories = await extract(APP_STORIES_TSX);
    expect(extractedStories).toMatchObject([
      {
        componentId: "App.stories.tsx:Primary",
        args: null,
        associatedComponent: null,
      },
      {
        componentId: "App.stories.tsx:NotStory",
        exported: true,
      },
    ]);
  });

  it("detects CSF2 stories (exported with component)", async () => {
    memoryReader.updateFile(
      APP_STORIES_TSX,
      `
import Button from "./App";

export default {
  component: Button
}

const Template = (args) => <Button {...args} />;

export const Primary = Template.bind({});
Primary.args = {
   primary: true,
   label: 'Button',
};
`
    );

    const extractedStories = await extract(APP_STORIES_TSX);
    expect(extractedStories).toMatchObject([
      {
        componentId: "App.stories.tsx:Template",
        exported: false,
      },
      {
        componentId: "App.stories.tsx:Primary",
        args: {
          value: object([
            {
              kind: "key",
              key: string("primary"),
              value: TRUE,
            },
            {
              kind: "key",
              key: string("label"),
              value: string("Button"),
            },
          ]),
        },
        associatedComponent: {
          componentId: "App.tsx:default",
        },
      },
    ]);
    const story = extractedStories[1];
    if (
      !story ||
      !("associatedComponent" in story) ||
      !story.associatedComponent
    ) {
      throw new Error();
    }
    expect(await story.associatedComponent.extractProps()).toEqual({
      props: objectType({
        label: STRING_TYPE,
      }),
      types: {},
    });
  });

  it("detects CSF2 stories (exported with title)", async () => {
    memoryReader.updateFile(
      APP_STORIES_TSX,
      `
import Button from "./App";

export default {
  title: "Stories"
}

const Template = (args) => <Button {...args} />;

export const Primary = Template.bind({});
Primary.args = {
   primary: true,
   label: 'Button',
};
`
    );

    const extractedStories = await extract(APP_STORIES_TSX);
    expect(extractedStories).toMatchObject([
      {
        componentId: "App.stories.tsx:Template",
        exported: false,
      },
      {
        componentId: "App.stories.tsx:Primary",
        args: {
          value: object([
            {
              kind: "key",
              key: string("primary"),
              value: TRUE,
            },
            {
              kind: "key",
              key: string("label"),
              value: string("Button"),
            },
          ]),
        },
        associatedComponent: null,
      },
    ]);
  });

  it("detects CSF3 stories (exported with component)", async () => {
    memoryReader.updateFile(
      APP_STORIES_TSX,
      `
import Button from "./App";

export default {
  component: Button
}

export const Example = {
  args: {
    label: "Hello, World!"
  }
}

export const NoArgs = {}

export function NotStory() {}
`
    );

    const extractedStories = await extract(APP_STORIES_TSX);
    expect(extractedStories).toMatchObject([
      {
        componentId: "App.stories.tsx:Example",
        args: {
          value: object([
            {
              kind: "key",
              key: string("label"),
              value: string("Hello, World!"),
            },
          ]),
        },
        associatedComponent: {
          componentId: "App.tsx:default",
        },
      },
      {
        componentId: "App.stories.tsx:NoArgs",
        args: null,
        associatedComponent: {
          componentId: "App.tsx:default",
        },
      },
    ]);
    const story = extractedStories[0];
    if (
      !story ||
      !("associatedComponent" in story) ||
      !story.associatedComponent
    ) {
      throw new Error();
    }
    expect(await story.associatedComponent.extractProps()).toEqual({
      props: objectType({
        label: STRING_TYPE,
      }),
      types: {},
    });
  });

  it("detects CSF3 stories (exported with title)", async () => {
    memoryReader.updateFile(
      APP_STORIES_TSX,
      `
import Button from "./App";

export default {
  title: "Stories"
}

export const Example = {
  args: {
    label: "Hello, World!"
  }
}

export const NoArgs = {}

export function NotStory() {}
`
    );

    const extractedStories = await extract(APP_STORIES_TSX);
    expect(extractedStories).toMatchObject([
      {
        componentId: "App.stories.tsx:Example",
        args: {
          value: object([
            {
              kind: "key",
              key: string("label"),
              value: string("Hello, World!"),
            },
          ]),
        },
        associatedComponent: null,
      },
      {
        componentId: "App.stories.tsx:NoArgs",
        args: null,
        associatedComponent: null,
      },
    ]);
  });

  function extract(absoluteFilePath: string) {
    return extractReactComponents(
      logger,
      analyzer.typeAnalyzer.analyze([absoluteFilePath]),
      ROOT_DIR,
      absoluteFilePath
    );
  }
});
